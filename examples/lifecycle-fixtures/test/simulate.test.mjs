import assert from "node:assert/strict";
import { test } from "node:test";
import { generate } from "../lib/generate.mjs";
import { checkpointReport, deliveryReport, scopeReport } from "../lib/simulate.mjs";
import { HOUR, parseIso } from "../lib/util.mjs";

test("delivery lag: default profile has late and out-of-order events, clean has none late", () => {
  const d = deliveryReport(generate({ seed: "lag", events: 3000 }).records);
  assert.ok(d.lateEvents > 0 && d.lagMs.p99 > HOUR);
  assert.ok(d.outOfOrderDeliveries > 0 && d.outOfOrderEntities > 0);
  assert.ok(d.lagMs.p50 < 5000, "most events arrive promptly");

  const c = deliveryReport(generate({ seed: "lag", events: 3000, profile: "clean" }).records);
  assert.equal(c.lateEvents, 0);
});

test("late events make the delivery view lag the occurrence view, then converge", () => {
  const g = generate({ seed: "ckpt", events: 3000, profile: "hostile" });
  const rows = checkpointReport(g.records, { checkpoints: 5 });
  assert.equal(rows.length, 5);
  assert.ok(
    rows.some((r) => r.eventsStillInFlight > 0),
    "some events are still in flight at an intermediate checkpoint",
  );
  assert.ok(
    rows.some((r) => r.entitiesWithVersionGaps > 0),
    "late events leave version gaps at some checkpoint",
  );
  const last = rows.at(-1);
  assert.equal(last.eventsStillInFlight, 0);
  assert.equal(last.closedByDelivery, last.closedByOccurrence);
  assert.equal(last.entitiesByDelivery, last.entitiesByOccurrence);
  assert.ok(parseIso(last.at) > parseIso(rows[0].at));
});

test("scope report sees reused ids and proves isolation", () => {
  const s = scopeReport(generate({ seed: "sc", events: 2000 }).records);
  assert.equal(s.apps.length, 3);
  assert.ok(s.eventIdsSharedAcrossApps > 0 && s.entityIdsSharedAcrossApps > 0);
  assert.equal(s.isolated, true);
});
