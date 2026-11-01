import type { QueryAdapter } from "@flightdeckhq/lifecycle-queries";
import { describe, expect, it, vi } from "vitest";
import {
  type EvidenceCache,
  type ExecuteOptions,
  executeInvestigation,
  InvestigationError,
  type InvestigationRequest,
  parseEvidencePack,
  planInvestigation,
  serializeEvidencePack,
} from "../src/index.js";
import { adapterFor, allow, catalogFor, DOMAINS, instrument, NOW, requestFor } from "./fixtures.js";

const deploy = DOMAINS.deploy;
const options = (overrides: Partial<ExecuteOptions> = {}): ExecuteOptions => ({
  catalog: catalogFor(deploy),
  adapter: adapterFor(deploy),
  authorize: allow(deploy.appId),
  now: NOW,
  ...overrides,
});
async function code(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(InvestigationError);
    return (error as InvestigationError).code;
  }
  throw new Error("expected rejection");
}
function memoryCache() {
  const map = new Map<string, unknown>();
  const store: EvidenceCache & { map: typeof map } = {
    map,
    get: vi.fn((key: string) => structuredClone(map.get(key))),
    set: vi.fn((key: string, value: unknown) => {
      map.set(key, structuredClone(value));
    }),
  };
  return store;
}

describe("authorization gate", () => {
  const denials: [string, Partial<ExecuteOptions>][] = [
    ["explicit deny", { authorize: () => ({ allowed: false }) }],
    ["throwing authorizer", { authorize: () => Promise.reject(new Error("grant store down")) }],
    ["other app", { authorize: () => ({ allowed: true, appId: "talent-demo", scopeKey: "s1" }) }],
    [
      "truthy non-boolean",
      { authorize: () => ({ allowed: "yes", appId: deploy.appId, scopeKey: "s1" }) as never },
    ],
    [
      "missing scope key",
      { authorize: () => ({ allowed: true, appId: deploy.appId, scopeKey: "" }) },
    ],
    ["undefined decision", { authorize: () => undefined as never }],
    ["no authorizer", { authorize: undefined as never }],
  ];
  it.each(denials)("fails closed with zero queries: %s", async (_, override) => {
    const { adapter, stats } = instrument(adapterFor(deploy));
    expect(
      await code(
        executeInvestigation(
          requestFor(deploy, "process-health"),
          options({ adapter, ...override }),
        ),
      ),
    ).toBe("forbidden");
    expect(stats.calls).toBe(0);
  });

  it("authorizes before validating the rest of the request", async () => {
    const { adapter, stats } = instrument(adapterFor(deploy));
    const invalid = requestFor(deploy, "process-health", { stages: ["not-a-stage"] });
    expect(
      await code(
        executeInvestigation(invalid, options({ adapter, authorize: () => ({ allowed: false }) })),
      ),
    ).toBe("forbidden");
    expect(stats.calls).toBe(0);
  });

  it("asks for process:read on exactly the requested app and recipe", async () => {
    const authorize = vi.fn(allow(deploy.appId));
    await executeInvestigation(requestFor(deploy, "bottleneck-triage"), options({ authorize }));
    expect(authorize).toHaveBeenCalledWith({
      appId: deploy.appId,
      definitionId: deploy.definitionId,
      capability: "process:read",
      recipe: "bottleneck-triage",
    });
  });

  it("stops and fails closed when the adapter reports a denial mid-run", async () => {
    const { adapter, stats } = instrument(adapterFor(deploy), {
      fail: (query) =>
        query.metric.kind === "stage-dwell"
          ? Object.assign(new Error("revoked"), { code: "forbidden" })
          : null,
    });
    expect(
      await code(
        executeInvestigation(
          requestFor(deploy, "bottleneck-triage"),
          options({ adapter, now: NOW }),
        ),
      ),
    ).toBe("forbidden");
    expect(stats.calls).toBeLessThan(6);
  });

  it("rejects a plan that changed after review", async () => {
    const reviewed = planInvestigation(
      requestFor(deploy, "bottleneck-triage"),
      catalogFor(deploy),
      { now: NOW },
    );
    await expect(
      executeInvestigation(
        requestFor(deploy, "bottleneck-triage"),
        options({ expectedPlanDigest: reviewed.digest }),
      ),
    ).resolves.toBeTruthy();
    expect(
      await code(
        executeInvestigation(
          requestFor(deploy, "bottleneck-triage", { stages: ["review"] }),
          options({ expectedPlanDigest: reviewed.digest }),
        ),
      ),
    ).toBe("invalid_request");
  });
});

describe("result validation and sanitization", () => {
  it("rejects results scoped to another app instead of using them", async () => {
    const other = adapterFor(DOMAINS.incident);
    const { adapter } = instrument(adapterFor(deploy), {
      transform: (result) => {
        const value = structuredClone(result) as { metadata: { appId: string } };
        value.metadata.appId = DOMAINS.incident.appId;
        return value;
      },
    });
    void other;
    const { pack } = await executeInvestigation(
      requestFor(deploy, "process-health"),
      options({ adapter }),
    );
    expect(
      pack.evidence.every(
        (entry) => entry.status === "invalid_result" || entry.status === "skipped",
      ),
    ).toBe(true);
    expect(pack.evidence.every((entry) => entry.rows.length === 0)).toBe(true);
    expect(pack.status).toBe("cannot_determine");
    expect(pack.findings.every((finding) => finding.measure === null)).toBe(true);
  });

  it("drops unknown fields so no case-level data reaches the pack", async () => {
    const { adapter } = instrument(adapterFor(deploy), {
      transform: (result) => {
        const value = structuredClone(result) as {
          rows: Record<string, unknown>[];
          metadata: Record<string, unknown>;
        };
        value.metadata.caseIds = ["deploy-current-control-minor-manual-1"];
        for (const row of value.rows) {
          row.caseIds = ["deploy-current-control-minor-manual-1"];
          row.assignee = "person@example.invalid";
        }
        return value;
      },
    });
    const { pack } = await executeInvestigation(
      requestFor(deploy, "bottleneck-triage"),
      options({ adapter }),
    );
    const json = serializeEvidencePack(pack);
    expect(pack.status).toBe("complete");
    expect(json).not.toContain("caseIds");
    expect(json).not.toContain("example.invalid");
    expect(json).not.toContain("deploy-current-control");
  });

  it("sanitizes adapter errors and keeps going", async () => {
    const secret = "postgres://user:hunter2@db.internal/flightdeck";
    const { adapter } = instrument(adapterFor(deploy), {
      fail: (query) =>
        query.metric.kind === "stage-dwell" && query.metric.stageId === "canary"
          ? new Error(secret)
          : null,
    });
    const { pack, report } = await executeInvestigation(
      requestFor(deploy, "bottleneck-triage"),
      options({ adapter }),
    );
    expect(report.failed).toBe(1);
    expect(pack.status).toBe("partial");
    expect(
      pack.evidence.find((entry) => entry.queryId === "stage-dwell.current.canary")?.status,
    ).toBe("failed");
    expect(pack.missing).toContainEqual({
      ref: "q:stage-dwell.current.canary",
      reason: "query-failed",
    });
    expect(serializeEvidencePack(pack)).not.toContain("hunter2");
  });

  it("treats a missing watermark as an invalid result, never as fresh", async () => {
    const { adapter } = instrument(adapterFor(deploy), {
      transform: (result) => {
        const value = structuredClone(result) as { metadata: Record<string, unknown> };
        delete value.metadata.watermark;
        return value;
      },
    });
    const { pack } = await executeInvestigation(
      requestFor(deploy, "process-health"),
      options({ adapter }),
    );
    expect(pack.knowledge.watermark).toBeNull();
    expect(pack.knowledge.stale).toBe(true);
    expect(pack.status).toBe("cannot_determine");
  });

  it("rejects malformed rows (duplicates, unregistered strata, too many rows)", async () => {
    for (const mutate of [
      (rows: Record<string, unknown>[]) =>
        rows.push(structuredClone(rows[0]) as Record<string, unknown>),
      (rows: Record<string, unknown>[]) => {
        (rows[0] as { group: Record<string, string> }).group.caseMix = "unregistered";
      },
      (rows: Record<string, unknown>[]) => {
        (rows[0] as { p50Ms: number }).p50Ms = -5;
      },
      (rows: Record<string, unknown>[]) => {
        for (let index = 0; index < 60; index++)
          rows.push({ ...(rows[0] as object), key: `k${index}` });
      },
    ]) {
      const { adapter } = instrument(adapterFor(deploy), {
        transform: (result) => {
          const value = structuredClone(result) as { rows: Record<string, unknown>[] };
          mutate(value.rows);
          return value;
        },
      });
      const { pack } = await executeInvestigation(
        requestFor(deploy, "process-health"),
        options({ adapter }),
      );
      expect(pack.evidence[0]?.status).toBe("invalid_result");
    }
  });
});

describe("bounded execution", () => {
  it("never exceeds the concurrency budget", async () => {
    const { adapter, stats } = instrument(adapterFor(deploy), {
      delayMs: (index) => 5 + ((index * 7) % 11),
    });
    const { report } = await executeInvestigation(
      requestFor(deploy, "dwell-regression", { budget: { maxConcurrency: 2 } }),
      options({ adapter, now: undefined }),
    );
    expect(stats.calls).toBe(10);
    expect(stats.maxInFlight).toBeLessThanOrEqual(2);
    expect(report.maxInFlight).toBeLessThanOrEqual(2);
  });

  it("times out a hung query but keeps its slot until the I/O actually settles", async () => {
    let release: () => void = () => {};
    const hung = new Promise<void>((resolve) => {
      release = resolve;
    });
    const inner = adapterFor(deploy);
    let inFlight = 0,
      maxInFlight = 0;
    const adapter: QueryAdapter = {
      async query(query) {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        try {
          if (query.metric.kind === "stage-dwell" && query.metric.stageId === "build") await hung;
          return await inner.query(query);
        } finally {
          inFlight--;
        }
      },
    };
    const running = executeInvestigation(
      requestFor(deploy, "bottleneck-triage", {
        budget: { maxConcurrency: 1, queryTimeoutMs: 30, totalTimeoutMs: 120 },
      }),
      options({ adapter, now: undefined }),
    );
    const { pack, report } = await running;
    expect(report.timedOut).toBe(1);
    expect(
      pack.evidence.find((entry) => entry.queryId === "stage-dwell.current.build")?.status,
    ).toBe("timeout");
    // While the hung call held one slot, only one other query ran at a time.
    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(report.stoppedEarly).toBe("deadline");
    expect(report.skipped).toBeGreaterThan(0);
    expect(pack.missing.some((item) => item.reason === "skipped")).toBe(true);
    release();
  });

  it("stops at the total deadline and marks unstarted queries skipped", async () => {
    const { adapter, stats } = instrument(adapterFor(deploy), { delayMs: () => 40 });
    const { pack, report } = await executeInvestigation(
      requestFor(deploy, "dwell-regression", {
        budget: { maxConcurrency: 1, totalTimeoutMs: 100 },
      }),
      options({ adapter, now: undefined }),
    );
    expect(stats.calls).toBeLessThan(10);
    expect(report.stoppedEarly).toBe("deadline");
    expect(pack.evidence.filter((entry) => entry.status === "skipped").length).toBeGreaterThan(0);
    expect(pack.status).not.toBe("complete");
  });

  it("stops early when the gate population is insufficient", async () => {
    const incident = DOMAINS.incident;
    const { adapter, stats } = instrument(adapterFor(incident));
    const { pack, report } = await executeInvestigation(
      requestFor(incident, "bottleneck-triage", { cohort: { id: "control", caseMix: ["sev1"] } }),
      { catalog: catalogFor(incident), adapter, authorize: allow(incident.appId), now: NOW },
    );
    expect(stats.calls).toBe(1);
    expect(report.stoppedEarly).toBe("insufficient-population");
    expect(pack.status).toBe("cannot_determine");
    expect(pack.warnings).toContain("insufficient-population");
    expect(
      pack.findings.every(
        (finding) => finding.status === "cannot_determine" && finding.measure === null,
      ),
    ).toBe(true);
  });
});

describe("determinism and persistence", () => {
  it("produces an identical pack regardless of async completion order", async () => {
    const run = async (seed: number) => {
      const { adapter } = instrument(adapterFor(deploy), {
        delayMs: (index) => ((index + 1) * seed) % 13,
      });
      return (
        await executeInvestigation(
          requestFor(deploy, "dwell-regression"),
          options({ adapter, now: NOW }),
        )
      ).pack;
    };
    const [a, b, c] = await Promise.all([run(3), run(7), run(11)]);
    expect(a?.id).toBe(b?.id);
    expect(b?.id).toBe(c?.id);
    expect(serializeEvidencePack(a as never)).toBe(serializeEvidencePack(c as never));
  });

  it("round-trips through serialization and detects tampering", async () => {
    const { pack } = await executeInvestigation(requestFor(deploy, "bottleneck-triage"), options());
    const json = serializeEvidencePack(pack);
    expect(parseEvidencePack(json)).toEqual(pack);
    const tampered = json.replace(/"p50Ms":\d+/, '"p50Ms":1');
    expect(() => parseEvidencePack(tampered)).toThrow(InvestigationError);
    expect(() => parseEvidencePack("not json")).toThrow(InvestigationError);
  });

  it("persists only when asked, under an app-scoped key with a bounded TTL", async () => {
    const put = vi.fn();
    const { pack, report } = await executeInvestigation(
      requestFor(deploy, "bottleneck-triage"),
      options({ persist: { store: { put }, ttlSeconds: 3_600 } }),
    );
    expect(put).toHaveBeenCalledWith(
      `${deploy.appId}/${pack.id}`,
      serializeEvidencePack(pack),
      3_600,
    );
    expect(report.persisted).toBe(true);
    expect(
      await code(
        executeInvestigation(
          requestFor(deploy, "bottleneck-triage"),
          options({ persist: { store: { put }, ttlSeconds: 5 } }),
        ),
      ),
    ).toBe("invalid_options");
    const failing = await executeInvestigation(
      requestFor(deploy, "bottleneck-triage"),
      options({
        persist: { store: { put: () => Promise.reject(new Error("down")) }, ttlSeconds: 3_600 },
      }),
    );
    expect(failing.report.persisted).toBe(false);
  });
});

describe("optional cache", () => {
  const request: InvestigationRequest = requestFor(deploy, "bottleneck-triage");

  it("is disabled by default", async () => {
    const { report } = await executeInvestigation(request, options());
    expect(report.cacheHits).toBe(0);
  });

  it("hits only for the same authorized scope, catalog revision and source revision", async () => {
    const store = memoryCache();
    const cache = { store, sourceRevision: "wm-2026-02-05", ttlSeconds: 300 };
    const first = instrument(adapterFor(deploy));
    const a = await executeInvestigation(request, options({ adapter: first.adapter, cache }));
    expect(first.stats.calls).toBe(6);

    const second = instrument(adapterFor(deploy));
    const b = await executeInvestigation(request, options({ adapter: second.adapter, cache }));
    expect(second.stats.calls).toBe(0);
    expect(b.report.cacheHits).toBe(6);
    expect(b.pack).toEqual(a.pack);

    for (const variant of [
      { authorize: allow(deploy.appId, "scope-bob-r1") },
      { cache: { ...cache, sourceRevision: "wm-2026-02-06" } },
      { catalog: catalogFor(deploy, "rev-2") },
    ]) {
      const fresh = instrument(adapterFor(deploy));
      await executeInvestigation(request, options({ adapter: fresh.adapter, cache, ...variant }));
      expect(fresh.stats.calls).toBe(6);
    }
  });

  it("ignores poisoned or foreign cache entries", async () => {
    const incident = DOMAINS.incident;
    const foreign = await adapterFor(incident).query(
      planInvestigation(requestFor(incident, "bottleneck-triage"), catalogFor(incident), {
        now: NOW,
      }).queries[0]?.query as never,
    );
    const store: EvidenceCache = { get: () => structuredClone(foreign), set: () => {} };
    const { adapter, stats } = instrument(adapterFor(deploy));
    const { pack, report } = await executeInvestigation(
      request,
      options({ adapter, cache: { store, sourceRevision: "wm-1", ttlSeconds: 60 } }),
    );
    expect(report.cacheHits).toBe(0);
    expect(stats.calls).toBe(6);
    expect(pack.status).toBe("complete");
    expect(serializeEvidencePack(pack)).not.toContain(incident.appId);
  });

  it("requires a source revision and bounded TTL", async () => {
    const store = memoryCache();
    expect(
      await code(
        executeInvestigation(
          request,
          options({ cache: { store, sourceRevision: "", ttlSeconds: 60 } }),
        ),
      ),
    ).toBe("invalid_options");
    expect(
      await code(
        executeInvestigation(
          request,
          options({ cache: { store, sourceRevision: "wm", ttlSeconds: 0 } }),
        ),
      ),
    ).toBe("invalid_options");
  });

  it("treats cache failures as misses", async () => {
    const store: EvidenceCache = {
      get: () => Promise.reject(new Error("kv down")),
      set: () => Promise.reject(new Error("kv down")),
    };
    const { pack } = await executeInvestigation(
      request,
      options({ cache: { store, sourceRevision: "wm-1", ttlSeconds: 60 } }),
    );
    expect(pack.status).toBe("complete");
  });
});
