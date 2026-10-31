import type { IngestResult } from "@flightdeckhq/schema";
import { describe, expect, it, vi } from "vitest";
import { type ClientEventInput, flightdeck, handleFlightdeck, withFlightdeck } from "../src";

const ORIGIN = "https://app.example.com";
const ok = async (): Promise<IngestResult> => ({ accepted: 1, rejected: 0 });
const fakeEnv = (ingest = vi.fn(ok)) => ({
  FLIGHTDECK: { ingest, track: vi.fn(ok), identify: vi.fn(ok) },
  ingest,
});
const post = (body: BodyInit, headers: Record<string, string> = {}) =>
  new Request(`${ORIGIN}/_fd/e`, {
    method: "POST",
    body,
    headers: { Origin: ORIGIN, "Content-Type": "text/plain;charset=UTF-8", ...headers },
  });

describe("handleFlightdeck", () => {
  it("ignores other paths and rejects non-POST", async () => {
    const env = fakeEnv();
    expect(await handleFlightdeck(new Request(`${ORIGIN}/other`), env)).toBeNull();
    const res = await handleFlightdeck(new Request(`${ORIGIN}/_fd/e`), env);
    expect(res?.status).toBe(405);
    expect(res?.headers.get("Allow")).toBe("POST");
  });

  it("rejects cross-origin, oversized, and malformed bodies", async () => {
    const env = fakeEnv();
    expect((await handleFlightdeck(post("{}", { Origin: "https://evil.test" }), env))?.status).toBe(
      403,
    );
    expect((await handleFlightdeck(post("x".repeat(70_000)), env))?.status).toBe(413);
    expect((await handleFlightdeck(post("not json"), env))?.status).toBe(400);
    expect((await handleFlightdeck(post("null"), env))?.status).toBe(400);
    expect(env.ingest).not.toHaveBeenCalled();
  });

  it("accepts text/plain and application/json, with or without charset params", async () => {
    const env = fakeEnv();
    for (const type of [
      "text/plain",
      "text/plain;charset=UTF-8",
      "application/json",
      "Application/JSON; charset=utf-8",
    ]) {
      expect(
        (await handleFlightdeck(post('{"events":[]}', { "Content-Type": type }), env))?.status,
      ).toBe(204);
    }
    // sendBeacon with a typed Blob.
    const blob = new Blob(['{"events":[]}'], { type: "text/plain;charset=UTF-8" });
    const beacon = new Request(`${ORIGIN}/_fd/e`, {
      method: "POST",
      body: blob,
      headers: { Origin: ORIGIN },
    });
    expect(beacon.headers.get("Content-Type")).toBe("text/plain;charset=utf-8");
    expect((await handleFlightdeck(beacon, env))?.status).toBe(204);
  });

  it("rejects missing and other content types with 415", async () => {
    const env = fakeEnv();
    const noType = new Request(`${ORIGIN}/_fd/e`, {
      method: "POST",
      body: new Uint8Array(new TextEncoder().encode('{"events":[]}')),
      headers: { Origin: ORIGIN },
    });
    expect(noType.headers.get("Content-Type")).toBeNull();
    expect((await handleFlightdeck(noType, env))?.status).toBe(415);
    for (const type of [
      "application/x-www-form-urlencoded",
      "multipart/form-data; boundary=x",
      "text/html",
    ]) {
      expect(
        (await handleFlightdeck(post('{"events":[]}', { "Content-Type": type }), env))?.status,
      ).toBe(415);
    }
    expect(env.ingest).not.toHaveBeenCalled();
  });

  it("rejects a declared Content-Length over the limit without reading the body", async () => {
    const env = fakeEnv();
    const req = post('{"events":[]}', { "Content-Length": "100" });
    // Node's Request may drop a user-set Content-Length, so stub the header read directly.
    const headers = new Headers(req.headers);
    headers.set("Content-Length", "100");
    const pull = vi.fn((c: ReadableStreamDefaultController<Uint8Array>) => c.close());
    const body = new ReadableStream<Uint8Array>({ pull }, { highWaterMark: 0 });
    const fake = { url: req.url, method: "POST", headers, body } as unknown as Request;
    expect((await handleFlightdeck(fake, env, { maxBodyBytes: 50 }))?.status).toBe(413);
    expect(pull).not.toHaveBeenCalled();
  });

  it("enforces the limit on actual body bytes when Content-Length is absent or lying", async () => {
    const env = fakeEnv();
    // 20 two-byte characters: 20 UTF-16 units but 40 bytes.
    const body = JSON.stringify({ events: [], pad: "é".repeat(20) });
    const bytes = new TextEncoder().encode(body).length;
    expect(body.length).toBeLessThan(bytes);
    const limit = bytes - 1;
    expect(body.length).toBeLessThanOrEqual(limit);
    expect((await handleFlightdeck(post(body), env, { maxBodyBytes: limit }))?.status).toBe(413);

    const headers = new Headers({
      Origin: ORIGIN,
      "Content-Type": "text/plain",
      "Content-Length": "5",
    });
    const lying = {
      url: `${ORIGIN}/_fd/e`,
      method: "POST",
      headers,
      body: new Blob([body]).stream(),
    } as unknown as Request;
    expect((await handleFlightdeck(lying, env, { maxBodyBytes: limit }))?.status).toBe(413);
    expect(env.ingest).not.toHaveBeenCalled();
  });

  it("stops reading a streamed body as soon as it exceeds the limit", async () => {
    const env = fakeEnv();
    let pulls = 0;
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>(
      {
        pull(c) {
          pulls++;
          if (pulls > 100) c.close();
          else c.enqueue(new Uint8Array(1024).fill(32));
        },
        cancel,
      },
      { highWaterMark: 0 },
    );
    const fake = {
      url: `${ORIGIN}/_fd/e`,
      method: "POST",
      headers: new Headers({ Origin: ORIGIN, "Content-Type": "text/plain" }),
      body,
    } as unknown as Request;
    expect((await handleFlightdeck(fake, env, { maxBodyBytes: 4 * 1024 }))?.status).toBe(413);
    expect(pulls).toBeLessThanOrEqual(6);
    expect(cancel).toHaveBeenCalledOnce();
    expect(env.ingest).not.toHaveBeenCalled();
  });

  it("rejects a POST without a body with 400", async () => {
    const env = fakeEnv();
    const empty = new Request(`${ORIGIN}/_fd/e`, {
      method: "POST",
      headers: { Origin: ORIGIN, "Content-Type": "text/plain" },
    });
    expect(empty.body).toBeNull();
    expect((await handleFlightdeck(empty, env))?.status).toBe(400);
    expect(env.ingest).not.toHaveBeenCalled();
  });

  it("allows configured origins and requests without an Origin header", async () => {
    const env = fakeEnv();
    const res = await handleFlightdeck(
      post('{"events":[]}', { Origin: "https://www.example.com" }),
      env,
      {
        allowedOrigins: ["https://www.example.com"],
      },
    );
    expect(res?.status).toBe(204);
    const noOrigin = new Request(`${ORIGIN}/_fd/e`, {
      method: "POST",
      body: '{"events":[]}',
      headers: { "Content-Type": "text/plain" },
    });
    expect((await handleFlightdeck(noOrigin, env))?.status).toBe(204);
  });

  it("honours custom path and binding name", async () => {
    const ingest = vi.fn(ok);
    const env = { FD: { ingest, track: vi.fn(ok), identify: vi.fn(ok) } };
    const req = new Request(`${ORIGIN}/collect`, {
      method: "POST",
      body: '{"events":[]}',
      headers: { Origin: ORIGIN, "Content-Type": "application/json" },
    });
    expect((await handleFlightdeck(req, env, { path: "/collect", binding: "FD" }))?.status).toBe(
      204,
    );
    expect(ingest).toHaveBeenCalledOnce();
  });

  it("forwards events with request context and the Access JWT", async () => {
    const env = fakeEnv();
    const res = await handleFlightdeck(
      post('{"events":[{"kind":"click","name":"cta","ts":1}]}', {
        "User-Agent": "UA/1",
        "Cf-Access-Jwt-Assertion": "jwt",
      }),
      env,
    );
    expect(res?.status).toBe(204);
    expect(env.ingest).toHaveBeenCalledWith({
      events: [{ kind: "click", name: "cta", ts: 1 }],
      context: { userAgent: "UA/1" },
      accessJwt: "jwt",
    });
  });

  it("forwards the Cloudflare country and omits a missing JWT", async () => {
    const env = fakeEnv();
    const req = post('{"events":[]}', { "User-Agent": "UA/1" });
    Object.defineProperty(req, "cf", { value: { country: "GB" } });
    expect((await handleFlightdeck(req, env))?.status).toBe(204);
    expect(env.ingest).toHaveBeenCalledWith({
      events: [],
      context: { country: "GB", userAgent: "UA/1" },
    });
  });

  it("maps validation errors to 400 and other failures to 502", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const invalid = fakeEnv(vi.fn(async () => Promise.reject(new Error("invalid batch: events"))));
    expect((await handleFlightdeck(post('{"events":[]}'), invalid))?.status).toBe(400);
    expect(errors).not.toHaveBeenCalled();
    const down = fakeEnv(vi.fn(async () => Promise.reject(new Error("boom"))));
    expect((await handleFlightdeck(post('{"events":[]}'), down))?.status).toBe(502);
    expect(errors).toHaveBeenCalledOnce();
    errors.mockRestore();
  });

  it("throws a clear error when the binding is missing", async () => {
    await expect(handleFlightdeck(post('{"events":[]}'), {})).rejects.toThrow(/env\.FLIGHTDECK/);
  });
});

it("withFlightdeck intercepts the endpoint and passes everything else through", async () => {
  const env = fakeEnv();
  const ctx = {} as ExecutionContext;
  const call = (handler: ExportedHandler<typeof env>, request: Request) => {
    if (!handler.fetch) throw new Error("withFlightdeck must define fetch");
    return handler.fetch(request as never, env, ctx);
  };

  const handler = withFlightdeck({ fetch: async () => new Response("app") });
  expect((await call(handler, post('{"events":[]}'))).status).toBe(204);
  expect(await (await call(handler, new Request(`${ORIGIN}/`))).text()).toBe("app");

  expect((await call(withFlightdeck({}), new Request(`${ORIGIN}/`))).status).toBe(404);
});

it("withFlightdeck keeps a handler's other methods, including class-instance ones", async () => {
  const env = fakeEnv();
  const ctx = {} as ExecutionContext;
  const scheduled = vi.fn(async () => {});
  const plain = withFlightdeck<typeof env>({ fetch: async () => new Response("app"), scheduled });
  await plain.scheduled?.({} as ScheduledController, env, ctx);
  expect(scheduled).toHaveBeenCalledOnce();

  class App {
    greeting = "from class";
    queued: string[] = [];
    async fetch() {
      return new Response(this.greeting);
    }
    async queue() {
      this.queued.push(this.greeting);
    }
  }
  const app = new App();
  const wrapped = withFlightdeck<typeof env>(app);
  expect(typeof wrapped.queue).toBe("function");
  await wrapped.queue?.({} as MessageBatch, env, ctx);
  expect(app.queued).toEqual(["from class"]);
  const res = await wrapped.fetch?.(new Request(`${ORIGIN}/`) as never, env, ctx);
  expect(await res?.text()).toBe("from class");
  expect((await wrapped.fetch?.(post('{"events":[]}') as never, env, ctx))?.status).toBe(204);
});

describe("flightdeck", () => {
  it("returns the typed binding for server-side tracking", async () => {
    const env = fakeEnv();
    const fd = flightdeck(env);
    expect(await fd.track({ kind: "track", name: "signup", ts: 1 })).toEqual({
      accepted: 1,
      rejected: 0,
    });
    expect(env.FLIGHTDECK.track).toHaveBeenCalledWith({ kind: "track", name: "signup", ts: 1 });
    expect(flightdeck({ FD: env.FLIGHTDECK }, { binding: "FD" })).toBe(env.FLIGHTDECK);
  });

  it("throws a clear error when the binding is missing", () => {
    expect(() => flightdeck({})).toThrow("Flightdeck: env.FLIGHTDECK service binding is missing");
    expect(() => flightdeck({ FD: undefined }, { binding: "FD" })).toThrow(/env\.FD/);
  });
});

const sha256 = async (s: string) =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");

/** The batch passed to the `n`th ingest call. */
const sentBatch = (ingest: { mock: { calls: unknown[][] } }, n = 0) =>
  ingest.mock.calls[n]?.[0] as { events: ClientEventInput[] };

describe("privacy options", () => {
  const batch = JSON.stringify({
    events: [
      { kind: "click", name: "cta", ts: 1, userId: "jane@example.com", props: { a: 1 } },
      { kind: "track", name: "secret", ts: 2 },
    ],
  });

  it("applies beforeSend to browser batches, dropping and rewriting events", async () => {
    const env = fakeEnv();
    const beforeSend = vi.fn((e: ClientEventInput) =>
      e.name === "secret" ? null : { ...e, props: { ...e.props, scrubbed: true } },
    );
    expect((await handleFlightdeck(post(batch), env, { beforeSend }))?.status).toBe(204);
    expect(beforeSend).toHaveBeenCalledTimes(2);
    expect(env.ingest).toHaveBeenCalledWith({
      events: [
        {
          kind: "click",
          name: "cta",
          ts: 1,
          userId: "jane@example.com",
          props: { a: 1, scrubbed: true },
        },
      ],
      context: {},
    });
  });

  it("skips the ingest call when beforeSend drops every event", async () => {
    const env = fakeEnv();
    const res = await handleFlightdeck(post(batch), env, { beforeSend: () => null });
    expect(res?.status).toBe(204);
    expect(env.ingest).not.toHaveBeenCalled();
  });

  it("drops an event whose beforeSend throws and logs it", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const env = fakeEnv();
    const beforeSend = (e: ClientEventInput) => {
      if (e.name === "secret") throw new Error("boom");
      return e;
    };
    expect((await handleFlightdeck(post(batch), env, { beforeSend }))?.status).toBe(204);
    expect(sentBatch(env.ingest)).toMatchObject({ events: [{ name: "cta" }] });
    expect(errors).toHaveBeenCalledOnce();
    errors.mockRestore();
  });

  it("hashes browser userIds with SHA-256 hex, optionally salted", async () => {
    const env = fakeEnv();
    await handleFlightdeck(post(batch), env, { hashUserId: true });
    const plain = sentBatch(env.ingest);
    expect(plain.events[0]?.userId).toBe(await sha256("jane@example.com"));
    expect(plain.events[1]?.userId).toBeUndefined();

    await handleFlightdeck(post(batch), env, { hashUserId: { salt: "pepper" } });
    const salted = sentBatch(env.ingest, 1);
    expect(salted.events[0]?.userId).toBe(await sha256("pepperjane@example.com"));
    expect(salted.events[0]?.userId).toMatch(/^[0-9a-f]{64}$/);
  });

  it("leaves malformed batches for Flightdeck to reject", async () => {
    const env = fakeEnv();
    const beforeSend = vi.fn((e: ClientEventInput) => e);
    await handleFlightdeck(post('{"events":"nope"}'), env, { beforeSend });
    await handleFlightdeck(post('{"events":[null,"x"]}'), env, { beforeSend });
    expect(beforeSend).not.toHaveBeenCalled();
    expect([sentBatch(env.ingest).events, sentBatch(env.ingest, 1).events]).toEqual([
      "nope",
      [null, "x"],
    ]);
  });

  it("applies beforeSend and hashUserId to server track and identify", async () => {
    const env = fakeEnv();
    const fd = flightdeck(env, {
      hashUserId: true,
      beforeSend: (e) => (e.name === "student.viewed" ? null : { ...e, path: "/x" }),
    });
    expect(await fd.track({ name: "student.viewed", userId: "u1" })).toEqual({
      accepted: 0,
      rejected: 0,
    });
    expect(env.FLIGHTDECK.track).not.toHaveBeenCalled();

    await fd.track({ name: "issue.created", userId: "u1" });
    expect(env.FLIGHTDECK.track).toHaveBeenCalledWith({
      kind: "track",
      name: "issue.created",
      userId: await sha256("u1"),
      path: "/x",
    });

    await fd.identify({ userId: "u1", sessionId: "s".repeat(32) });
    expect(env.FLIGHTDECK.identify).toHaveBeenCalledWith({
      kind: "identify",
      name: "identify",
      userId: await sha256("u1"),
      sessionId: "s".repeat(32),
      path: "/x",
    });
  });

  it("returns the raw binding when no privacy options are set", () => {
    const env = fakeEnv();
    expect(flightdeck(env, {})).toBe(env.FLIGHTDECK);
    expect(flightdeck(env, { hashUserId: true })).not.toBe(env.FLIGHTDECK);
  });

  it("withFlightdeck passes the privacy options to the browser endpoint", async () => {
    const env = fakeEnv();
    const handler = withFlightdeck(
      { fetch: async () => new Response("app") },
      { hashUserId: true },
    );
    await handler.fetch?.(post(batch) as never, env, {} as ExecutionContext);
    const sent = sentBatch(env.ingest);
    expect(sent.events[0]?.userId).toBe(await sha256("jane@example.com"));
  });
});
