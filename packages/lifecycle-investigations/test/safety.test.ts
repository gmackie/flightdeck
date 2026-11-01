import { createHash } from "node:crypto";
import type { QueryAdapter } from "@flightdeckhq/lifecycle-queries";
import { describe, expect, it, vi } from "vitest";
import {
  type AgentAnalysis,
  canonicalJson,
  type EvidenceCache,
  executeInvestigation,
  planInvestigation,
  serializeEvidencePack,
  validateAgentAnalysis,
} from "../src/index.js";
import {
  AS_OF,
  adapterFor,
  allow,
  catalogFor,
  DOMAINS,
  instrument,
  NOW,
  requestFor,
} from "./fixtures.js";

interface MutableComparison {
  metadata: { cohort: { caseMix: string[] } };
  metric: { stageId: string };
  rows: [
    {
      key: string;
      group: { caseMix: string };
      deltaP50Ms: number;
      primary: { suppression: { percentiles: boolean } };
    },
  ];
}
function defined<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing test fixture");
  return value;
}
const domain = DOMAINS.deploy;
const run = (adapter = adapterFor(domain)) =>
  executeInvestigation(requestFor(domain, "intervention-review"), {
    adapter,
    catalog: catalogFor(domain),
    authorize: allow(domain.appId),
    now: NOW,
  });

describe("security and evidence regression boundaries", () => {
  it("allows an exact negative p50 delta for a faster intervention and preserves exact refs and hashes", async () => {
    const { plan, pack } = await run();
    const entry = pack.evidence.find(
      (entry) => entry.stageId === "review" && entry.purpose === "stage-comparison",
    );
    expect(entry?.status).toBe("ok");
    const row = entry?.rows.find((row) => row.group.caseMix === "minor");
    expect(row?.deltaP50Ms).toBeLessThan(0);
    expect(row?.deltaP50Ms).toBe((row?.sample?.p50Ms ?? 0) - (row?.reference?.p50Ms ?? 0));
    const finding = defined(
      pack.findings.find(
        (finding) => finding.id === "f:cohort-dwell-difference:H1:caseMix=minor:review",
      ),
    );
    expect(finding?.measure?.value).toBe(row?.deltaP50Ms);
    expect(finding?.evidenceRefs).toEqual([row?.ref]);
    expect(finding?.metadataRefs).toEqual([entry?.ref]);
    expect(plan.queries.find((query) => query.id === entry?.queryId)?.digest).toBe(
      entry?.queryDigest,
    );
    const { digest, id, ...body } = pack;
    expect(digest).toBe(createHash("sha256").update(canonicalJson(body)).digest("hex"));
    expect(id).toBe(`ep_${digest.slice(0, 32)}`);
  });

  it("requires authorization before ALL cache, query, and persistence I/O", async () => {
    const get = vi.fn(),
      set = vi.fn(),
      put = vi.fn(),
      query = vi.fn();
    await expect(
      executeInvestigation(requestFor(domain, "process-health"), {
        catalog: catalogFor(domain),
        adapter: { query },
        authorize: () => ({ allowed: false }),
        now: NOW,
        cache: { store: { get, set }, sourceRevision: "source-1", ttlSeconds: 60 },
        persist: { store: { put }, ttlSeconds: 60 },
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    for (const spy of [get, set, put, query]) expect(spy).not.toHaveBeenCalled();
  });

  it("rejects a revoked grant after planning, before cache I/O", async () => {
    const request = requestFor(domain, "process-health");
    planInvestigation(request, catalogFor(domain), { now: NOW });
    const get = vi.fn();
    let checks = 0;
    await expect(
      executeInvestigation(request, {
        catalog: catalogFor(domain),
        adapter: adapterFor(domain),
        now: NOW,
        authorize: () =>
          ++checks === 1
            ? { allowed: true, appId: domain.appId, scopeKey: "s1" }
            : { allowed: false },
        cache: { store: { get, set: vi.fn() }, sourceRevision: "source-1", ttlSeconds: 60 },
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(get).not.toHaveBeenCalled();
  });

  it("checks grants again after cache reads and before return", async () => {
    const store = new Map<string, unknown>();
    let scopeKey = "s1";
    const authorize = () => ({ allowed: true as const, appId: domain.appId, scopeKey });
    const cache: EvidenceCache = {
      get: (key) => store.get(key),
      set: (key, value) => {
        store.set(key, value);
      },
    };
    const options = {
      catalog: catalogFor(domain),
      adapter: adapterFor(domain),
      authorize,
      now: NOW,
      cache: { store: cache, sourceRevision: "source-1", ttlSeconds: 60 },
    };
    await executeInvestigation(requestFor(domain, "process-health"), options);
    cache.get = (key) => {
      scopeKey = "s2";
      return store.get(key);
    };
    const put = vi.fn();
    await expect(
      executeInvestigation(requestFor(domain, "process-health"), {
        ...options,
        persist: { store: { put }, ttlSeconds: 60 },
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(put).not.toHaveBeenCalled();
  });

  it("never reuses cached evidence across changed grants even for the same principal", async () => {
    const store = new Map<string, unknown>();
    const cache = {
      sourceRevision: "source-1",
      ttlSeconds: 60,
      store: {
        get: (key: string) => store.get(key),
        set: (key: string, value: unknown) => {
          store.set(key, value);
        },
      },
    };
    for (const scope of ["alice-r1", "alice-r2"]) {
      const { adapter, stats } = instrument(adapterFor(domain));
      const result = await executeInvestigation(requestFor(domain, "process-health"), {
        adapter,
        catalog: catalogFor(domain),
        authorize: allow(domain.appId, scope),
        now: NOW,
        cache,
      });
      expect(stats.calls).toBe(result.plan.queries.length);
      expect(result.report.cacheHits).toBe(0);
    }
  });

  it.each([
    [
      "wrong cohort",
      (r: MutableComparison) => {
        r.metadata.cohort.caseMix = ["major"];
      },
    ],
    [
      "wrong stage",
      (r: MutableComparison) => {
        r.metric.stageId = "rollout";
      },
    ],
    [
      "unregistered grouping value",
      (r: MutableComparison) => {
        r.rows[0].group.caseMix = "private.person";
      },
    ],
    [
      "invented positive delta",
      (r: MutableComparison) => {
        r.rows[0].deltaP50Ms = 1;
      },
    ],
    [
      "leaked suppressed statistic",
      (r: MutableComparison) => {
        r.rows[0].primary.suppression.percentiles = true;
      },
    ],
    [
      "wrong key",
      (r: MutableComparison) => {
        r.rows[0].key = "private.person";
      },
    ],
  ])("rejects %s without leaking values", async (_, mutate) => {
    const { adapter } = instrument(adapterFor(domain), {
      transform: (result, query) => {
        if (query.metric.kind === "comparison" && query.metric.stageId === "review")
          mutate(result as MutableComparison);
        return result;
      },
    });
    const { pack } = await run(adapter);
    expect(
      pack.evidence.find((entry) => entry.queryId === "stage-comparison.current.review")?.status,
    ).toBe("invalid_result");
    expect(serializeEvidencePack(pack)).not.toContain("private.person");
  });

  it("reports per-result late freshness and incomplete windows even within an allowed lag", async () => {
    const { adapter } = instrument(adapterFor(domain), {
      transform: (result) => {
        const r = result as { metadata: { watermark: string } };
        r.metadata.watermark = "2026-01-28T23:00:00.000Z";
        return r;
      },
    });
    const catalog = catalogFor(domain);
    catalog.policy = { maxWatermarkLagMs: 31 * 86400000 };
    const { pack } = await executeInvestigation(requestFor(domain, "dwell-regression"), {
      adapter,
      catalog,
      authorize: allow(domain.appId),
      now: NOW,
    });
    expect(pack.knowledge.stale).toBe(true);
    expect(pack.evidence[0]?.metadata?.sourceFreshness).toEqual({
      lagMs: Date.parse(AS_OF) - Date.parse("2026-01-28T23:00:00.000Z"),
      coversWindow: false,
    });
    expect(pack.findings.some((finding) => finding.reasons.includes("incomplete-window"))).toBe(
      true,
    );
  });

  it("does not invent comparisons across different source watermarks", async () => {
    const { adapter } = instrument(adapterFor(domain), {
      transform: (result, query) => {
        if (query.from === "2026-01-01T00:00:00.000Z")
          (result as { metadata: { watermark: string } }).metadata.watermark =
            "2026-02-04T23:00:00.000Z";
        return result;
      },
    });
    const { pack } = await executeInvestigation(requestFor(domain, "dwell-regression"), {
      adapter,
      catalog: catalogFor(domain),
      authorize: allow(domain.appId),
      now: NOW,
    });
    expect(pack.findings.every((finding) => finding.status === "cannot_determine")).toBe(true);
    expect(
      pack.findings.every((finding) => finding.reasons.includes("inconsistent-watermark")),
    ).toBe(true);
  });

  it("does not start I/O or cache late results after a timeout returns", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const inner = adapterFor(domain);
    const query = vi.fn(async (input) => {
      await blocked;
      return inner.query(input);
    });
    const set = vi.fn();
    const { pack, report } = await executeInvestigation(
      requestFor(domain, "process-health", {
        budget: { maxConcurrency: 1, queryTimeoutMs: 10, totalTimeoutMs: 35 },
      }),
      {
        catalog: catalogFor(domain),
        adapter: { query } as QueryAdapter,
        authorize: allow(domain.appId),
        now: NOW,
        cache: { store: { get: () => undefined, set }, sourceRevision: "source-1", ttlSeconds: 60 },
      },
    );
    expect(report.timedOut).toBe(1);
    const before = serializeEvidencePack(pack);
    release();
    await blocked;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(query).toHaveBeenCalledTimes(1);
    expect(set).not.toHaveBeenCalled();
    expect(serializeEvidencePack(pack)).toBe(before);
  });

  it("requires complete evidence refs and exact statements, rejecting causal hypotheses and invented numbers", async () => {
    const { pack } = await run();
    const finding = defined(
      pack.findings.find((f) => f.id === "f:cohort-dwell-difference:H1:caseMix=minor:review"),
    );
    const base: AgentAnalysis = {
      evidencePackId: pack.id,
      claims: [
        {
          claim: finding.statement,
          kind: "association",
          findingIds: [finding.id],
          evidenceRefs: finding.evidenceRefs,
          uncertainty: { level: "high", notes: "Observational and censored." },
          counterevidence: [],
          actionProposal: { kind: "next-measurement", description: "Observe mature cohorts." },
        },
      ],
      missingEvidence: [],
      nextMeasurements: [],
    };
    expect(validateAgentAnalysis(pack, base).valid).toBe(true);
    for (const text of ["The pilot is 99% faster.", "The pilot caused faster processing."]) {
      const changed = structuredClone(base);
      defined(changed.claims[0]).claim = text;
      defined(changed.claims[0]).kind = "hypothesis";
      expect(validateAgentAnalysis(pack, changed).valid).toBe(false);
    }
    const missing = structuredClone(base);
    defined(missing.claims[0]).evidenceRefs = [];
    expect(validateAgentAnalysis(pack, missing).issues.map((i) => i.issue)).toContain(
      "incomplete-refs",
    );
    const invalid = structuredClone(base);
    defined(invalid.claims[0]).kind = "bogus" as never;
    expect(validateAgentAnalysis(pack, invalid).valid).toBe(false);
  });
});
