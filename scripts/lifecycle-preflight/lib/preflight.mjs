// Loads and validates the manifest and input config, evaluates every gate, and derives the two
// verdicts. Pure apart from local file reads; command results are passed in.
import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { CHECKS } from "./checks.mjs";
import { COMMANDS } from "./commands.mjs";
import { findSecrets, isSyntheticHost, SECRET_KEY } from "./safety.mjs";
import { validate } from "./schema.mjs";

const here = new URL("..", import.meta.url).pathname;
const loadJson = (name) => JSON.parse(readFileSync(join(here, name), "utf8"));
export const MANIFEST_SCHEMA = loadJson("gates.schema.json");
export const CONFIG_SCHEMA = loadJson("config.schema.json");
export const VERDICTS = ["integration-ready", "production-safe"];

export class UsageError extends Error {}

export function loadManifest(path = join(here, "gates.json")) {
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  const errors = validate(MANIFEST_SCHEMA, manifest);
  const ids = new Set();
  for (const gate of manifest.gates ?? []) {
    if (ids.has(gate.id)) errors.push(`gate ${gate.id}: duplicate id`);
    ids.add(gate.id);
    if (!Object.hasOwn(CHECKS, gate.check)) errors.push(`gate ${gate.id}: unknown check`);
    if (gate.check === "commands" && !gate.commands) errors.push(`gate ${gate.id}: no commands`);
    for (const id of gate.commands ?? []) {
      if (!Object.hasOwn(COMMANDS, id)) errors.push(`gate ${gate.id}: unknown command ${id}`);
    }
    if (gate.check === "attestation" && !gate.attestation) {
      errors.push(`gate ${gate.id}: attestation gate without required checks`);
    }
  }
  if (errors.length) throw new UsageError(`Invalid gate manifest:\n  ${errors.join("\n  ")}`);
  return manifest;
}

const ENV_PREFIX = "FLIGHTDECK_PREFLIGHT_";
/** The only environment variables --from-env reads, and where each lands in the config. */
export const ENV_FIELDS = Object.freeze({
  FLIGHTDECK_PREFLIGHT_ENVIRONMENT: ["environment"],
  FLIGHTDECK_PREFLIGHT_DASHBOARD_HOST: ["hostnames", "dashboard"],
  FLIGHTDECK_PREFLIGHT_MCP_HOST: ["hostnames", "mcp"],
  FLIGHTDECK_PREFLIGHT_ACCESS_TEAM_DOMAIN: ["access", "teamDomain"],
  FLIGHTDECK_PREFLIGHT_DASHBOARD_AUD: ["access", "dashboardAud"],
  FLIGHTDECK_PREFLIGHT_MCP_AUD: ["access", "mcpAud"],
});

/** Reads allowlisted FLIGHTDECK_PREFLIGHT_* variables. Unknown or secret-named ones are refused. */
export function configFromEnv(env) {
  const config = {};
  for (const name of Object.keys(env).filter((n) => n.startsWith(ENV_PREFIX))) {
    if (SECRET_KEY.test(name.slice(ENV_PREFIX.length))) {
      throw new UsageError(`${name}: secrets are never accepted; unset it`);
    }
    const path = ENV_FIELDS[name];
    if (!path) throw new UsageError(`${name}: not a recognised preflight variable`);
    let node = config;
    for (const key of path.slice(0, -1)) node = node[key] ??= {};
    node[path.at(-1)] = env[name];
  }
  return config;
}

/** Validates the input config. Error messages name paths only, never values. */
export function checkConfig(config, manifest) {
  const errors = validate(CONFIG_SCHEMA, config);
  for (const at of findSecrets(config, { hexKeys: ["dashboardAud", "mcpAud"] })) {
    errors.push(`${at}: secret-like key or value is not allowed (never put secrets in config)`);
  }
  const flags = new Map(manifest.flags.map((f) => [f.name, f]));
  for (const [name, value] of Object.entries(config.flags ?? {})) {
    const flag = flags.get(name);
    if (!flag) errors.push(`$.flags.${name}: not an allowlisted flag`);
    else if (!flag.allowed.includes(value)) errors.push(`$.flags.${name}: invalid value`);
  }
  const gates = new Map(manifest.gates.map((g) => [g.id, g]));
  for (const id of Object.keys(config.attestations ?? {})) {
    if (gates.get(id)?.check !== "attestation") {
      errors.push(`$.attestations.${id}: not an attestation gate`);
    }
  }
  const paths = [
    ["$.oauth.protectedResourceMetadata", config.oauth?.protectedResourceMetadata],
    ...Object.entries(config.attestations ?? {}).map(([id, p]) => [`$.attestations.${id}`, p]),
  ];
  for (const [at, path] of paths) {
    if (typeof path === "string" && path.split("/").some((part) => part === "." || part === "..")) {
      errors.push(`${at}: must stay inside the repository`);
    }
  }
  if (config.environment === "synthetic") {
    const hosts = [
      ["$.hostnames.dashboard", config.hostnames?.dashboard],
      ["$.hostnames.mcp", config.hostnames?.mcp],
      ["$.access.teamDomain", config.access?.teamDomain],
    ];
    for (const [at, host] of hosts) {
      if (host !== undefined && !isSyntheticHost(host)) {
        errors.push(`${at}: synthetic configs may only name reserved test domains`);
      }
    }
  }
  if (errors.length) throw new UsageError(`Invalid preflight config:\n  ${errors.join("\n  ")}`);
  return config;
}

export function readConfigFile(path) {
  let text;
  try {
    if (statSync(path).size > 256 * 1024) throw new UsageError("--config file is too large");
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (error instanceof UsageError) throw error;
    throw new UsageError("--config file not found or unreadable");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new UsageError("--config file is not valid JSON");
  }
}

/** Local `git` only: HEAD and the tracked file list. Null when git is unavailable. */
export function readGit(root) {
  const git = (args) => {
    const r = spawnSync("git", args, {
      cwd: root,
      encoding: "utf8",
      shell: false,
      timeout: 10_000,
    });
    return r.status === 0 ? r.stdout : null;
  };
  const head = git(["rev-parse", "HEAD"])?.trim() ?? null;
  const files = git(["ls-files", "-z"]);
  return {
    head: /^[0-9a-f]{40}$/.test(head ?? "") ? head : null,
    trackedFiles: files === null ? null : files.split("\0").filter(Boolean),
  };
}

export async function loadSqlite() {
  try {
    return await import("node:sqlite");
  } catch {
    return null;
  }
}

/** Evaluates every gate and derives both verdicts. */
export async function evaluate({
  root,
  manifest,
  config = null,
  commandResults = {},
  now = new Date(),
  git = readGit(root),
  sqlite = undefined,
  nodeVersion = process.version,
}) {
  const ctx = {
    root,
    manifest,
    config,
    commandResults,
    now,
    head: git.head,
    trackedFiles: git.trackedFiles,
    sqlite: sqlite === undefined ? await loadSqlite() : sqlite,
    nodeVersion,
  };
  const gates = [];
  for (const gate of manifest.gates) {
    let result;
    try {
      result = await CHECKS[gate.check]({ ...ctx, gate });
    } catch {
      result = { status: "unknown", reasons: ["check crashed; treated as unknown"] };
    }
    if (!["pass", "blocked", "unknown"].includes(result.status)) {
      result = { status: "unknown", reasons: ["check returned no status"] };
    }
    gates.push({
      id: gate.id,
      title: gate.title,
      status: result.status,
      requiredFor: gate.requiredFor,
      owner: gate.owner,
      reasons: result.reasons,
      evidence: gate.evidence,
      docs: gate.docs ?? [],
    });
  }
  return { gates, verdicts: verdicts(gates, config), head: git.head };
}

/**
 * integration-ready needs every integration gate to pass. production-safe needs every gate to
 * pass (integration gates included) and a staging config; a synthetic or absent config can never
 * yield production-safe.
 */
export function verdicts(gates, config) {
  const derive = (required, extra = []) => {
    const blocking = required.filter((g) => g.status === "blocked").map((g) => g.id);
    const unknowns = required.filter((g) => g.status !== "pass" && g.status !== "blocked");
    const status =
      blocking.length || extra.length
        ? "blocked"
        : unknowns.length || required.length === 0
          ? "unknown"
          : "ready";
    return { status, blocking, unknown: unknowns.map((g) => g.id), notes: extra };
  };
  const integration = gates.filter((g) => g.requiredFor.includes("integration-ready"));
  const extra = [];
  if (config?.environment !== "staging") {
    extra.push(
      "production-safe needs a staging config; synthetic or absent input cannot attest a live account",
    );
  }
  return {
    "integration-ready": derive(integration),
    "production-safe": derive(gates, extra),
  };
}
