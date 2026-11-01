// Builds a throwaway repository tree that satisfies every static integration gate, so each test
// can break exactly one thing. Nothing here touches the network or the real repository.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadManifest } from "../lib/preflight.mjs";

export const REPO = join(dirname(fileURLToPath(import.meta.url)), "../../..");
export const CLI = join(REPO, "scripts/lifecycle-preflight.mjs");
export const FIXTURE_CONFIG = join(
  REPO,
  "scripts/lifecycle-preflight/fixtures/synthetic-staging.json",
);
export const manifest = loadManifest();
export const sqlite = await import("node:sqlite");
export const HEAD = "a".repeat(40);
export const NOW = new Date("2026-11-01T12:00:00Z");

const FLIGHTDECK_WRANGLER = `{
  // comments and trailing commas, as in the real file
  "name": "flightdeck",
  "pipelines": [
    { "binding": "EVENTS", "stream": "x" },
    // { "binding": "LIFECYCLE_EVENTS", "stream": "<id>" }
  ],
  "vars": {
    "ACCESS_AUD": "",
    "LIFECYCLE_MCP_READ_ENABLED": "0",
    "LIFECYCLE_MCP_ACCESS_AUD": "",
    "READ_AUTHZ_MODE": "legacy",
    "FLIGHTDECK_DEV": "0",
  },
}`;

const MCP_WRANGLER = `{
  "name": "flightdeck-lifecycle-mcp",
  "workers_dev": false,
  "preview_urls": false,
  // "services": [{ "binding": "LIFECYCLE_READ_API", "service": "flightdeck", "entrypoint": "LifecycleReadEntrypoint" }],
  "vars": {
    "LIFECYCLE_MCP_ENVIRONMENT": "production",
    "LIFECYCLE_MCP_SOURCE": "disabled",
    "ACCESS_AUD": "",
    "LIFECYCLE_MCP_MIN_COHORT": "5",
    "LIFECYCLE_MCP_DEV": "0"
  }
}`;

export function makeRepo(overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), "fd-preflight-repo-"));
  const files = {
    "package.json": JSON.stringify({ packageManager: "pnpm@12.14.0" }),
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    "apps/flightdeck/wrangler.jsonc": FLIGHTDECK_WRANGLER,
    "apps/lifecycle-mcp/wrangler.jsonc": MCP_WRANGLER,
    "apps/lifecycle-mcp/src/config.ts":
      "export const PRODUCTION_ENABLED = false;\nexport const MIN_COHORT_FLOOR = 5;\n",
    "apps/lifecycle-mcp/src/worker.ts": "// Modern (2026-07-28) stateless protocol only\n",
    "apps/lifecycle-mcp/package.json": JSON.stringify({
      dependencies: { "@modelcontextprotocol/server": "2.4.0" },
      devDependencies: { "@modelcontextprotocol/client": "2.4.0" },
    }),
    "apps/flightdeck/src/index.ts":
      'export { LifecycleReadEntrypoint } from "./lifecycle-mcp/entrypoint";\n',
    "apps/flightdeck/src/lifecycle-mcp/entrypoint.ts":
      "if (!env.LIFECYCLE_MCP_ACCESS_AUD?.trim() ||\n  env.LIFECYCLE_MCP_ACCESS_AUD.trim() === env.ACCESS_AUD.trim()) throw new Error();\n",
    "apps/flightdeck/pipelines/lifecycle_events.schema.json": JSON.stringify({
      fields: manifest.pipelineSchema.requiredFields.map((name) => ({ name, type: "string" })),
    }),
    "packages/lifecycle-queries/dist/index.js": basinModule("SELECT case_id FROM facts"),
  };
  for (const m of manifest.migrations.required) {
    files[`apps/flightdeck/migrations/${m.name}.sql`] = `CREATE TABLE t_${m.name} (id INTEGER);\n`;
  }
  for (const c of manifest.components) mkdirSync(join(root, c.path), { recursive: true });
  for (const [path, content] of Object.entries({ ...files, ...overrides })) {
    const full = join(root, path);
    if (content === null) {
      rmSync(full, { force: true, recursive: true });
      continue;
    }
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

export function basinModule(sql) {
  return `export const demoQuery = {}; export const demoRegistry = {};
export function buildBasinSql() { return { sql: ${JSON.stringify(sql)}, maxRows: 10 }; }\n`;
}

/** Every allowlisted command, reported as passed (tests never run real commands). */
export function allCommandsPassed() {
  const ids = manifest.gates.flatMap((g) => g.commands ?? []);
  return Object.fromEntries(ids.map((id) => [id, { status: "passed", exitCode: 0 }]));
}

export const git = { head: HEAD, trackedFiles: ["package.json"] };

export function stagingConfig(extra = {}) {
  return {
    kind: "flightdeck-lifecycle-preflight-config",
    version: 1,
    environment: "staging",
    hostnames: { dashboard: "flightdeck.corp.example.net", mcp: "mcp.corp.example.net" },
    access: {
      teamDomain: "team.example.net",
      dashboardAud: "d".repeat(64),
      mcpAud: "e".repeat(64),
    },
    services: [
      {
        binding: "LIFECYCLE_READ_API",
        service: "flightdeck",
        entrypoint: "LifecycleReadEntrypoint",
      },
    ],
    ...extra,
  };
}

export function attestation(gateId, extra = {}) {
  const gate = manifest.gates.find((g) => g.id === gateId);
  return {
    kind: "flightdeck-lifecycle-attestation",
    version: 1,
    gate: gateId,
    environment: "staging",
    commit: HEAD,
    verifiedAt: "2026-10-30T10:00:00Z",
    verifiedBy: "release-operator",
    method: "Manual staging verification following the release-gate checklist.",
    synthetic: false,
    checks: Object.fromEntries(gate.attestation.checks.map((c) => [c, true])),
    ...Object.fromEntries((gate.attestation.fields ?? []).map((f) => [f, "spark-3.5"])),
    ...extra,
  };
}
