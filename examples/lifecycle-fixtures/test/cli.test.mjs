import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { before, test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = (...args) =>
  spawnSync(process.execPath, [join(ROOT, "cli.mjs"), ...args], { encoding: "utf8" });
let out;

before(() => {
  out = join(mkdtempSync(join(tmpdir(), "lifecycle-cli-")), "ds");
});

test("generate then validate round-trips (1k, with scope and coverage)", () => {
  const g = cli("generate", "--seed", "cli", "--size", "1k", "--out", out, "--detail");
  assert.equal(g.status, 0, g.stderr);
  const v = cli("validate", out, "--scope", "--coverage");
  assert.equal(v.status, 0, v.stdout + v.stderr);
  assert.match(v.stdout, /PASS/);
  assert.match(v.stdout, /isolated=true/);
  assert.match(v.stdout, /0 violations/);
});

test("generation is reproducible: same flags, same events hash", () => {
  const a = join(out, "..", "a");
  const b = join(out, "..", "b");
  cli("generate", "--seed", "rep", "--size", "1k", "--out", a);
  cli("generate", "--seed", "rep", "--size", "1k", "--out", b);
  const hash = (d) => JSON.parse(readFileSync(join(d, "manifest.json"), "utf8")).eventsSha256;
  assert.equal(hash(a), hash(b));
  assert.equal(
    readFileSync(join(a, "expected.json"), "utf8"),
    readFileSync(join(b, "expected.json"), "utf8"),
  );
});

test("validate fails when expected truth is wrong", () => {
  const expectedPath = join(out, "expected.json");
  const expected = JSON.parse(readFileSync(expectedPath, "utf8"));
  const app = Object.keys(expected.apps)[0];
  const kind = Object.keys(expected.apps[app].entities)[0];
  expected.apps[app].entities[kind].total += 1;
  const bad = join(out, "bad-expected.json");
  writeFileSync(bad, JSON.stringify(expected));
  const v = cli("validate", out, "--expected", bad);
  assert.equal(v.status, 1);
  assert.match(v.stderr, /FAIL/);
  assert.match(v.stderr, /total/);
});

test("validate fails on a stream that violates invariants", () => {
  const lines = readFileSync(join(out, "events.ndjson"), "utf8").trim().split("\n");
  const closed = lines.findIndex(
    (l) => l.includes('"type":"entity.closed"') && !l.includes("corrects"),
  );
  assert.ok(closed > 0);
  const broken = join(out, "..", "broken.ndjson");
  writeFileSync(broken, `${lines.filter((_, i) => i !== closed).join("\n")}\n`);
  const v = cli("validate", broken);
  assert.equal(v.status, 1, v.stdout);
});

test("committed fixtures validate", () => {
  const v = cli("validate", "--fixtures");
  assert.equal(v.status, 0, v.stdout + v.stderr);
  const f = cli("fixtures", "--check");
  assert.equal(f.status, 0, f.stdout + f.stderr);
});

test("simulate reports lateness, convergence and scope", () => {
  const s = cli(
    "simulate",
    join(out, "events.ndjson"),
    "--late-after",
    "30m",
    "--checkpoints",
    "4",
  );
  assert.equal(s.status, 0, s.stdout + s.stderr);
  assert.match(s.stdout, /late \(>/);
  assert.match(s.stdout, /final checkpoint converged: true/);
  assert.match(s.stdout, /isolated=true/);
});

test("bad usage exits 2 with a message", () => {
  assert.equal(cli("nope").status, 2);
  assert.equal(cli("generate").status, 2);
  assert.equal(cli("generate", "--seed", "x", "--size", "lots").status, 2);
  assert.equal(cli("validate").status, 2);
});

test("producer CLI is a dry run unless --send, and refuses tokens on argv", () => {
  const p = spawnSync(
    process.execPath,
    [
      join(ROOT, "produce-http.mjs"),
      join(out, "events.ndjson"),
      "--app",
      "app_talent",
      "--limit",
      "60",
    ],
    { encoding: "utf8" },
  );
  assert.equal(p.status, 0, p.stderr);
  assert.match(p.stdout, /DRY RUN/);
  const t = spawnSync(
    process.execPath,
    [
      join(ROOT, "produce-http.mjs"),
      join(out, "events.ndjson"),
      "--app",
      "app_talent",
      "--token",
      "x",
    ],
    { encoding: "utf8" },
  );
  assert.equal(t.status, 2);
  assert.match(t.stderr, /never accepted on the command line/);
});
