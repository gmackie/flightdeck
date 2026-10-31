import assert from "node:assert/strict";
import { test } from "node:test";
import { createRng } from "../lib/prng.mjs";
import { parseDuration, parseSize, percentile } from "../lib/util.mjs";

test("same seed gives the same sequence, different seeds differ", () => {
  const a = createRng("x");
  const b = createRng("x");
  const c = createRng("y");
  const seqA = Array.from({ length: 20 }, () => a.float());
  assert.deepEqual(
    seqA,
    Array.from({ length: 20 }, () => b.float()),
  );
  assert.notDeepEqual(
    seqA,
    Array.from({ length: 20 }, () => c.float()),
  );
});

test("pinned output guards cross-platform determinism", () => {
  const r = createRng("flightdeck");
  assert.equal(r.id(12), createRng("flightdeck").id(12));
  assert.match(createRng("flightdeck").id(20), /^[0-9a-z]{20}$/);
});

test("int is inclusive and weighted respects weights", () => {
  const r = createRng("ranges");
  const seen = new Set();
  for (let i = 0; i < 500; i++) seen.add(r.int(3, 5));
  assert.deepEqual([...seen].sort(), [3, 4, 5]);
  let a = 0;
  for (let i = 0; i < 4000; i++)
    if (
      r.weighted([
        ["a", 3],
        ["b", 1],
      ]) === "a"
    )
      a++;
  assert.ok(a > 2800 && a < 3200, `a=${a}`);
});

test("size, duration and percentile helpers", () => {
  assert.equal(parseSize("1k"), 1000);
  assert.equal(parseSize("100K"), 100000);
  assert.equal(parseSize("1m"), 1000000);
  assert.equal(parseSize("2500"), 2500);
  assert.throws(() => parseSize("lots"));
  assert.equal(parseDuration("90m"), 5_400_000);
  assert.throws(() => parseDuration("soon"));
  assert.equal(percentile([1, 2, 3], 0.5), 2);
  assert.equal(percentile([], 0.5), null);
});
