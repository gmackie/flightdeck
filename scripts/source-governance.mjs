#!/usr/bin/env node
/**
 * Manage an account-owned, gitignored source registry.
 * This command does not deploy, and never prints stored credentials.
 */
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";

const [action, id, parameter] = process.argv.slice(2).filter(x => x !== "--");
const base = ".flightdeck/";
const sourceFile = base + "sources.json";
const tokenFile = base + "source-tokens.json";
const hash = x => createHash("sha256").update(x).digest("hex");
const validId = x => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(x ?? "");
function usage() {
  console.log("Usage: pnpm source:govern -- <status|rotate:start|rotate:finish|disable|enable|consent> SOURCE_ID [true|false]");
  process.exit(1);
}
if (!action || !validId(id) || !existsSync(sourceFile) || !existsSync(tokenFile)) usage();
const sources = JSON.parse(readFileSync(sourceFile, "utf8"));
const tokens = JSON.parse(readFileSync(tokenFile, "utf8"));
if (!Object.prototype.hasOwnProperty.call(sources, id) || !sources[id]) {
  console.error("Unknown source: " + id);
  process.exit(1);
}
const source = sources[id];
switch (action) {
  case "status":
    console.log(JSON.stringify({
      sourceId:id,projectId:source.projectId,enabled:source.enabled !== false,
      rotationPending:!!tokens[id + ":pending"],
      consentRequired:source.consentRequired === true,
      allowedEvents:source.allowedEvents,allowedEnvironments:source.allowedEnvironments
    },null,2));
    process.exit(0);
  case "rotate:start": {
    if (tokens[id + ":pending"]) throw new Error("Rotation already pending");
    const token = randomBytes(32).toString("base64url");
    source.rotatingSha256 = [hash(token)];
    tokens[id + ":pending"] = token;
    console.log("Generated new source credential for " + id + ": " + token);
    console.log("Next: deploy the source registry secret; update consuming Workers; then rotate:finish.");
    break;
  }
  case "rotate:finish": {
    const next = tokens[id + ":pending"];
    if (typeof next !== "string" || !source.rotatingSha256?.includes(hash(next)))
      throw new Error("No matching pending rotation found");
    source.sha256 = hash(next);
    source.rotatingSha256 = [];
    tokens[id] = next;
    delete tokens[id + ":pending"];
    console.log("Rotation promoted; deploy registry secret again to revoke previous token.");
    break;
  }
  case "disable":
    source.enabled = false;
    console.log("Source disabled locally; deploy registry secret to activate.");
    break;
  case "enable":
    source.enabled = true;
    console.log("Source enabled locally; deploy registry secret to activate.");
    break;
  case "consent":
    if (parameter !== "true" && parameter !== "false") usage();
    source.consentRequired = parameter === "true";
    console.log("Consent policy modified locally; deploy registry secret.");
    break;
  default: usage();
}
writeFileSync(sourceFile, JSON.stringify(sources,null,2)+"\n", {mode:0o600});
writeFileSync(tokenFile, JSON.stringify(tokens,null,2)+"\n", {mode:0o600});
chmodSync(sourceFile,0o600);chmodSync(tokenFile,0o600);
console.log("Deploy: pnpm exec wrangler secret put SOURCE_CREDENTIALS --config apps/core/wrangler.generated.jsonc");
