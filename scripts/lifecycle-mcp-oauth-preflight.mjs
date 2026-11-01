#!/usr/bin/env node
// Node >=24: native TypeScript stripping. Offline only; never fetches or writes account config.
import { readFile } from "node:fs/promises";
import { inspectCapture } from "../apps/lifecycle-mcp/src/oauth-preflight.ts";

try {
  if (process.argv.length !== 3) throw new Error("usage");
  const raw = await readFile(process.argv[2], "utf8");
  if (raw.length > 64_000) throw new Error("oversize");
  const result = inspectCapture(JSON.parse(raw));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  // Always nonzero: public captures cannot prove consent, attenuation or edge token security.
  process.exitCode = 2;
} catch {
  // Never print input, token-bearing JSON, filename contents or exception messages.
  process.stderr.write("Invalid preflight capture. Supply one redacted public JSON file <=64KB.\n");
  process.exitCode = 1;
}
