import { env, exports } from "cloudflare:workers";
import type { LifecycleRecord } from "@flightdeckhq/schema";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { MAX_FUTURE_SKEW_MS } from "../src/ingest/lifecycle";
import { sinks } from "../src/sinks";
import { registerDeploy } from "./lifecycle-process-fixtures";

// Keys: `lifecycle` (lifecycle.write) and `events` (legacy default scope) for the granted app,
// `ungranted` (lifecycle.write) for an app with no grant, `expired` for the granted app.
const KEYS = {
  lifecycle: "l".repeat(48),
  both: "m".repeat(48),
  events: "e".repeat(48),
  ungranted: "u".repeat(48),
  expired: "x".repeat(48),
};
const GRANTED = "app_lc_granted";
const UNGRANTED = "app_lc_ungranted";

const hash = async (s: string) =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");

const insertKey = async (raw: string, appId: string, scopes: string | null, expiresAt: number) => {
  const sql = scopes
    ? "INSERT INTO server_ingest_keys (token_hash, app_id, expires_at, scopes) VALUES (?,?,?,?)"
    : "INSERT INTO server_ingest_keys (token_hash, app_id, expires_at) VALUES (?,?,?)";
  const values = scopes
    ? [await hash(raw), appId, expiresAt, scopes]
    : [await hash(raw), appId, expiresAt];
  await env.DB.prepare(sql)
    .bind(...values)
    .run();
};

beforeAll(async () => {
  for (const id of [GRANTED, UNGRANTED, "app_lc_rpc", "app_lc_rpc_denied"]) {
    await env.DB.prepare("INSERT INTO apps (id, name) VALUES (?, ?)").bind(id, id).run();
  }
  for (const id of [GRANTED, "app_lc_rpc"]) {
    await env.DB.prepare(
      "INSERT INTO app_capabilities (app_id, capability) VALUES (?, 'lifecycle.write')",
    )
      .bind(id)
      .run();
  }
  for (const id of [GRANTED, "app_lc_rpc"]) await registerDeploy(id);
  const later = Date.now() + 600_000;
  await insertKey(KEYS.lifecycle, GRANTED, "lifecycle.write", later);
  await insertKey(KEYS.both, GRANTED, "events.write lifecycle.write", later);
  await insertKey(KEYS.events, GRANTED, null, later);
  await insertKey(KEYS.ungranted, UNGRANTED, "lifecycle.write", later);
  await insertKey(KEYS.expired, GRANTED, "lifecycle.write", Date.now() - 1);
});
afterEach(() => vi.restoreAllMocks());

let n = 0;
const event = (over: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  eventId: `evt_lc_${String(++n).padStart(6, "0")}`,
  processId: "deploy",
  processVersion: 1,
  type: "stage.entered",
  caseId: "deploy:web:1234",
  stageId: "canary",
  stageInstanceId: "si_canary_1",
  occurredAt: Date.now() - 1_000,
  sourceSequence: n,
  ...over,
});

/** A case-level event: no stage fields at all (an `undefined` key survives RPC cloning). */
const caseEvent = (over: Record<string, unknown> = {}) => {
  const { stageId: _s, stageInstanceId: _i, ...rest } = event(over);
  return rest;
};

const post = (body: unknown, key: string | null = KEYS.lifecycle, init: RequestInit = {}) =>
  exports.default.fetch("https://flightdeck.test/v1/lifecycle/events", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
    ...init,
  });

const stub = () => vi.spyOn(sinks, "lifecycle").mockResolvedValue();
const sent = (spy: ReturnType<typeof stub>, call = 0): LifecycleRecord[] =>
  spy.mock.calls[call]?.[1] ?? [];
const issues = async (res: Response) =>
  ((await res.json()) as { issues: { index: number | null; code: string }[] }).issues;

describe("POST /v1/lifecycle/events auth", () => {
  it("rejects missing, unknown and expired keys before reading the body", async () => {
    const send = stub();
    for (const key of [null, "short", "z".repeat(48), KEYS.expired]) {
      expect((await post({ events: [event()] }, key)).status, String(key)).toBe(401);
    }
    expect(send).not.toHaveBeenCalled();
  });

  it("requires the key's lifecycle.write scope and the app's grant", async () => {
    const send = stub();
    // A legacy events-only key for a granted app does not inherit lifecycle writes.
    expect((await post({ events: [event()] }, KEYS.events)).status).toBe(403);
    // A lifecycle-scoped key for an app without the operator grant.
    expect((await post({ events: [event()] }, KEYS.ungranted)).status).toBe(403);
    expect(send).not.toHaveBeenCalled();
    expect((await post({ events: [event()] }, KEYS.both)).status).toBe(200);
  });

  it("ignores browser identity: cookies and Access assertions do not authenticate", async () => {
    stub();
    const res = await post({ events: [event()] }, null, {
      headers: {
        "Content-Type": "application/json",
        Cookie: "CF_Authorization=abc",
        "Cf-Access-Jwt-Assertion": "a.b.c",
      },
    });
    expect(res.status).toBe(401);
  });

  it("only answers POST", async () => {
    const res = await exports.default.fetch("https://flightdeck.test/v1/lifecycle/events");
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("POST");
  });

  it("revoking the app grant takes effect on the next request", async () => {
    stub();
    await env.DB.prepare("INSERT INTO apps (id, name) VALUES ('app_lc_revoke', 'r')").run();
    await env.DB.prepare(
      "INSERT INTO app_capabilities (app_id, capability) VALUES ('app_lc_revoke', 'lifecycle.write')",
    ).run();
    const key = "r".repeat(48);
    await insertKey(key, "app_lc_revoke", "lifecycle.write", Date.now() + 600_000);
    await registerDeploy("app_lc_revoke");
    expect((await post({ events: [event()] }, key)).status).toBe(200);
    await env.DB.prepare("DELETE FROM app_capabilities WHERE app_id = 'app_lc_revoke'").run();
    expect((await post({ events: [event()] }, key)).status).toBe(403);
  });
});

describe("POST /v1/lifecycle/events ingestion", () => {
  it("stores events under the credential's app with true times and the http channel", async () => {
    const send = stub();
    const e = event({ dimensions: { region: "us-east" } });
    const res = await post({ events: [e] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted: 1 });
    const [row] = sent(send);
    expect(row).toMatchObject({
      event_id: e.eventId,
      app_id: GRANTED,
      process_id: "deploy",
      type: "stage.entered",
      stage_id: "canary",
      stage_instance_id: "si_canary_1",
      occurred_at: e.occurredAt,
      source_sequence: e.sourceSequence,
      dimensions: { region: "us-east" },
      channel: "http",
    });
    expect(row?.received_at).toBeGreaterThanOrEqual(e.occurredAt);
  });

  it("refuses an app id or Access assertion in the body", async () => {
    const send = stub();
    for (const extra of [{ appId: UNGRANTED }, { accessJwt: "jwt" }, { context: {} }]) {
      const res = await post({ events: [event()], ...extra });
      expect(res.status).toBe(400);
      expect((await issues(res))[0]?.code).toBe("invalid_envelope");
    }
    const inEvent = await post({ events: [event({ appId: UNGRANTED })] });
    expect((await issues(inEvent))[0]?.code).toBe("invalid_event");
    expect(send).not.toHaveBeenCalled();
  });

  it("keeps backfilled occurredAt values older than 24 hours exactly", async () => {
    const send = stub();
    const old = Date.UTC(2024, 0, 15, 9, 30);
    const days = Date.now() - 3 * 24 * 60 * 60_000;
    const res = await post({ events: [event({ occurredAt: old }), event({ occurredAt: days })] });
    expect(res.status).toBe(200);
    expect(sent(send).map((r) => r.occurred_at)).toEqual([old, days]);
  });

  it("rejects future skew instead of clamping it", async () => {
    const send = stub();
    const ahead = Date.now() + MAX_FUTURE_SKEW_MS + 60_000;
    const res = await post({ events: [event(), event({ occurredAt: ahead })] });
    expect(res.status).toBe(400);
    expect(await issues(res)).toEqual([
      { index: 1, code: "future_occurred_at", message: "occurredAt is ahead of the server clock" },
    ]);
    const amend = caseEvent({
      type: "event.corrected",
      correction: { targetEventId: "evt_lc_target01", action: "amend", occurredAt: ahead },
    });
    expect((await issues(await post({ events: [amend] })))[0]?.code).toBe("future_occurred_at");
    // Within the allowed skew is fine.
    expect((await post({ events: [event({ occurredAt: Date.now() + 60_000 })] })).status).toBe(200);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("is all or nothing: one bad event rejects the batch and nothing is stored", async () => {
    const send = stub();
    const res = await post({ events: [event(), event({ schemaVersion: 2 }), event()] });
    expect(res.status).toBe(400);
    expect(await issues(res)).toEqual([
      { index: 1, code: "unsupported_schema_version", message: "schemaVersion must be 1" },
    ]);
    expect(send).not.toHaveBeenCalled();
  });

  it("names prohibited keys without echoing values", async () => {
    stub();
    const res = await post({
      events: [event({ dimensions: { candidate_email: "jane@example.com" } })],
    });
    const body = await res.text();
    expect(res.status).toBe(400);
    expect(body).toContain("prohibited_key");
    expect(body).not.toContain("jane@example.com");
    const badId = await post({ events: [event({ caseId: "jane@example.com" })] });
    expect(await badId.text()).not.toContain("jane@example.com");
  });

  it("rejects duplicate event ids within a batch", async () => {
    stub();
    const e = event();
    const res = await post({ events: [e, { ...e }] });
    expect(await issues(res)).toEqual([
      { index: 1, code: "duplicate_event_id", message: "eventId repeats in the batch" },
    ]);
  });

  it("accepts a retried batch again: dedup is downstream on (app_id, event_id)", async () => {
    const send = stub();
    const batch = { events: [event()] };
    expect((await post(batch)).status).toBe(200);
    expect((await post(batch)).status).toBe(200);
    expect(sent(send, 0)[0]?.event_id).toBe(sent(send, 1)[0]?.event_id);
  });

  it("enforces batch, event and body limits", async () => {
    const send = stub();
    expect((await post({ events: [] })).status).toBe(400);
    expect((await post({ events: Array.from({ length: 101 }, () => event()) })).status).toBe(400);
    expect((await post({ events: [event()], pad: "x".repeat(256 * 1024) })).status).toBe(413);
    expect((await post("{")).status).toBe(400);
    expect((await post("[]")).status).toBe(400);
    const text = await post(JSON.stringify({ events: [event()] }), KEYS.lifecycle, {
      headers: { Authorization: `Bearer ${KEYS.lifecycle}`, "Content-Type": "text/plain" },
    });
    expect(text.status).toBe(415);
    expect(send).not.toHaveBeenCalled();
    const hundred = Array.from({ length: 100 }, () => event());
    expect((await post({ events: hundred })).status).toBe(200);
  });

  it("never writes lifecycle events to the generic events stream, nor the reverse", async () => {
    const events = vi.spyOn(sinks, "events").mockResolvedValue();
    const lifecycle = stub();
    expect((await post({ events: [event()] })).status).toBe(200);
    expect(events).not.toHaveBeenCalled();
    // A lifecycle-only key cannot write generic events.
    const generic = await exports.default.fetch("https://flightdeck.test/v1/server/events", {
      method: "POST",
      headers: { Authorization: `Bearer ${KEYS.lifecycle}`, "Content-Type": "application/json" },
      body: JSON.stringify({ events: [{ kind: "track", name: "x", ts: Date.now() }] }),
    });
    expect(generic.status).toBe(403);
    expect(events).not.toHaveBeenCalled();
    expect(lifecycle).toHaveBeenCalledTimes(1);
  });

  it("answers 503 with a long Retry-After while the stream is not bound", async () => {
    // No stub: the test Worker has no LIFECYCLE_EVENTS binding, as in an unprovisioned deploy.
    const res = await post({ events: [event()] });
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("60");
  });

  it("reports sink failures as retryable without echoing internals", async () => {
    vi.spyOn(sinks, "lifecycle").mockRejectedValue(new Error(`boom ${KEYS.lifecycle}`));
    const res = await post({ events: [event()] });
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("5");
    expect(await res.text()).not.toContain(KEYS.lifecycle);
  });
});

describe("Ingest.trackLifecycle / ingestLifecycleBatch", () => {
  const rpc = (appId?: string) => exports.Ingest({ props: appId ? { appId } : {} });

  async function rpcError(call: () => Promise<unknown>): Promise<string> {
    try {
      await call();
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    throw new Error("expected the RPC call to reject");
  }

  it("requires a bound, registered app with the lifecycle.write grant", async () => {
    const send = stub();
    expect(await rpcError(() => rpc().trackLifecycle(event()))).toMatch(/props.appId/);
    expect(await rpcError(() => rpc("app_lc_missing").trackLifecycle(event()))).toMatch(
      /unknown app/,
    );
    expect(await rpcError(() => rpc("app_lc_rpc_denied").trackLifecycle(event()))).toMatch(
      /^lifecycle forbidden/,
    );
    expect(send).not.toHaveBeenCalled();
  });

  it("stores single events and batches under the bound app", async () => {
    const send = stub();
    expect(await rpc("app_lc_rpc").trackLifecycle(event({ type: "stage.exited" }))).toEqual({
      accepted: 1,
    });
    const batch = {
      events: [
        caseEvent({
          type: "object.linked",
          object: { type: "pull_request", objectId: "gh-42" },
          relations: [{ type: "built_from", objectType: "commit", objectId: "af2f2f7" }],
        }),
        caseEvent({ type: "case.completed" }),
      ],
    };
    expect(await rpc("app_lc_rpc").ingestLifecycleBatch(batch)).toEqual({ accepted: 2 });
    const rows = sent(send, 1);
    expect(rows.every((r) => r.app_id === "app_lc_rpc" && r.channel === "binding")).toBe(true);
    expect(rows[0]).toMatchObject({
      object_type: "pull_request",
      object_id: "gh-42",
      stage_id: null,
      relations: [{ type: "built_from", object_type: "commit", object_id: "af2f2f7" }],
    });
  });

  it("throws permanent rejections with a stable prefix", async () => {
    const send = stub();
    const message = await rpcError(() =>
      rpc("app_lc_rpc").ingestLifecycleBatch({ events: [event({ type: "stage.teleported" })] }),
    );
    expect(message).toMatch(/^lifecycle rejected \(invalid_event\) at events\[0\]/);
    expect(
      await rpcError(() =>
        rpc("app_lc_rpc").ingestLifecycleBatch({ events: [event()], appId: "x" }),
      ),
    ).toMatch(/^lifecycle rejected \(invalid_envelope\)/);
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects BigInt and cyclic events permanently instead of crashing", async () => {
    const send = stub();
    const cyclic: Record<string, unknown> = event();
    cyclic.relations = [cyclic];
    for (const bad of [event({ sourceSequence: 5n }), cyclic]) {
      expect(await rpcError(() => rpc("app_lc_rpc").trackLifecycle(bad))).toMatch(
        /^lifecycle rejected \(invalid_event\)/,
      );
    }
    expect(send).not.toHaveBeenCalled();
  });

  it("does not echo numeric values in messages", async () => {
    stub();
    const message = await rpcError(() =>
      rpc("app_lc_rpc").trackLifecycle(event({ processVersion: 3.25 })),
    );
    expect(message).toMatch(/^lifecycle rejected \(invalid_event\)/);
    expect(message).not.toContain("3.25");
  });

  it("throws a retryable error while the stream is not bound", async () => {
    expect(await rpcError(() => rpc("app_lc_rpc").trackLifecycle(event()))).toMatch(
      /^lifecycle unavailable/,
    );
  });
});
