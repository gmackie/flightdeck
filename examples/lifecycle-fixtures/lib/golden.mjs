// Pins the generator's output for one small configuration so unintended changes to it
// (different ids, timestamps, ordering) fail loudly instead of silently re-baselining fixtures.
import { createHash } from "node:crypto";
import { generate } from "./generate.mjs";

export const GOLDEN_CONFIG = { seed: "7", events: 1000, profile: "default" };

export const sha256 = (text) => createHash("sha256").update(text).digest("hex");

export const toNdjson = (records) => `${records.map((r) => JSON.stringify(r)).join("\n")}\n`;

export function goldenDigest() {
  const g = generate(GOLDEN_CONFIG);
  return {
    config: GOLDEN_CONFIG,
    deliveries: g.records.length,
    entities: g.entities.length,
    eventsSha256: sha256(toNdjson(g.records)),
    truthSha256: sha256(JSON.stringify(g.truth)),
  };
}
