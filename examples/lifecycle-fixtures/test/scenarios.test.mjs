import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkScenario, checkScenarioShape, reduceAll } from "../lib/check.mjs";
import { summarize } from "../lib/reduce.mjs";
import { buildScenarios } from "../lib/scenarios.mjs";
import { parseIso } from "../lib/util.mjs";
import { shuffled } from "./helpers.mjs";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "scenarios");
const files = readdirSync(DIR).filter((f) => f.endsWith(".json"));
const load = (f) => JSON.parse(readFileSync(join(DIR, f), "utf8"));

test("committed scenario files are exactly what the builders produce", () => {
  const built = buildScenarios();
  assert.deepEqual(files.sort(), built.map((s) => `${s.name}.json`).sort());
  for (const sc of built)
    assert.deepEqual(load(`${sc.name}.json`), JSON.parse(JSON.stringify(sc)), sc.name);
});

for (const f of files) {
  test(`scenario ${f} meets its hand-written expectations`, () => {
    const sc = load(f);
    assert.deepEqual(checkScenarioShape(sc, f), []);
    assert.deepEqual(checkScenario(sc), []);
  });
}

test("the scenarios together cover every required behaviour", () => {
  const covers = new Set(files.flatMap((f) => load(f).covers));
  for (const need of [
    "recruiting",
    "service_delivery",
    "incident_response",
    "concurrent",
    "long_dwell",
    "paused",
    "reopened",
    "repeated_assessment",
    "delayed_scorecard",
    "late_delivery",
    "out_of_order",
    "duplicate_event_id",
    "correction",
    "invalid",
    "pending_approval",
    "terminal:rejected",
    "terminal:withdrawn",
    "terminal:cancelled",
    "app_scope",
    "invariant_violations",
  ])
    assert.ok(covers.has(need), `no scenario covers ${need}`);
});

test("results do not depend on arrival order", () => {
  for (const f of files) {
    const sc = load(f);
    if (sc.name === "duplicate-id-conflict") continue; // first-delivery-wins is order dependent by definition
    const asOf = parseIso(sc.asOf);
    const base = reduceAll(sc.records, { asOf });
    for (const seed of ["a", "b", "c"]) {
      const alt = reduceAll(shuffled(sc.records, seed), { asOf });
      assert.deepEqual(alt.entities, base.entities, `${sc.name} entities (${seed})`);
      assert.deepEqual(alt.totals, base.totals, `${sc.name} totals (${seed})`);
      assert.deepEqual(summarize(alt.entities, asOf), summarize(base.entities, asOf));
    }
  }
});

test("a wrong expectation is reported, not silently accepted", () => {
  const sc = load("recruiting-pipeline.json");
  sc.expected.entities[0].outcome = "rejected";
  sc.expected.apps.app_talent.entities.candidate.total = 4;
  const failures = checkScenario(sc);
  assert.ok(
    failures.some((m) => m.includes("outcome")),
    failures.join("\n"),
  );
  assert.ok(
    failures.some((m) => m.includes("candidate.total")),
    failures.join("\n"),
  );
});

test("scenarios that must be clean report no invariant violations", () => {
  for (const f of files) {
    const sc = load(f);
    if (sc.name === "broken-state-machine") continue;
    const red = reduceAll(sc.records, { asOf: parseIso(sc.asOf) });
    assert.deepEqual(red.violations, [], sc.name);
  }
});

test("shape check rejects malformed fixtures", () => {
  const sc = load("incident-long-dwell-open.json");
  assert.ok(checkScenarioShape({ ...sc, schema: "x" }, "incident-long-dwell-open.json").length);
  assert.ok(checkScenarioShape(sc, "other.json").length);
  const reversed = { ...sc, records: [...sc.records].reverse() };
  assert.ok(
    checkScenarioShape(reversed, "incident-long-dwell-open.json").some((m) =>
      m.includes("delivered before"),
    ),
  );
});
