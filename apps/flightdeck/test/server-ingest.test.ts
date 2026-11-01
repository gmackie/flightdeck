import { env, exports } from "cloudflare:workers";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { sinks } from "../src/sinks";

const token = "a".repeat(48),
  expired = "b".repeat(48);
const hash = async (s: string) =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
beforeAll(async () => {
  await env.DB.prepare("INSERT INTO apps(id,name) VALUES ('app_bob_http','Bob')").run();
  for (const [value, expiry] of [
    [token, Date.now() + 600000],
    [expired, Date.now() - 1],
  ] as const) {
    await env.DB.prepare(
      "INSERT INTO server_ingest_keys (token_hash, app_id, expires_at) VALUES (?,?,?)",
    )
      .bind(await hash(value), "app_bob_http", expiry)
      .run();
  }
});
afterEach(() => vi.restoreAllMocks());
const batch = () => ({
  events: [
    {
      kind: "track",
      eventId: "event_bob_123",
      name: "bob.execution.completed",
      ts: Date.now(),
      props: { attempt_id: "attempt-1" },
    },
  ],
});
const post = (body: unknown, credential: string | null = token) =>
  exports.default.fetch("https://flightdeck.test/v1/server/events", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(credential ? { Authorization: `Bearer ${credential}` } : {}),
    },
    body: JSON.stringify(body),
  });
it("authenticates before ingestion and rejects missing, wrong and expired keys", async () => {
  const send = vi.spyOn(sinks, "events").mockResolvedValue();
  for (const key of [null, "wrong", "c".repeat(48), expired])
    expect((await post(batch(), key)).status).toBe(401);
  expect(send).not.toHaveBeenCalled();
});
it("records server events under the credential's app and retains retry event ids", async () => {
  const send = vi.spyOn(sinks, "events").mockResolvedValue();
  const response = await post(batch());
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ accepted: 1, rejected: 0 });
  expect(send.mock.calls[0]?.[1][0]).toMatchObject({
    app_id: "app_bob_http",
    source: "server",
    event_id: "event_bob_123",
  });
  expect((await post({ ...batch(), appId: "app_other" })).status).toBe(400);
  expect((await post({ ...batch(), accessJwt: "asserted" })).status).toBe(400);
});
it("validates event batches and limits the body even without Content-Length", async () => {
  vi.spyOn(sinks, "events").mockResolvedValue();
  expect((await post({ events: [] })).status).toBe(400);
  expect((await post({ events: Array(51).fill(batch().events[0]) })).status).toBe(400);
  expect((await post({ events: [{ kind: "page", name: "x", ts: Date.now() }] })).status).toBe(400);
  expect(await (await post({ events: [{ kind: "track", ts: Date.now() }] })).json()).toEqual({
    accepted: 0,
    rejected: 1,
  });
  expect((await post({ padding: "x".repeat(256 * 1024) })).status).toBe(413);
  const malformed = await exports.default.fetch("https://flightdeck.test/v1/server/events", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: "{",
  });
  expect(malformed.status).toBe(400);
});
it("reports sink failures as retryable without echoing internal data", async () => {
  vi.spyOn(sinks, "events").mockRejectedValue(new Error(`secret-${token}`));
  const response = await post(batch());
  expect(response.status).toBe(503);
  expect(response.headers.get("Retry-After")).toBe("5");
  expect(await response.text()).not.toContain(token);
});
it("rejects revoked credentials immediately", async () => {
  const revoked = "d".repeat(48),
    digest = await hash(revoked);
  await env.DB.prepare(
    "INSERT INTO server_ingest_keys (token_hash, app_id, expires_at) VALUES (?,?,?)",
  )
    .bind(digest, "app_bob_http", Date.now() + 600000)
    .run();
  await env.DB.prepare("DELETE FROM server_ingest_keys WHERE token_hash = ?").bind(digest).run();
  expect((await post(batch(), revoked)).status).toBe(401);
});
