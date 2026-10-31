import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { baselineFailures, reduceAll } from "../lib/check.mjs";
import { coverage, missing } from "../lib/coverage.mjs";
import { generate, PROFILES } from "../lib/generate.mjs";
import { GOLDEN_CONFIG, goldenDigest, sha256, toNdjson } from "../lib/golden.mjs";
import { ID_RE } from "../lib/model.mjs";
import { summarize } from "../lib/reduce.mjs";
import { parseIso } from "../lib/util.mjs";
import { reduceGenerated, shuffled } from "./helpers.mjs";

const GOLDEN_FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "golden.json");

test("same seed is byte-identical; a different seed is not", () => {
  const a = toNdjson(generate({ seed: "s", events: 400 }).records);
  assert.equal(a, toNdjson(generate({ seed: "s", events: 400 }).records));
  assert.notEqual(sha256(a), sha256(toNdjson(generate({ seed: "t", events: 400 }).records)));
});

test("the 1k golden digest has not drifted", () => {
  assert.deepEqual(goldenDigest(), JSON.parse(readFileSync(GOLDEN_FILE, "utf8")));
});

for (const profile of Object.keys(PROFILES)) {
  for (const seed of ["alpha", "beta"]) {
    test(`ground truth equals what the reducer derives (${profile}, seed ${seed})`, () => {
      const g = generate({ seed, events: 1500, profile });
      const { red, summary } = reduceGenerated(g);
      assert.deepEqual(baselineFailures(red), []);
      assert.deepEqual(red.totals, g.truth.totals);
      assert.deepEqual(summary, g.truth.apps);
      // Entity-level truth, not just aggregates.
      assert.deepEqual(
        JSON.parse(JSON.stringify(red.entities)),
        JSON.parse(JSON.stringify(g.entities)),
      );
    });
  }
}

test("clean profile has no noise; default and hostile do", () => {
  const clean = generate({ seed: "n", events: 1500, profile: "clean" }).truth.totals;
  assert.equal(clean.invalid.count, 0);
  assert.equal(clean.duplicateDeliveries, 0);
  assert.equal(clean.corrections, 0);
  const hostile = generate({ seed: "n", events: 1500, profile: "hostile" }).truth.totals;
  assert.ok(
    hostile.invalid.count > 0 && hostile.duplicateDeliveries > 0 && hostile.corrections > 0,
  );
});

test("the golden 1k dataset exercises every required behaviour", () => {
  const g = generate(GOLDEN_CONFIG);
  const { red, summary } = reduceGenerated(g);
  const cov = coverage(g.records, red, summary);
  assert.deepEqual(missing(cov), []);
  assert.equal(cov.processes, 3);
});

test("a larger dataset keeps the invariants and the coverage", () => {
  const g = generate({ seed: "big", events: 30000 });
  const { red, summary } = reduceGenerated(g);
  assert.deepEqual(baselineFailures(red), []);
  assert.deepEqual(summary, g.truth.apps);
  assert.deepEqual(missing(coverage(g.records, red, summary)), []);
  assert.ok(g.records.length > 30000);
});

test("size scales roughly with the request", () => {
  const small = generate({ seed: "z", events: 1000 }).records.length;
  const large = generate({ seed: "z", events: 10000 }).records.length;
  assert.ok(large > small * 7 && large < small * 14, `${small} -> ${large}`);
});

test("ids are opaque, valid and unique within an app", () => {
  const g = generate({ seed: "ids", events: 2000, profile: "clean" });
  const perApp = new Map();
  for (const { event: e } of g.records) {
    assert.match(e.eventId, ID_RE);
    assert.match(e.entity.id, ID_RE);
    assert.ok(!/headcount|candidate|ticket|service|rollout/i.test(e.eventId + e.entity.id));
    const s = perApp.get(e.appId) ?? new Set();
    assert.ok(!s.has(e.eventId), "event id reused within an app");
    s.add(e.eventId);
    perApp.set(e.appId, s);
  }
});

test("occurredAt is non-decreasing in version order and delivery follows receivedAt", () => {
  const g = generate({ seed: "ord", events: 2000 });
  let last = 0;
  for (const r of g.records) {
    const t = parseIso(r.receivedAt);
    assert.ok(t >= last);
    last = t;
  }
  const red = reduceAll(g.records, { asOf: parseIso(g.truth.asOf) });
  assert.equal(red.violations.filter((v) => v.code === "time_regression").length, 0);
});

test("the default apps cover three processes; a mixed app can run all three", () => {
  const g = generate({
    seed: "mix",
    events: 3000,
    apps: [
      {
        appId: "app_all_in_one",
        processes: ["recruiting", "service_delivery", "incident_response"],
      },
    ],
  });
  assert.deepEqual(g.truth.apps.app_all_in_one.processes, [
    "incident_response",
    "recruiting",
    "service_delivery",
  ]);
  assert.deepEqual(baselineFailures(reduceGenerated(g).red), []);
});

test("apps sharing an id seed reuse ids without interference; distinctIds avoids it", () => {
  const shared = generate({ seed: "scope", events: 3000, profile: "clean" });
  const ids = new Map();
  for (const { event: e } of shared.records)
    ids.set(e.eventId, (ids.get(e.eventId) ?? new Set()).add(e.appId));
  assert.ok(
    [...ids.values()].filter((s) => s.size > 1).length > 100,
    "expected cross-app eventId reuse",
  );

  const { red, summary } = reduceGenerated(shared);
  assert.equal(
    red.totals.duplicateDeliveries,
    0,
    "cross-app id reuse must not look like duplicates",
  );
  assert.equal(red.totals.duplicateConflicts, 0);
  for (const appId of Object.keys(summary)) {
    const alone = reduceAll(
      shared.records.filter((r) => r.event.appId === appId),
      { asOf: red.asOf },
    );
    assert.deepEqual(summarize(alone.entities, red.asOf)[appId], summary[appId], appId);
  }

  const distinct = generate({ seed: "scope", events: 3000, profile: "clean", distinctIds: true });
  const seen = new Map();
  for (const { event: e } of distinct.records)
    seen.set(e.eventId, (seen.get(e.eventId) ?? new Set()).add(e.appId));
  assert.equal([...seen.values()].filter((s) => s.size > 1).length, 0);
});

test("delivery order does not change the result (shuffled hostile stream)", () => {
  const g = generate({ seed: "shuf", events: 2500, profile: "hostile" });
  const asOf = parseIso(g.truth.asOf);
  const base = reduceAll(g.records, { asOf });
  const alt = reduceAll(shuffled(g.records, "k"), { asOf });
  assert.deepEqual(alt.totals, base.totals);
  assert.deepEqual(alt.entities, base.entities);
});

test("rejects unknown processes and profiles", () => {
  assert.throws(() =>
    generate({ seed: "x", events: 10, apps: [{ appId: "app_bad_one", processes: ["alchemy"] }] }),
  );
  assert.throws(() => generate({ seed: "x", events: 10, profile: "nope" }));
});
