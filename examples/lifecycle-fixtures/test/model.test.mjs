import assert from "node:assert/strict";
import { test } from "node:test";
import { createContext } from "../lib/builder.mjs";
import { breakEvent } from "../lib/generate.mjs";
import { INVALID_REASONS, validateEvent } from "../lib/model.mjs";
import { createRng } from "../lib/prng.mjs";
import { buildScenarios } from "../lib/scenarios.mjs";

const sample = () => {
  const sc = buildScenarios().find((s) => s.name === "recruiting-pipeline");
  const byType = (t) => sc.records.map((r) => r.event).find((e) => e.type === t);
  return {
    opened: byType("entity.opened"),
    entered: byType("stage.entered"),
    exited: byType("stage.exited"),
    closed: byType("entity.closed"),
  };
};

test("well-formed events of every type validate", () => {
  for (const e of Object.values(sample())) assert.equal(validateEvent(e), null, e.type);
});

test("each injector yields exactly its reason (orphan is stream-level)", () => {
  const s = sample();
  const ctx = createContext({ appId: "app_x_test", process: "recruiting", idSeed: "t" });
  const rng = createRng("inject");
  const from = {
    missing_stage: s.entered,
    unknown_stage: s.entered,
    missing_outcome: s.exited,
    unknown_outcome: s.exited,
    orphan_stage_exit: s.exited,
    self_relation: s.opened,
  };
  for (const reason of INVALID_REASONS) {
    if (reason === "not_an_object") {
      assert.equal(validateEvent("garbage"), reason);
      continue;
    }
    const broken = breakEvent(reason, from[reason] ?? s.closed, rng, ctx);
    const expected = reason === "orphan_stage_exit" ? null : reason;
    assert.equal(validateEvent(broken), expected, reason);
  }
});

test("outcome vocabularies are enforced per kind", () => {
  const { closed, exited } = sample();
  assert.equal(validateEvent({ ...closed, outcome: "pass" }), "unknown_outcome"); // an assessment outcome on a candidate
  assert.equal(validateEvent({ ...exited, outcome: "hired" }), "unknown_outcome");
  assert.equal(
    validateEvent({ ...closed, entity: { kind: "candidate", id: closed.entity.id } }),
    null,
  );
});

test("ids must be opaque-safe and timestamps strict ISO", () => {
  const { closed } = sample();
  assert.equal(validateEvent({ ...closed, eventId: "short" }), "bad_event_id_format");
  assert.equal(
    validateEvent({ ...closed, occurredAt: "2026-02-30T00:00:00.000Z" }),
    "bad_occurred_at",
  );
  assert.equal(validateEvent({ ...closed, occurredAt: "2026-02-03T00:00:00Z" }), "bad_occurred_at");
  assert.equal(validateEvent({ ...closed, version: 2.5 }), "bad_version");
});
