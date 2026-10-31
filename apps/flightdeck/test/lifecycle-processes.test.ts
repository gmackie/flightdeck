import { env, exports } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { clearProcessCache, getDefinitions, registerDefinition } from "../src/processes";
import { sinks } from "../src/sinks";
import { DEPLOY_PROCESS } from "./lifecycle-fixtures";

const APP = "app_lp_main";
const OTHER = "app_lp_other";
const KEY = "p".repeat(48);
const EVENTS_KEY = "q".repeat(48);

const hash = async (s: string) =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");

beforeAll(async () => {
  for (const id of [APP, OTHER, "app_lp_denied"]) {
    await env.DB.prepare("INSERT INTO apps (id, name) VALUES (?, ?)").bind(id, id).run();
  }
  for (const id of [APP, OTHER]) {
    await env.DB.prepare(
      "INSERT INTO app_capabilities (app_id, capability) VALUES (?, 'lifecycle.write')",
    )
      .bind(id)
      .run();
  }
  const later = Date.now() + 600_000;
  await env.DB.prepare(
    "INSERT INTO server_ingest_keys (token_hash, app_id, expires_at, scopes) VALUES (?,?,?,?)",
  )
    .bind(await hash(KEY), APP, later, "lifecycle.write")
    .run();
  await env.DB.prepare(
    "INSERT INTO server_ingest_keys (token_hash, app_id, expires_at) VALUES (?,?,?)",
  )
    .bind(await hash(EVENTS_KEY), APP, later)
    .run();
});
afterEach(() => vi.restoreAllMocks());

const definition = (over: Record<string, unknown> = {}) => ({ ...DEPLOY_PROCESS, ...over });

const register = (body: unknown, key: string | null = KEY) =>
  exports.default.fetch("https://flightdeck.test/v1/lifecycle/processes", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
    },
    body: JSON.stringify(body),
  });

let n = 0;
const event = (over: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  eventId: `evt_lp_${String(++n).padStart(6, "0")}`,
  processId: "deploy",
  processVersion: 1,
  type: "stage.entered",
  caseId: "deploy:api:1",
  stageId: "canary",
  stageInstanceId: `si_${n}`,
  occurredAt: Date.now() - 1_000,
  sourceSequence: n,
  ...over,
});

const rpc = (appId: string) => exports.Ingest({ props: { appId } });

async function rpcError(call: () => Promise<unknown>): Promise<string> {
  try {
    await call();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected the RPC call to reject");
}

describe("POST /v1/lifecycle/processes", () => {
  it("requires a lifecycle key for a granted app", async () => {
    expect((await register(definition(), null)).status).toBe(401);
    expect((await register(definition(), EVENTS_KEY)).status).toBe(403);
    const get = await exports.default.fetch("https://flightdeck.test/v1/lifecycle/processes");
    expect(get.status).toBe(405);
  });

  it("creates once, is idempotent for identical content, and refuses changes", async () => {
    const first = await register(definition({ processId: "release" }));
    expect(first.status).toBe(201);
    expect(await first.json()).toEqual({
      process: { processId: "release", version: 1 },
      created: true,
    });
    const again = await register(definition({ processId: "release" }));
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ created: false });
    const changed = await register(definition({ processId: "release", name: "Release v2" }));
    expect(changed.status).toBe(409);
    expect((await register(definition({ processId: "release", version: 2 }))).status).toBe(201);
  });

  it("rejects invalid definitions without echoing values", async () => {
    for (const bad of [
      definition({ schemaVersion: 2 }),
      definition({ stages: [] }),
      definition({ dimensions: [{ key: "candidate_email", values: ["x"] }] }),
      definition({ version: 1.75 }),
      definition({ owner: "jane@example.com" }),
    ]) {
      const res = await register(bad);
      expect(res.status).toBe(400);
      const text = await res.text();
      expect(text).not.toContain("1.75");
      expect(text).not.toContain("jane@example.com");
    }
  });
});

describe("Ingest.registerProcess", () => {
  it("registers for the bound app and reports conflicts permanently", async () => {
    expect(await rpc(OTHER).registerProcess(definition({ processId: "incident" }))).toEqual({
      created: true,
    });
    expect(await rpc(OTHER).registerProcess(definition({ processId: "incident" }))).toEqual({
      created: false,
    });
    expect(
      await rpcError(() =>
        rpc(OTHER).registerProcess(definition({ processId: "incident", name: "Changed" })),
      ),
    ).toMatch(/^lifecycle rejected \(definition_conflict\)/);
    expect(await rpcError(() => rpc(OTHER).registerProcess({ processId: "x" }))).toMatch(
      /^lifecycle rejected \(invalid_definition\)/,
    );
  });

  it("requires the lifecycle.write grant", async () => {
    expect(await rpcError(() => rpc("app_lp_denied").registerProcess(definition()))).toMatch(
      /^lifecycle forbidden/,
    );
  });
});

describe("ingestion enforces registered definitions", () => {
  it("rejects events for an unregistered version, then accepts them once registered", async () => {
    const send = vi.spyOn(sinks, "lifecycle").mockResolvedValue();
    const batch = { events: [event({ processId: "rollback" })] };
    expect(await rpcError(() => rpc(APP).ingestLifecycleBatch(batch))).toMatch(
      /^lifecycle rejected \(unknown_process\) at events\[0\]: process rollback@1 is not registered/,
    );
    await rpc(APP).registerProcess(definition({ processId: "rollback" }));
    // Misses are not cached: the retry sees the new definition at once.
    expect(await rpc(APP).ingestLifecycleBatch(batch)).toEqual({ accepted: 1 });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("rejects events that break their definition, without storing the batch", async () => {
    const send = vi.spyOn(sinks, "lifecycle").mockResolvedValue();
    await registerDefinition(env.DB, APP, DEPLOY_PROCESS);
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ stageId: "onsite" }, /unknown stage onsite/],
      [{ dimensions: { region: "ap-south" } }, /value not allowed for dimension region/],
      [{ dimensions: { tier: "gold" } }, /unknown dimension tier/],
      [
        { relations: [{ type: "built_from", objectType: "image", objectId: "i1" }] },
        /relation built_from to image not allowed/,
      ],
    ];
    for (const [over, pattern] of cases) {
      const message = await rpcError(() =>
        rpc(APP).ingestLifecycleBatch({ events: [event(), event(over)] }),
      );
      expect(message).toMatch(/^lifecycle rejected \(nonconforming_event\) at events\[1\]/);
      expect(message).toMatch(pattern);
      expect(message).not.toContain("ap-south");
    }
    expect(send).not.toHaveBeenCalled();
  });

  it("returns definition issues over HTTP with their index", async () => {
    vi.spyOn(sinks, "lifecycle").mockResolvedValue();
    await registerDefinition(env.DB, APP, DEPLOY_PROCESS);
    const res = await exports.default.fetch("https://flightdeck.test/v1/lifecycle/events", {
      method: "POST",
      headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ events: [event({ processVersion: 9 })] }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      issues: [
        { index: 0, code: "unknown_process", message: "process deploy@9 is not registered" },
      ],
    });
  });

  it("keeps definitions per app: another app's registration does not apply", async () => {
    vi.spyOn(sinks, "lifecycle").mockResolvedValue();
    await rpc(OTHER).registerProcess(definition({ processId: "oncall" }));
    expect(await rpcError(() => rpc(APP).trackLifecycle(event({ processId: "oncall" })))).toMatch(
      /unknown_process/,
    );
  });
});

describe("getDefinitions", () => {
  it("looks up more keys than D1's bound-parameter cap in one query", async () => {
    clearProcessCache();
    await registerDefinition(env.DB, APP, definition({ processId: "bulk", version: 7 }));
    const keys = Array.from({ length: 150 }, (_, i) => `bulk@${i + 1}`);
    const found = await getDefinitions(env.DB, APP, keys);
    expect([...found.keys()]).toEqual(["bulk@7"]);
    expect((await getDefinitions(env.DB, OTHER, keys)).size).toBe(0);
  });
});
