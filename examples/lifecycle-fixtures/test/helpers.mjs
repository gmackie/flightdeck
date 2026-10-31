import { reduceAll } from "../lib/check.mjs";
import { createRng } from "../lib/prng.mjs";
import { summarize } from "../lib/reduce.mjs";
import { parseIso } from "../lib/util.mjs";

/** Reduce a generated dataset the way a consumer of `events.ndjson` would. */
export function reduceGenerated(g) {
  const red = reduceAll(g.records, { asOf: parseIso(g.truth.asOf) });
  return { red, summary: summarize(red.entities, red.asOf) };
}

export function shuffled(items, seed) {
  const rng = createRng(seed);
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
