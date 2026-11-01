// Gate checks. Each returns { status: "pass" | "blocked" | "unknown", reasons: string[] }.
// Only "pass" is green. Anything the harness cannot see from local files (a Cloudflare account, a
// token, a deleted Iceberg file) stays "unknown" unless an operator attestation covers it, and
// even then only when the attestation names this commit, is fresh, and is not synthetic.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { findSecrets, fingerprint, isSyntheticHost, resolveInside } from "./safety.mjs";
import { isPlainObject, parseJsonc, validate } from "./schema.mjs";
import { inspectBasinSql } from "./sql.mjs";

const here = new URL("..", import.meta.url).pathname;
export const ATTESTATION_SCHEMA = JSON.parse(
  readFileSync(join(here, "attestation.schema.json"), "utf8"),
);
export const ATTESTATION_MAX_AGE_DAYS = 30;

const pass = (...reasons) => ({ status: "pass", reasons });
const blocked = (...reasons) => ({ status: "blocked", reasons });
const unknown = (...reasons) => ({ status: "unknown", reasons });

/** Worst status wins: blocked > unknown > pass. An empty list is unknown, never pass. */
export function combine(results) {
  if (results.length === 0) return unknown("nothing was checked");
  const reasons = results.flatMap((r) => r.reasons);
  if (results.some((r) => r.status === "blocked")) return { status: "blocked", reasons };
  if (results.some((r) => r.status !== "pass")) return { status: "unknown", reasons };
  return { status: "pass", reasons };
}

function readText(root, rel) {
  const full = join(root, rel);
  return existsSync(full) && statSync(full).isFile() ? readFileSync(full, "utf8") : null;
}

function readWrangler(root, rel) {
  const text = readText(root, rel);
  if (text === null) return { missing: true };
  try {
    return { config: parseJsonc(text) };
  } catch {
    return { invalid: true };
  }
}

export const CHECKS = {
  components({ root, manifest, nodeVersion }) {
    const results = [];
    const missing = manifest.components.filter((c) => !existsSync(join(root, c.path)));
    for (const c of missing) results.push(blocked(`missing ${c.path} (${c.owner})`));
    const pkg = JSON.parse(readText(root, "package.json") ?? "{}");
    if (!/^pnpm@\d+/.test(pkg.packageManager ?? "")) {
      results.push(blocked("package.json packageManager is not a pinned pnpm"));
    }
    if (!existsSync(join(root, "pnpm-lock.yaml"))) results.push(blocked("pnpm-lock.yaml missing"));
    const major = Number(String(nodeVersion).replace(/^v/, "").split(".")[0]);
    if (!(major >= 24)) results.push(blocked(`Node ${nodeVersion} is older than the required 24`));
    if (results.length === 0)
      results.push(pass(`${manifest.components.length} components present`));
    return combine(results);
  },

  migrations({ root, manifest, sqlite }) {
    const dir = join(root, manifest.migrations.dir);
    if (!existsSync(dir)) return blocked(`${manifest.migrations.dir} missing`);
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    const results = [];
    const byNumber = new Map();
    for (const file of files) {
      const match = /^(\d{4})_[a-z0-9_]+\.sql$/.exec(file);
      if (!match) {
        results.push(blocked(`${file}: name must be NNNN_snake_case.sql`));
        continue;
      }
      byNumber.set(match[1], [...(byNumber.get(match[1]) ?? []), file]);
    }
    for (const [number, names] of byNumber) {
      if (names.length > 1) {
        results.push(blocked(`ambiguous migration number ${number}: ${names.join(", ")}`));
      }
    }
    const names = files.map((f) => f.replace(/\.sql$/, ""));
    let last = -1;
    for (const req of manifest.migrations.required) {
      const at = names.indexOf(req.name);
      if (at === -1) results.push(blocked(`missing required migration ${req.name} (${req.owner})`));
      else if (at < last) results.push(blocked(`${req.name} sorts before an earlier requirement`));
      else last = at;
    }
    if (sqlite && results.every((r) => r.status === "pass")) {
      results.push(applyMigrations(sqlite, dir, files));
    } else if (!sqlite) {
      results.push(unknown("node:sqlite unavailable; migrations were not applied"));
    }
    if (results.length === 0) results.push(pass(`${files.length} migrations ordered and unique`));
    return combine(results);
  },

  flags({ root, manifest }) {
    const results = [];
    const files = new Map();
    for (const flag of manifest.flags) {
      if (!files.has(flag.file)) files.set(flag.file, readWrangler(root, flag.file));
      const file = files.get(flag.file);
      if (file.missing) {
        results.push(blocked(`${flag.file} missing`));
        continue;
      }
      if (file.invalid) {
        results.push(blocked(`${flag.file} is not valid JSONC`));
        continue;
      }
      const value = file.config.vars?.[flag.name];
      if (value === undefined) results.push(blocked(`${flag.name} missing from ${flag.file}`));
      else if (!flag.allowed.includes(value))
        results.push(blocked(`${flag.name} has an invalid value`));
      else if (value !== flag.default)
        results.push(blocked(`${flag.name} is not its default-off value`));
    }
    for (const opt of manifest.optInBindings ?? []) {
      const file = files.get(opt.file) ?? readWrangler(root, opt.file);
      const entries = file.config?.[opt.section] ?? [];
      if (Array.isArray(entries) && entries.some((e) => e?.binding === opt.binding)) {
        results.push(blocked(`opt-in binding ${opt.binding} is committed in ${opt.file}`));
      }
    }
    const switchText = readText(root, manifest.mcp.productionSwitch);
    if (switchText === null) results.push(blocked(`${manifest.mcp.productionSwitch} missing`));
    else if (!/export const PRODUCTION_ENABLED\s*=\s*false\s*;/.test(switchText)) {
      results.push(blocked("PRODUCTION_ENABLED is not literally false"));
    }
    if (results.length === 0) results.push(pass(`${manifest.flags.length} flags at default-off`));
    return combine(results);
  },

  committedSecrets({ root, manifest, trackedFiles }) {
    const results = [];
    for (const file of new Set(manifest.flags.map((f) => f.file))) {
      const parsed = readWrangler(root, file);
      if (parsed.config) {
        for (const at of findSecrets(parsed.config.vars ?? {}, { path: `${file}#vars` })) {
          results.push(blocked(`secret-like value at ${at}`));
        }
      }
    }
    if (trackedFiles === null) {
      results.push(unknown("git ls-files unavailable; tracked .dev.vars/.env not checked"));
    } else {
      for (const f of trackedFiles) {
        const base = f.split("/").pop();
        if (/^\.dev\.vars/.test(base) || (/^\.env/.test(base) && !/\.example$/.test(base))) {
          results.push(blocked(`tracked secrets file ${f}`));
        }
      }
    }
    if (results.length === 0) results.push(pass("no secret-like committed values"));
    return combine(results);
  },

  rpcEntrypoint({ root, manifest }) {
    const { rpc, mcp } = manifest;
    const results = [];
    const exports = readText(root, rpc.exportFile);
    if (exports === null) results.push(blocked(`${rpc.exportFile} missing`));
    else if (!new RegExp(`export\\s*\\{[^}]*\\b${rpc.entrypoint}\\b`).test(exports)) {
      results.push(blocked(`${rpc.exportFile} does not export ${rpc.entrypoint}`));
    }
    const entry = readText(root, "apps/flightdeck/src/lifecycle-mcp/entrypoint.ts");
    if (entry === null) results.push(blocked("RPC entrypoint source missing"));
    else if (
      !new RegExp(`${rpc.audienceVar}[\\s\\S]{0,120}===[\\s\\S]{0,40}ACCESS_AUD`).test(entry)
    ) {
      results.push(blocked(`entrypoint does not refuse ${rpc.audienceVar} equal to ACCESS_AUD`));
    }
    const wrangler = readWrangler(root, `${mcp.app}/wrangler.jsonc`);
    if (!wrangler.config) results.push(blocked(`${mcp.app}/wrangler.jsonc missing or invalid`));
    else {
      if (wrangler.config.workers_dev !== false) results.push(blocked("MCP workers_dev not false"));
      if (wrangler.config.preview_urls !== false)
        results.push(blocked("MCP preview_urls not false"));
      for (const s of wrangler.config.services ?? []) {
        if (
          s.binding === rpc.binding &&
          (s.service !== rpc.worker || s.entrypoint !== rpc.entrypoint)
        ) {
          results.push(blocked(`${rpc.binding} targets an unexpected service or entrypoint`));
        }
      }
    }
    if (results.length === 0)
      results.push(pass(`${rpc.entrypoint} exported with an audience guard`));
    return combine(results);
  },

  mcpProtocol({ root, manifest }) {
    const { mcp } = manifest;
    const pkgText = readText(root, `${mcp.app}/package.json`);
    if (pkgText === null) return blocked(`${mcp.app}/package.json missing`);
    const pkg = JSON.parse(pkgText);
    const results = [];
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    for (const name of ["@modelcontextprotocol/server", "@modelcontextprotocol/client"]) {
      const version = deps[name];
      if (!version) results.push(blocked(`${name} not declared`));
      else if (!/^\d+\.\d+\.\d+$/.test(version))
        results.push(blocked(`${name} is not pinned exactly`));
      else if (Number(version.split(".")[0]) < mcp.sdkMajor) {
        results.push(blocked(`${name} is older than v${mcp.sdkMajor}`));
      }
    }
    const worker = readText(root, `${mcp.app}/src/worker.ts`) ?? "";
    if (!worker.includes(mcp.protocolVersion)) {
      results.push(blocked(`worker does not declare protocol ${mcp.protocolVersion}`));
    }
    if (results.length === 0)
      results.push(pass(`SDK v${mcp.sdkMajor} pinned; ${mcp.protocolVersion}`));
    return combine(results);
  },

  privacyFloor({ root, manifest, config }) {
    const { mcp } = manifest;
    const results = [];
    const text = readText(root, mcp.productionSwitch) ?? "";
    const floor = Number(/export const MIN_COHORT_FLOOR\s*=\s*(\d+)/.exec(text)?.[1]);
    if (!(floor >= mcp.minCohortFloor))
      results.push(blocked(`MIN_COHORT_FLOOR below ${mcp.minCohortFloor}`));
    const vars = readWrangler(root, `${mcp.app}/wrangler.jsonc`).config?.vars ?? {};
    if (!(Number(vars.LIFECYCLE_MCP_MIN_COHORT) >= mcp.minCohortFloor)) {
      results.push(blocked("LIFECYCLE_MCP_MIN_COHORT below the floor"));
    }
    const intended = config?.privacy?.minCohort;
    if (intended !== undefined && intended < mcp.minCohortFloor) {
      results.push(blocked(`config privacy.minCohort below ${mcp.minCohortFloor}`));
    }
    if (results.length === 0) results.push(pass(`k >= ${mcp.minCohortFloor} in code and config`));
    results.push(pass("differencing resistance is reviewed separately (FLIG-36), not proven here"));
    return combine(results);
  },

  pipelineSchema({ root, manifest }) {
    const spec = manifest.pipelineSchema;
    const text = readText(root, spec.file);
    if (text === null) return blocked(`${spec.file} missing`);
    let schema;
    try {
      schema = JSON.parse(text);
    } catch {
      return blocked(`${spec.file} is not valid JSON`);
    }
    const fields = Array.isArray(schema.fields) ? schema.fields : [];
    const results = [];
    const names = fields.map((f) => f?.name);
    for (const required of spec.requiredFields) {
      if (!names.includes(required)) results.push(blocked(`field ${required} missing`));
    }
    const denied = new RegExp(spec.deniedFieldPattern, "i");
    for (const f of fields) {
      if (typeof f?.name !== "string" || typeof f?.type !== "string") {
        results.push(blocked("a field lacks a string name or type"));
      } else if (denied.test(f.name)) {
        results.push(blocked(`field ${f.name} looks like personal data`));
      }
    }
    if (new Set(names).size !== names.length) results.push(blocked("duplicate field names"));
    if (results.length === 0) results.push(pass(`${fields.length} typed fields`));
    return combine(results);
  },

  async basinSql({ root, manifest }) {
    const spec = manifest.basinSql;
    const results = [];
    for (const dir of spec.sqlDirs) {
      const full = join(root, dir);
      if (!existsSync(full)) continue;
      for (const file of readdirSync(full).filter((f) => f.endsWith(".sql"))) {
        const problems = inspectBasinSql(readFileSync(join(full, file), "utf8"));
        if (problems.length) results.push(blocked(`${dir}/${file}: ${problems.join(", ")}`));
      }
    }
    const dist = join(root, spec.package, "dist/index.js");
    if (!existsSync(dist)) {
      results.push(
        unknown(`${spec.package} not built; run with --run build to check generated SQL`),
      );
    } else {
      try {
        const mod = await import(pathToFileURL(dist).href);
        const plan = mod.buildBasinSql(mod.demoQuery, mod.demoRegistry);
        const problems = inspectBasinSql(plan.sql);
        if (problems.length) results.push(blocked(`generated Basin SQL: ${problems.join(", ")}`));
        else results.push(pass("generated Basin SQL is a single read-only SELECT"));
      } catch {
        results.push(unknown("could not generate Basin SQL from the built package"));
      }
    }
    return combine(results);
  },

  commands({ gate, commandResults }) {
    return combine(
      gate.commands.map((id) => {
        const r = commandResults[id];
        if (!r) return unknown(`${id} not run (use --run)`);
        if (r.status === "passed") return pass(`${id} passed`);
        if (r.status === "missing") return blocked(`${id}: ${r.reason}`);
        return blocked(`${id} failed (exit ${r.exitCode ?? r.reason}); see log`);
      }),
    );
  },

  accessAudiences({ config }) {
    const a = config?.access;
    if (!a?.dashboardAud || !a?.mcpAud || !a?.teamDomain) {
      return unknown("config access.teamDomain, dashboardAud and mcpAud not all provided");
    }
    if (a.dashboardAud === a.mcpAud) {
      return blocked(`MCP AUD equals the dashboard AUD (${fingerprint(a.mcpAud)})`);
    }
    const results = [
      pass(`distinct AUDs ${fingerprint(a.dashboardAud)} / ${fingerprint(a.mcpAud)}`),
    ];
    if (config.environment === "staging" && /^synthetic-/.test(a.dashboardAud + a.mcpAud)) {
      results.push(blocked("staging config uses synthetic AUD placeholders"));
    }
    return combine(results);
  },

  serviceBinding({ manifest, config }) {
    const { rpc } = manifest;
    const services = config?.services;
    if (!services) return unknown("config services not provided");
    const binding = services.find((s) => s.binding === rpc.binding);
    const results = services
      .filter((s) => s.service !== rpc.worker)
      .map((s) => blocked(`binding ${s.binding} targets an unknown service`));
    if (!binding) results.push(blocked(`no ${rpc.binding} binding in config`));
    else if (binding.entrypoint !== rpc.entrypoint) {
      results.push(blocked(`${rpc.binding} must use entrypoint ${rpc.entrypoint}`));
    }
    if (results.length === 0)
      results.push(pass(`${rpc.binding} -> ${rpc.worker}#${rpc.entrypoint}`));
    return combine(results);
  },

  flagPlan({ manifest, config }) {
    if (!config?.flags) return unknown("config flags not provided");
    const results = [];
    for (const flag of manifest.flags) {
      const value = config.flags[flag.name];
      if (value === undefined) results.push(unknown(`${flag.name} not stated in config`));
      else if (!flag.production.includes(value)) {
        results.push(blocked(`${flag.name} intended value is not allowed for a live stage`));
      }
    }
    if (results.length === 0) results.push(pass("intended flags allowed for a live stage"));
    return combine(results);
  },

  oauthMetadata({ root, manifest, config }) {
    const results = [];
    const src = join(root, manifest.mcp.app, "src");
    const served =
      existsSync(src) &&
      readdirSync(src, { recursive: true }).some((f) =>
        String(f).endsWith(".ts")
          ? readFileSync(join(src, String(f)), "utf8").includes("oauth-protected-resource")
          : false,
      );
    if (!served)
      results.push(blocked("MCP Worker does not serve /.well-known/oauth-protected-resource"));
    const rel = config?.oauth?.protectedResourceMetadata;
    if (!rel) results.push(unknown("config oauth.protectedResourceMetadata not provided"));
    else {
      const meta = readEvidenceJson(root, rel);
      if (meta.error) results.push(blocked(`oauth metadata: ${meta.error}`));
      else results.push(checkOauthMetadata(meta.value, config));
    }
    return combine(results);
  },

  retention({ root, manifest, config }) {
    const results = [pendingMigration(root, manifest, "d1-retention")];
    const r = config?.retention;
    if (!r) results.push(unknown("config retention not provided"));
    else if (!r.enabled) results.push(blocked("retention is disabled"));
    else if (!r.days) results.push(blocked("retention enabled without days"));
    else results.push(pass(`retention ${r.days} days`));
    return combine(results);
  },

  budgets({ root, manifest, config }) {
    const results = [pendingMigration(root, manifest, "query-budgets")];
    const b = config?.budgets;
    if (!b) results.push(unknown("config budgets not provided"));
    else {
      for (const [k, v] of Object.entries(b))
        if (v <= 0) results.push(blocked(`budgets.${k} must be positive`));
      if (b.perPrincipalDailyQueries > b.perAppDailyQueries) {
        results.push(blocked("per-principal budget exceeds the per-app budget"));
      }
      if (results.length === 1) results.push(pass("budgets positive and bounded"));
    }
    return combine(results);
  },

  sourceCompleteness({ root, manifest }) {
    const text = readText(root, manifest.mcp.productionSwitch);
    if (text === null) return blocked(`${manifest.mcp.productionSwitch} missing`);
    if (/export const PRODUCTION_ENABLED\s*=\s*false/.test(text)) {
      return blocked("PRODUCTION_ENABLED is false in this build (by design until a reviewed flip)");
    }
    return unknown("production switch on; live read-api completeness needs operator evidence");
  },

  attestation({ root, gate, config, now, head }) {
    const rel = config?.attestations?.[gate.id];
    if (!rel) return unknown("no operator attestation; verify manually on staging (see docs)");
    const read = readEvidenceJson(root, rel);
    if (read.error) return blocked(`attestation: ${read.error}`);
    const doc = read.value;
    const errors = validate(ATTESTATION_SCHEMA, doc);
    if (errors.length) return blocked(`attestation invalid: ${errors.slice(0, 3).join("; ")}`);
    if (doc.gate !== gate.id) return blocked("attestation is for a different gate");
    if (doc.synthetic) return blocked("synthetic attestation cannot satisfy a live gate");
    const results = [];
    for (const name of gate.attestation.checks) {
      if (doc.checks[name] !== true) results.push(blocked(`check ${name} not attested true`));
    }
    for (const field of gate.attestation.fields ?? []) {
      if (!doc[field]) results.push(blocked(`attestation field ${field} missing`));
    }
    if (!head) results.push(unknown("current commit unknown; cannot bind attestation"));
    else if (doc.commit !== head)
      results.push(unknown("attestation names a different commit (stale)"));
    const age = (now.getTime() - Date.parse(doc.verifiedAt)) / 86_400_000;
    if (!(age >= 0)) results.push(blocked("attestation verifiedAt is in the future"));
    else if (age > ATTESTATION_MAX_AGE_DAYS) {
      results.push(unknown(`attestation older than ${ATTESTATION_MAX_AGE_DAYS} days`));
    }
    if (results.length === 0) {
      results.push(pass(`operator-attested (${doc.environment}); not independently verified`));
    }
    return combine(results);
  },
};

function applyMigrations(sqlite, dir, files) {
  const db = new sqlite.DatabaseSync(":memory:");
  try {
    for (const file of files) {
      try {
        db.exec(readFileSync(join(dir, file), "utf8"));
      } catch {
        return blocked(`${file} failed to apply on a blank SQLite database`);
      }
    }
    return pass(`${files.length} migrations applied in order to in-memory SQLite`);
  } finally {
    db.close();
  }
}

function pendingMigration(root, manifest, gateId) {
  const pending = manifest.migrations.pending.find((p) => p.gate === gateId);
  if (!pending) return pass("no pending migration");
  const dir = join(root, manifest.migrations.dir);
  const files = existsSync(dir) ? readdirSync(dir) : [];
  return files.some((f) => f.includes(pending.match))
    ? pass(`${pending.match} migration present`)
    : blocked(`${pending.match} migration not integrated (${pending.owner})`);
}

const MAX_EVIDENCE_BYTES = 256 * 1024;
/** RFC 9728 field names that contain "authorization" or "bearer" but hold no secret. */
const OAUTH_METADATA_KEYS = ["authorization_servers", "bearer_methods_supported"];

/** Reads a repo-relative JSON evidence file, refusing unsafe paths and secret-bearing content. */
export function readEvidenceJson(root, rel) {
  const full = resolveInside(root, rel);
  if (!full) return { error: "path is outside the repository or unsafe" };
  if (!existsSync(full) || !statSync(full).isFile()) return { error: "file not found" };
  if (statSync(full).size > MAX_EVIDENCE_BYTES) return { error: "file too large" };
  let value;
  try {
    value = JSON.parse(readFileSync(full, "utf8"));
  } catch {
    return { error: "not valid JSON" };
  }
  const secrets = findSecrets(value, { hexKeys: ["commit"], allowKeys: OAUTH_METADATA_KEYS });
  if (secrets.length) return { error: `secret-like content at ${secrets.slice(0, 3).join(", ")}` };
  return { value };
}

function checkOauthMetadata(meta, config) {
  if (!isPlainObject(meta)) return blocked("oauth metadata is not an object");
  const results = [];
  const https = (u) => typeof u === "string" && /^https:\/\/[a-z0-9.-]+(?::\d+)?(\/|$)/.test(u);
  if (!https(meta.resource)) results.push(blocked("resource must be an https URL"));
  else if (config.hostnames?.mcp && new URL(meta.resource).hostname !== config.hostnames.mcp) {
    results.push(blocked("resource host differs from hostnames.mcp"));
  }
  if (!Array.isArray(meta.authorization_servers) || meta.authorization_servers.length === 0) {
    results.push(blocked("authorization_servers must be a non-empty array"));
  } else if (!meta.authorization_servers.every(https)) {
    results.push(blocked("authorization_servers must be https URLs"));
  }
  if (
    meta.bearer_methods_supported !== undefined &&
    JSON.stringify(meta.bearer_methods_supported) !== '["header"]'
  ) {
    results.push(blocked('bearer_methods_supported must be ["header"]'));
  }
  if (config.environment === "synthetic") {
    for (const u of [meta.resource, ...(meta.authorization_servers ?? [])]) {
      if (https(u) && !isSyntheticHost(new URL(u).hostname)) {
        results.push(blocked("synthetic config names a non-synthetic OAuth host"));
      }
    }
  }
  if (results.length === 0) results.push(pass("RFC 9728 metadata well-formed (fixture only)"));
  return combine(results);
}
