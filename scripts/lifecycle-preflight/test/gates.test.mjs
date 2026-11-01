import assert from "node:assert/strict";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { CHECKS } from "../lib/checks.mjs";
import { evaluate, verdicts } from "../lib/preflight.mjs";
import { inspectBasinSql } from "../lib/sql.mjs";
import {
  allCommandsPassed,
  attestation,
  basinModule,
  git,
  makeRepo,
  manifest,
  NOW,
  REPO,
  sqlite,
  stagingConfig,
} from "./helpers.mjs";

const run = (root, extra = {}) =>
  evaluate({ root, manifest, git, sqlite, now: NOW, nodeVersion: "v24.14.0", ...extra });
const gate = (report, id) => report.gates.find((g) => g.id === id);

describe("manifest", () => {
  it("validates and every gate has an implemented check", () => {
    for (const g of manifest.gates) assert.ok(CHECKS[g.check], g.id);
    assert.equal(new Set(manifest.gates.map((g) => g.id)).size, manifest.gates.length);
  });

  it("matches the migrations on current main exactly, with no duplicate numbers", () => {
    const files = readdirSync(join(REPO, manifest.migrations.dir))
      .filter((f) => f.endsWith(".sql"))
      .map((f) => f.replace(/\.sql$/, ""))
      .sort();
    assert.deepEqual(files, manifest.migrations.required.map((m) => m.name).sort());
    const numbers = files.map((f) => f.slice(0, 4));
    assert.equal(new Set(numbers).size, numbers.length);
  });
});

describe("current main (real repository)", () => {
  it("is never production-safe and never integration-ready without running commands", async () => {
    const report = await evaluate({ root: REPO, manifest, sqlite, now: NOW });
    assert.equal(report.verdicts["production-safe"].status, "blocked");
    assert.notEqual(report.verdicts["integration-ready"].status, "ready");
    assert.equal(gate(report, "source-completeness").status, "blocked");
    assert.equal(gate(report, "d1-migrations").status, "pass");
    assert.equal(gate(report, "flags-default-off").status, "pass");
  });
});

describe("integration-ready", () => {
  it("is ready only when every static gate passes and every command passed in this run", async () => {
    const root = makeRepo();
    const ready = await run(root, { commandResults: allCommandsPassed() });
    assert.deepEqual(
      ready.gates.filter((g) => g.requiredFor.includes("integration-ready") && g.status !== "pass"),
      [],
    );
    assert.equal(ready.verdicts["integration-ready"].status, "ready");
    assert.equal(ready.verdicts["production-safe"].status, "blocked");
  });

  it("is unknown, not ready, when commands were not run", async () => {
    const report = await run(makeRepo());
    assert.equal(gate(report, "local-quality").status, "unknown");
    assert.equal(report.verdicts["integration-ready"].status, "unknown");
  });

  it("is blocked when a command failed or its target is missing", async () => {
    const results = { ...allCommandsPassed(), test: { status: "failed", exitCode: 1 } };
    const failed = await run(makeRepo(), { commandResults: results });
    assert.equal(gate(failed, "local-quality").status, "blocked");
    assert.equal(failed.verdicts["integration-ready"].status, "blocked");
    const missing = {
      ...allCommandsPassed(),
      "mcp-acceptance": { status: "missing", reason: "x" },
    };
    const report = await run(makeRepo(), { commandResults: missing });
    assert.equal(gate(report, "two-domain-acceptance").status, "blocked");
  });

  it("is blocked when a lifecycle component is missing", async () => {
    const report = await run(makeRepo({ "apps/lifecycle-mcp": null }), {
      commandResults: allCommandsPassed(),
    });
    assert.equal(gate(report, "workspace-components").status, "blocked");
    assert.equal(report.verdicts["integration-ready"].status, "blocked");
  });

  it("blocks Node older than 24", async () => {
    const report = await run(makeRepo(), { nodeVersion: "v22.1.0" });
    assert.equal(gate(report, "workspace-components").status, "blocked");
  });
});

describe("d1-migrations", () => {
  it("blocks ambiguous numeric prefixes", async () => {
    const root = makeRepo({
      "apps/flightdeck/migrations/0020_lifecycle_tombstones.sql": "SELECT 1;",
    });
    const g = gate(await run(root), "d1-migrations");
    assert.equal(g.status, "blocked");
    assert.match(g.reasons.join(" "), /ambiguous migration number 0020/);
  });

  it("blocks badly named, missing and unappliable migrations", async () => {
    const bad = makeRepo({ "apps/flightdeck/migrations/31_x.sql": "SELECT 1;" });
    assert.equal(gate(await run(bad), "d1-migrations").status, "blocked");
    const missing = makeRepo({ "apps/flightdeck/migrations/0030_lifecycle_projection.sql": null });
    assert.match(gate(await run(missing), "d1-migrations").reasons.join(), /missing required/);
    const broken = makeRepo({ "apps/flightdeck/migrations/0040_broken.sql": "CREATE TABL oops" });
    assert.match(gate(await run(broken), "d1-migrations").reasons.join(), /failed to apply/);
  });

  it("is unknown, not pass, without node:sqlite", async () => {
    assert.equal(gate(await run(makeRepo(), { sqlite: null }), "d1-migrations").status, "unknown");
  });
});

describe("flags-default-off", () => {
  const flightdeck = (vars) =>
    `{ "vars": { "ACCESS_AUD": "", "LIFECYCLE_MCP_ACCESS_AUD": "", ${vars} } }`;

  it("blocks a missing flag", async () => {
    const root = makeRepo({
      "apps/flightdeck/wrangler.jsonc": flightdeck(
        '"READ_AUTHZ_MODE": "legacy", "FLIGHTDECK_DEV": "0"',
      ),
    });
    const g = gate(await run(root), "flags-default-off");
    assert.equal(g.status, "blocked");
    assert.match(g.reasons.join(), /LIFECYCLE_MCP_READ_ENABLED missing/);
  });

  it("blocks invalid and non-default values", async () => {
    const root = makeRepo({
      "apps/flightdeck/wrangler.jsonc": flightdeck(
        '"READ_AUTHZ_MODE": "permissive", "FLIGHTDECK_DEV": "1", "LIFECYCLE_MCP_READ_ENABLED": "0"',
      ),
    });
    const reasons = gate(await run(root), "flags-default-off").reasons.join();
    assert.match(reasons, /READ_AUTHZ_MODE has an invalid value/);
    assert.match(reasons, /FLIGHTDECK_DEV is not its default-off value/);
  });

  it("blocks committed opt-in bindings and a flipped production switch", async () => {
    const root = makeRepo({
      "apps/lifecycle-mcp/wrangler.jsonc": JSON.stringify({
        workers_dev: false,
        preview_urls: false,
        services: [
          {
            binding: "LIFECYCLE_READ_API",
            service: "flightdeck",
            entrypoint: "LifecycleReadEntrypoint",
          },
        ],
        vars: {
          LIFECYCLE_MCP_ENVIRONMENT: "production",
          LIFECYCLE_MCP_SOURCE: "disabled",
          LIFECYCLE_MCP_MIN_COHORT: "5",
          LIFECYCLE_MCP_DEV: "0",
        },
      }),
      "apps/lifecycle-mcp/src/config.ts":
        "export const PRODUCTION_ENABLED = true;\nexport const MIN_COHORT_FLOOR = 5;",
    });
    const reasons = gate(await run(root), "flags-default-off").reasons.join();
    assert.match(reasons, /opt-in binding LIFECYCLE_READ_API is committed/);
    assert.match(reasons, /PRODUCTION_ENABLED is not literally false/);
  });

  it("blocks a missing or unparsable wrangler config", async () => {
    const root = makeRepo({ "apps/lifecycle-mcp/wrangler.jsonc": "{ not json" });
    assert.equal(gate(await run(root), "flags-default-off").status, "blocked");
  });
});

describe("Access audiences and RPC binding", () => {
  it("blocks an MCP AUD equal to the dashboard AUD without printing it", async () => {
    const aud = "f".repeat(64);
    const config = stagingConfig({
      access: { teamDomain: "t.example", dashboardAud: aud, mcpAud: aud },
    });
    const g = gate(await run(makeRepo(), { config }), "access-audiences");
    assert.equal(g.status, "blocked");
    assert.doesNotMatch(JSON.stringify(g), new RegExp(aud));
  });

  it("is unknown when AUDs are not provided, and blocks synthetic AUDs on staging", async () => {
    assert.equal(gate(await run(makeRepo()), "access-audiences").status, "unknown");
    const config = stagingConfig({
      access: { teamDomain: "t.example", dashboardAud: "synthetic-a", mcpAud: "synthetic-b" },
    });
    assert.equal(gate(await run(makeRepo(), { config }), "access-audiences").status, "blocked");
  });

  it("blocks a binding to an unknown service or entrypoint", async () => {
    const config = stagingConfig({
      services: [
        {
          binding: "LIFECYCLE_READ_API",
          service: "billing-prod",
          entrypoint: "LifecycleReadEntrypoint",
        },
      ],
    });
    assert.equal(gate(await run(makeRepo(), { config }), "rpc-service-binding").status, "blocked");
    const wrongEntry = stagingConfig({
      services: [{ binding: "LIFECYCLE_READ_API", service: "flightdeck", entrypoint: "Default" }],
    });
    assert.equal(
      gate(await run(makeRepo(), { config: wrongEntry }), "rpc-service-binding").status,
      "blocked",
    );
  });

  it("blocks the entrypoint gate when the audience guard is removed", async () => {
    const root = makeRepo({
      "apps/flightdeck/src/lifecycle-mcp/entrypoint.ts": "export class X {}",
    });
    assert.equal(gate(await run(root), "rpc-entrypoint").status, "blocked");
  });
});

describe("production gates", () => {
  it("blocks disabled retention", async () => {
    const config = stagingConfig({ retention: { enabled: false } });
    const g = gate(await run(makeRepo(), { config }), "d1-retention");
    assert.equal(g.status, "blocked");
    assert.match(g.reasons.join(), /retention is disabled/);
  });

  it("blocks zero budgets and unintegrated budget/erasure migrations", async () => {
    const config = stagingConfig({
      budgets: { perPrincipalDailyQueries: 0, perAppDailyQueries: 10, maxRowsPerQuery: 10 },
    });
    const report = await run(makeRepo(), { config });
    assert.match(gate(report, "query-budgets").reasons.join(), /must be positive/);
    assert.match(gate(report, "query-budgets").reasons.join(), /budget migration not integrated/);
    assert.match(gate(report, "d1-retention").reasons.join(), /erasure migration not integrated/);
  });

  it("blocks k below 5 in intended config", async () => {
    const config = stagingConfig({ privacy: { minCohort: 3 } });
    assert.equal(gate(await run(makeRepo(), { config }), "privacy-k-floor").status, "blocked");
  });

  it("leaves live gates unknown without attestations", async () => {
    const report = await run(makeRepo(), { config: stagingConfig() });
    for (const id of ["access-live", "oauth-live", "basin-provisioned", "erasure-certificate"]) {
      assert.equal(gate(report, id).status, "unknown", id);
    }
  });
});

describe("attestations", () => {
  const withAttestation = async (doc, id = "erasure-certificate") => {
    const root = makeRepo({ "evidence/a.json": JSON.stringify(doc) });
    const config = stagingConfig({ attestations: { [id]: "evidence/a.json" } });
    return gate(await run(root, { config }), id);
  };

  it("passes a fresh, complete, non-synthetic attestation for this commit", async () => {
    const g = await withAttestation(attestation("erasure-certificate"));
    assert.equal(g.status, "pass");
    assert.match(g.reasons.join(), /not independently verified/);
  });

  it("blocks synthetic, incomplete and future-dated attestations", async () => {
    assert.equal(
      (await withAttestation(attestation("erasure-certificate", { synthetic: true }))).status,
      "blocked",
    );
    const partial = attestation("erasure-certificate");
    partial.checks.snapshotsExpired = false;
    assert.equal((await withAttestation(partial)).status, "blocked");
    const noEngine = attestation("erasure-certificate");
    delete noEngine.engine;
    assert.equal((await withAttestation(noEngine)).status, "blocked");
    const future = attestation("erasure-certificate", { verifiedAt: "2027-01-01T00:00:00Z" });
    assert.equal((await withAttestation(future)).status, "blocked");
  });

  it("treats stale commits and old attestations as unknown, not pass", async () => {
    const stale = attestation("access-live", { commit: "b".repeat(40) });
    assert.equal((await withAttestation(stale, "access-live")).status, "unknown");
    const old = attestation("access-live", { verifiedAt: "2026-08-01T00:00:00Z" });
    assert.equal((await withAttestation(old, "access-live")).status, "unknown");
  });

  it("blocks attestations that carry secrets or escape the repository", async () => {
    const leaky = attestation("access-live", {
      method: "used token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.abc",
    });
    const g = await withAttestation(leaky, "access-live");
    assert.equal(g.status, "blocked");
    assert.doesNotMatch(JSON.stringify(g), /eyJhbGci/);
    const root = makeRepo();
    const config = stagingConfig({ attestations: { "access-live": "../outside.json" } });
    assert.equal(gate(await run(root, { config }), "access-live").status, "blocked");
  });
});

describe("production-safe verdict", () => {
  it("stays blocked on a fully attested staging config while PRODUCTION_ENABLED is false", async () => {
    const files = {};
    const attestations = {};
    for (const g of manifest.gates.filter((x) => x.check === "attestation")) {
      files[`evidence/${g.id}.json`] = JSON.stringify(attestation(g.id));
      attestations[g.id] = `evidence/${g.id}.json`;
    }
    const report = await run(makeRepo(files), {
      config: stagingConfig({ attestations }),
      commandResults: allCommandsPassed(),
    });
    assert.equal(report.verdicts["integration-ready"].status, "ready");
    assert.equal(report.verdicts["production-safe"].status, "blocked");
    assert.ok(report.verdicts["production-safe"].blocking.includes("source-completeness"));
  });

  it("requires every gate to pass and a staging config", () => {
    const all = manifest.gates.map((g) => ({
      id: g.id,
      requiredFor: g.requiredFor,
      status: "pass",
    }));
    assert.equal(verdicts(all, { environment: "staging" })["production-safe"].status, "ready");
    assert.equal(verdicts(all, { environment: "synthetic" })["production-safe"].status, "blocked");
    assert.equal(verdicts(all, null)["production-safe"].status, "blocked");
    const oneUnknown = all.map((g, i) => (i === all.length - 1 ? { ...g, status: "unknown" } : g));
    assert.equal(
      verdicts(oneUnknown, { environment: "staging" })["production-safe"].status,
      "unknown",
    );
    const weird = all.map((g, i) => (i === 0 ? { ...g, status: "skipped" } : g));
    assert.notEqual(
      verdicts(weird, { environment: "staging" })["integration-ready"].status,
      "ready",
    );
  });

  it("treats a crashing check as unknown", async () => {
    const report = await run(makeRepo({ "apps/lifecycle-mcp/package.json": "{ broken" }));
    assert.equal(gate(report, "mcp-protocol").status, "unknown");
  });
});

describe("Basin SQL", () => {
  it("accepts single read-only SELECT/WITH statements", () => {
    assert.deepEqual(inspectBasinSql("SELECT a FROM t WHERE b = 'DELETE me' -- UPDATE"), []);
    assert.deepEqual(
      inspectBasinSql("WITH x AS (SELECT 1) SELECT REPLACE(name, 'a', 'b') FROM x;"),
      [],
    );
    assert.deepEqual(inspectBasinSql('SELECT "update" FROM t /* DROP TABLE t */'), []);
  });

  it("flags DML, DDL and stacked statements", () => {
    assert.ok(
      inspectBasinSql("DELETE FROM facts WHERE case_id = 'c'").includes("unsupported:DELETE"),
    );
    assert.ok(
      inspectBasinSql("WITH x AS (SELECT 1) DELETE FROM facts").includes("unsupported:DELETE"),
    );
    assert.ok(inspectBasinSql("SELECT 1; DROP TABLE facts").includes("multiple-statements"));
    assert.ok(inspectBasinSql("MERGE INTO facts USING s ON true").includes("unsupported:MERGE"));
    assert.ok(inspectBasinSql("INSERT INTO t SELECT * FROM s").includes("unsupported:INSERT"));
    assert.ok(inspectBasinSql("UPDATE t SET a = 1").includes("unsupported:UPDATE"));
    assert.ok(inspectBasinSql("REPLACE INTO t VALUES (1)").includes("unsupported:REPLACE"));
    assert.deepEqual(inspectBasinSql("  "), ["empty"]);
  });

  it("blocks generated SQL with DML and is unknown when the package is not built", async () => {
    const dml = makeRepo({
      "packages/lifecycle-queries/dist/index.js": basinModule("DELETE FROM facts"),
    });
    assert.equal(gate(await run(dml), "basin-sql-readonly").status, "blocked");
    const unbuilt = makeRepo({ "packages/lifecycle-queries/dist": null });
    assert.equal(gate(await run(unbuilt), "basin-sql-readonly").status, "unknown");
    const root = makeRepo();
    writeFileSync(join(root, "packages/lifecycle-queries/dist/index.js"), basinModule("SELECT 1"));
    const sqlDir = makeRepo({ "apps/flightdeck/basin/purge.sql": "DELETE FROM lifecycle_events" });
    assert.equal(gate(await run(sqlDir), "basin-sql-readonly").status, "blocked");
  });
});
