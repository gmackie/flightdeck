import { env, exports } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { limits } from "../src/limits";
import { sinks } from "../src/sinks";
import { DEPLOY_PROCESS, registerDeploy } from "./lifecycle-process-fixtures";

const APP = "app_ll_main";
const KEY = "k".repeat(48);

beforeAll(async () => {
  await env.DB.prepare("INSERT INTO apps (id, name) VALUES (?, ?)").bind(APP, APP).run();
  await env.DB.prepare(
    "INSERT INTO app_capabilities (app_id, capability) VALUES (?, 'lifecycle.write')",
  )
    .bind(APP)
    .run();
  const digest = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(KEY))),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
  await env.DB.prepare(
    "INSERT INTO server_ingest_keys (token_hash, app_id, expires_at, scopes) VALUES (?,?,?,?)",
  )
    .bind(digest, APP, Date.now() + 600_000, "lifecycle.write")
    .run();
  await registerDeploy(APP);
});
afterEach(() => vi.restoreAllMocks());

let n = 0;
const event = () => ({
  schemaVersion: 1,
  eventId: `evt_ll_${String(++n).padStart(6, "0")}`,
  processId: "deploy",
  processVersion: 1,
  type: "case.created",
  caseId: `deploy:ll:${n}`,
  occurredAt: Date.now() - 1_000,
  sourceSequence: n,
});

const post = (path: string, body: unknown) =>
  exports.default.fetch(`https://flightdeck.test${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

async function rpcError(call: () => Promise<unknown>): Promise<string> {
  try {
    await call();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected the RPC call to reject");
}

describe("limits.lifecycle", () => {
  it("is unlimited without the opt-in binding", async () => {
    expect(await limits.lifecycle(env, APP)).toBe(true);
  });

  it("asks the binding with the app id as the key", async () => {
    const limit = vi.fn(async (_o: RateLimitOptions) => ({ success: false }));
    const limited = { ...env, LIFECYCLE_RATE_LIMIT: { limit } } as Env;
    expect(await limits.lifecycle(limited, APP)).toBe(false);
    expect(limit).toHaveBeenCalledWith({ key: APP });
  });
});

describe("throttled lifecycle writes", () => {
  it("answer 429 with Retry-After and store nothing", async () => {
    const send = vi.spyOn(sinks, "lifecycle").mockResolvedValue();
    const check = vi.spyOn(limits, "lifecycle").mockResolvedValue(false);
    const res = await post("/v1/lifecycle/events", { events: [event()] });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("10");
    expect((await post("/v1/lifecycle/processes", DEPLOY_PROCESS)).status).toBe(429);
    expect(check).toHaveBeenCalledWith(expect.anything(), APP);
    expect(send).not.toHaveBeenCalled();
  });

  it("throw a retryable error over RPC", async () => {
    vi.spyOn(sinks, "lifecycle").mockResolvedValue();
    vi.spyOn(limits, "lifecycle").mockResolvedValue(false);
    const rpc = exports.Ingest({ props: { appId: APP } });
    expect(await rpcError(() => rpc.trackLifecycle(event()))).toBe(
      "lifecycle throttled: rate limit exceeded",
    );
    expect(await rpcError(() => rpc.registerProcess(DEPLOY_PROCESS))).toMatch(
      /^lifecycle throttled/,
    );
  });

  it("are checked only after authentication, so unknown keys cannot drain an app's budget", async () => {
    const check = vi.spyOn(limits, "lifecycle").mockResolvedValue(false);
    const res = await exports.default.fetch("https://flightdeck.test/v1/lifecycle/events", {
      method: "POST",
      headers: { Authorization: `Bearer ${"z".repeat(48)}`, "Content-Type": "application/json" },
      body: JSON.stringify({ events: [event()] }),
    });
    expect(res.status).toBe(401);
    expect(check).not.toHaveBeenCalled();
  });

  it("fail as retryable 503 when the limiter errors", async () => {
    vi.spyOn(limits, "lifecycle").mockRejectedValue(new Error("limiter down"));
    const res = await post("/v1/lifecycle/events", { events: [event()] });
    expect(res.status).toBe(503);
  });

  it("pass when under the limit", async () => {
    vi.spyOn(sinks, "lifecycle").mockResolvedValue();
    vi.spyOn(limits, "lifecycle").mockResolvedValue(true);
    expect((await post("/v1/lifecycle/events", { events: [event()] })).status).toBe(200);
  });
});
