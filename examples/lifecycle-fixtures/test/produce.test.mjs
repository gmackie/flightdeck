import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { generate } from "../lib/generate.mjs";
import { toNdjson } from "../lib/golden.mjs";
import { PATH, produce, TOKEN_ENV, URL_ENV, UsageError } from "../produce-http.mjs";

const TOKEN = "TEST_ONLY_not_a_real_secret_123";
let dir;
let file;
let server;
let base;
let behaviour;
const seen = [];

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "lifecycle-produce-"));
  file = join(dir, "events.ndjson");
  writeFileSync(file, toNdjson(generate({ seed: "p", events: 600, profile: "clean" }).records));
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      seen.push({
        url: req.url,
        auth: req.headers.authorization,
        body: body ? JSON.parse(body) : null,
      });
      behaviour(req, res);
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const opts = (extra = {}) => ({
  file,
  app: "app_talent",
  send: true,
  limit: 120,
  includeInvalid: false,
  includeAppId: false,
  ...extra,
});
const env = (extra = {}) => ({ [TOKEN_ENV]: TOKEN, [URL_ENV]: base, ...extra });
const run = async (o, e = env()) => {
  const out = [];
  const result = await produce(o, { env: e, log: (s) => out.push(s), sleep: async () => {} });
  return { result, out: out.join("\n") };
};
const reply = (status, json) => (_req, res) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(json ?? {}));
};

test("dry run sends nothing and needs no credentials", async () => {
  seen.length = 0;
  const { result, out } = await run(opts({ send: false }), {});
  assert.equal(result.status, "dry-run");
  assert.match(out, /DRY RUN/);
  assert.equal(seen.length, 0);
});

test("refuses to send without a TEST_ONLY token or with a production-looking one", async () => {
  await assert.rejects(run(opts(), { [URL_ENV]: base }), UsageError);
  await assert.rejects(run(opts(), env({ [TOKEN_ENV]: "fdk_live_abc" })), /TEST_ONLY_/);
  await assert.rejects(run(opts(), { [TOKEN_ENV]: TOKEN }), /BASE_URL/);
});

test("refuses non-https remote URLs and embedded credentials", async () => {
  await assert.rejects(run(opts(), env({ [URL_ENV]: "http://example.com" })), /https/);
  await assert.rejects(
    run(opts(), env({ [URL_ENV]: "https://user:pw@example.com" })),
    /credentials/,
  );
});

test("an absent endpoint is reported as absent, never as success", async () => {
  behaviour = reply(404, { error: "not found" });
  seen.length = 0;
  const { result, out } = await run(opts());
  assert.equal(result.code, 3);
  assert.equal(result.status, "endpoint-absent");
  assert.match(out, /ENDPOINT NOT AVAILABLE/);
  assert.doesNotMatch(out, /accepted|answered 2xx/);
  assert.equal(seen.length, 1, "stops at the first batch");
});

test("sends app-scoped batches of at most 50 with the bearer token and no appId", async () => {
  behaviour = (req, res) =>
    reply(200, {
      accepted:
        JSON.parse(seen.at(-1).body ? JSON.stringify(seen.at(-1).body) : "{}").events?.length ?? 0,
      rejected: 0,
    })(req, res);
  seen.length = 0;
  const { result, out } = await run(opts());
  assert.equal(result.code, 0);
  assert.equal(seen.length, 3);
  for (const s of seen) {
    assert.equal(s.url, PATH);
    assert.equal(s.auth, `Bearer ${TOKEN}`);
    assert.ok(s.body.events.length <= 50);
    for (const e of s.body.events) {
      assert.equal(e.appId, undefined);
      assert.equal(e.process, "recruiting");
    }
  }
  assert.match(out, /accepted=120 rejected=0/);
  assert.match(out, /does not verify lifecycle semantics/);
  assert.ok(!out.includes(TOKEN), "token must never be printed");
});

test("--include-app-id keeps the field", async () => {
  behaviour = reply(200, {});
  seen.length = 0;
  await run(opts({ limit: 10, includeAppId: true }));
  assert.equal(seen[0].body.events[0].appId, "app_talent");
});

test("401 is a failure and never echoes the token", async () => {
  behaviour = reply(401, { error: TOKEN });
  const { result, out } = await run(opts());
  assert.equal(result.code, 1);
  assert.ok(!out.includes(TOKEN));
});

test("a 400 response body is truncated and redacted", async () => {
  behaviour = reply(400, { error: `bad ${TOKEN}` });
  const { result, out } = await run(opts());
  assert.equal(result.code, 1);
  assert.ok(!out.includes(TOKEN));
  assert.match(out, /HTTP 400/);
});

test("503 is retried with the same event ids, then succeeds", async () => {
  let n = 0;
  behaviour = (req, res) => (++n <= 2 ? reply(503, {})(req, res) : reply(200, {})(req, res));
  seen.length = 0;
  const { result } = await run(opts({ limit: 10 }));
  assert.equal(result.code, 0);
  assert.equal(seen.length, 3);
  assert.deepEqual(seen[0].body, seen[2].body);
});

test("unknown app has no events; invalid events are skipped unless asked for", async () => {
  await assert.rejects(run(opts({ app: "app_nobody" })), /no events/);
  const noisy = join(dir, "noisy.ndjson");
  writeFileSync(noisy, toNdjson(generate({ seed: "q", events: 600, profile: "hostile" }).records));
  behaviour = reply(200, {});
  seen.length = 0;
  await run(opts({ file: noisy, limit: 1000 }));
  const sentIds = seen.flatMap((s) => s.body.events.map((e) => e.eventId));
  assert.ok(sentIds.every((id) => typeof id === "string"));
});
