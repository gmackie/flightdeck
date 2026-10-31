// Verifies scenario fixtures and datasets against the reducer and the baseline invariants.

import { Reducer, summarize } from "./reduce.mjs";
import { SCENARIO_SCHEMA } from "./scenarios.mjs";
import { deliveryReport, scopeReport } from "./simulate.mjs";
import { diff, parseIso, subsetMismatches } from "./util.mjs";

export function reduceAll(records, opts) {
  const r = new Reducer();
  for (const rec of records) r.add(rec);
  return r.finish(opts);
}

/** Structural checks on a scenario file. Returns a list of problems. */
export function checkScenarioShape(sc, fileName) {
  const bad = [];
  if (sc?.schema !== SCENARIO_SCHEMA) bad.push(`schema must be ${SCENARIO_SCHEMA}`);
  if (typeof sc?.name !== "string" || (fileName && `${sc.name}.json` !== fileName)) {
    bad.push(`name must match file name (${fileName})`);
  }
  if (typeof sc?.description !== "string" || !sc.description) bad.push("description required");
  if (!Array.isArray(sc?.covers) || sc.covers.length === 0)
    bad.push("covers must be a non-empty array");
  if (Number.isNaN(parseIso(sc?.asOf))) bad.push("asOf must be an ISO timestamp");
  if (!Array.isArray(sc?.records) || sc.records.length === 0) bad.push("records required");
  else {
    let last = 0;
    sc.records.forEach((r, i) => {
      const t = parseIso(r?.receivedAt);
      if (Number.isNaN(t)) bad.push(`records[${i}].receivedAt invalid`);
      else if (t < last)
        bad.push(
          `records[${i}] is delivered before records[${i - 1}] (receivedAt must not decrease)`,
        );
      else last = t;
      if (!("event" in (r ?? {}))) bad.push(`records[${i}].event missing`);
    });
  }
  if (!sc?.expected || typeof sc.expected !== "object") bad.push("expected required");
  return bad;
}

/** Run one scenario; returns failure messages (empty when it passes). */
export function checkScenario(sc) {
  const failures = [];
  const red = reduceAll(sc.records, { asOf: parseIso(sc.asOf) });
  const summary = summarize(red.entities, red.asOf);
  const exp = sc.expected;

  const codes = [...new Set(red.violations.map((v) => v.code))].sort();
  const wantCodes = [...(exp.violations ?? [])].sort();
  if (JSON.stringify(codes) !== JSON.stringify(wantCodes)) {
    failures.push(`violations: expected [${wantCodes}], got [${codes}]`);
  }
  if (exp.totals) failures.push(...subsetMismatches(red.totals, exp.totals, "totals"));
  for (const want of exp.entities ?? []) {
    const hits = red.entities.filter(
      (e) => e.id === want.id && (!want.appId || e.appId === want.appId),
    );
    if (hits.length !== 1) failures.push(`entity ${want.id}: found ${hits.length}, expected 1`);
    else {
      const { appId: _scope, ...fields } = want;
      failures.push(...subsetMismatches(hits[0], fields, `entity ${want.id}`));
    }
  }
  if (exp.apps) failures.push(...subsetMismatches(summary, exp.apps, "apps"));
  if (exp.delivery)
    failures.push(...subsetMismatches(deliveryReport(sc.records), exp.delivery, "delivery"));
  if (exp.scope)
    failures.push(
      ...subsetMismatches(scopeReport(sc.records, { asOf: parseIso(sc.asOf) }), exp.scope, "scope"),
    );
  return failures;
}

/**
 * Baseline invariants for any dataset: a reduction with no violations and no unexplained rejects.
 * @param {ReturnType<Reducer["finish"]>} red
 */
export function baselineFailures(red) {
  const out = [];
  const byCode = {};
  for (const v of red.violations) byCode[v.code] = (byCode[v.code] ?? 0) + 1;
  for (const [code, n] of Object.entries(byCode)) {
    const sample = red.violations.find((v) => v.code === code);
    out.push(
      `invariant ${code} violated ${n}x (e.g. ${sample.appId} ${sample.kind}/${sample.id} v${sample.version} ${sample.detail})`,
    );
  }
  return out;
}

/** Compare a reduction with an expected-truth document. Returns difference lines. */
export function compareToExpected(red, expected) {
  const out = [];
  const summary = summarize(red.entities, red.asOf);
  out.push(...diff(red.totals, expected.totals, "totals"));
  out.push(...diff(summary, expected.apps, "apps"));
  if (expected.entities) out.push(...diff(red.entities, expected.entities, "entities", [], 10));
  return out;
}
