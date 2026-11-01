// Guards shared by every part of the preflight: secret detection and redaction, repository-bound
// paths, a credential-free environment for child processes, and the synthetic host allowlist.
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

export const SECRET_KEY =
  /secret|token|passw|api[_-]?key|private[_-]?key|credential|cookie|authorization|bearer|session[_-]?id/i;

const SECRET_SHAPES = [
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/, // JWT
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bbearer\s+\S+/i,
  /\b(?:sk|pk|rk)[-_](?:live|test|proj)?[-_]?[A-Za-z0-9]{16,}/,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /:\/\/[^/\s:@]+:[^/\s@]+@/, // credentials in a URL
];

/** True when a string looks like a credential. Long hex is allowed only where a caller says so. */
export function looksSecret(value, { allowHex = false } = {}) {
  if (typeof value !== "string") return false;
  if (SECRET_SHAPES.some((shape) => shape.test(value))) return true;
  if (/^[0-9a-f]{32,}$/i.test(value)) return !allowHex;
  // Long, dense, mixed-case base64-ish runs (Cloudflare API tokens, client secrets, keys).
  for (const run of value.match(/[A-Za-z0-9+/_=-]{32,}/g) ?? []) {
    if (/[a-z]/.test(run) && /[A-Z]/.test(run) && /[0-9]/.test(run) && entropy(run) >= 4) {
      return true;
    }
  }
  return false;
}

function entropy(text) {
  const counts = new Map();
  for (const ch of text) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) bits -= (n / text.length) * Math.log2(n / text.length);
  return bits;
}

/**
 * Walks a parsed JSON value and reports paths (never values) holding secret-like keys or values.
 * `hexKeys` names keys whose values are expected to be long hex (Access AUD tags, commit SHAs);
 * `allowKeys` names standard field names that merely contain a secret-ish word.
 */
export function findSecrets(value, { hexKeys = [], allowKeys = [], path = "$" } = {}) {
  const found = [];
  const walk = (node, at, key) => {
    if (typeof node === "string") {
      if (looksSecret(node, { allowHex: hexKeys.includes(key) })) found.push(at);
    } else if (Array.isArray(node)) {
      for (const [i, item] of node.entries()) walk(item, `${at}[${i}]`, key);
    } else if (node && typeof node === "object") {
      for (const [k, v] of Object.entries(node)) {
        const name = /^[A-Za-z0-9_$-]{1,64}$/.test(k) ? k : "<invalid-key>";
        if (SECRET_KEY.test(k) && !allowKeys.includes(k)) found.push(`${at}.${name}`);
        else walk(v, `${at}.${name}`, k);
      }
    }
  };
  walk(value, path, null);
  return found;
}

const REDACTIONS = [
  [/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, "[redacted:jwt]"],
  [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
    "[redacted:key]",
  ],
  [/(\bbearer\s+)\S+/gi, "$1[redacted]"],
  [/(:\/\/[^/\s:@]+:)[^/\s@]+@/g, "$1[redacted]@"],
  [
    /\b((?:[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|API_KEY|PRIVATE_KEY))|(?:secret|token|password|api[_-]?key|client[_-]?secret))(["']?\s*[:=]\s*["']?)[^\s"',]+/gi,
    "$1$2[redacted]",
  ],
];

/** Redacts secret-shaped text, plus the literal values of secret-named variables in `env`. */
export function redact(text, env = process.env) {
  let out = String(text);
  for (const [name, value] of Object.entries(env)) {
    if (SECRET_KEY.test(name) && typeof value === "string" && value.length >= 8) {
      out = out.split(value).join("[redacted:env]");
    }
  }
  for (const [pattern, replacement] of REDACTIONS) out = out.replace(pattern, replacement);
  for (const run of out.match(/[A-Za-z0-9+/_=-]{32,}/g) ?? []) {
    if (looksSecret(run, { allowHex: true })) out = out.split(run).join("[redacted]");
  }
  return out;
}

/** A short, non-reversible label for an identifier, so reports can show "same/different". */
export function fingerprint(value) {
  return `fp:${createHash("sha256").update(String(value)).digest("hex").slice(0, 8)}`;
}

const SAFE_PATH = /^[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+)*$/;

/**
 * Resolves a repository-relative path, refusing absolute paths, `..`, shell metacharacters and
 * symlinks that leave the repository. Returns null when the path is unsafe.
 */
export function resolveInside(root, relPath) {
  if (typeof relPath !== "string" || !SAFE_PATH.test(relPath)) return null;
  if (isAbsolute(relPath) || relPath.split("/").some((part) => part === ".." || part === ".")) {
    return null;
  }
  const full = resolve(root, relPath);
  const lexical = relative(resolve(root), full);
  if (lexical.startsWith("..") || isAbsolute(lexical)) return null;
  if (existsSync(full)) {
    const realRoot = realpathSync(root);
    const real = realpathSync(full);
    if (real !== realRoot && !real.startsWith(realRoot + sep)) return null;
  }
  return full;
}

/** Environment variables a child command may inherit. Everything else is dropped. */
const ENV_ALLOW = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TMPDIR",
  "TMP",
  "TEMP",
  "CI",
  "GITHUB_ACTIONS",
  "RUNNER_OS",
  "RUNNER_TEMP",
  "PNPM_HOME",
  "COREPACK_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "SYSTEMROOT",
  "COMSPEC",
];

/**
 * Builds a credential-free environment for allowlisted commands. Wrangler gets an empty config
 * home so a developer's `wrangler login` OAuth token is not visible to it.
 */
export function childEnv(base = process.env, { isolatedConfigHome } = {}) {
  const env = {};
  for (const name of ENV_ALLOW) {
    if (base[name] !== undefined && !SECRET_KEY.test(name)) env[name] = base[name];
  }
  env.FORCE_COLOR = "0";
  env.NO_COLOR = "1";
  env.WRANGLER_SEND_METRICS = "false";
  env.CLOUDFLARE_API_TOKEN = "";
  env.CLOUDFLARE_API_KEY = "";
  env.CLOUDFLARE_ACCOUNT_ID = "";
  if (isolatedConfigHome) env.XDG_CONFIG_HOME = isolatedConfigHome;
  return env;
}

/** Hostnames a synthetic configuration may name. Anything else could be a real service. */
export function isSyntheticHost(host) {
  if (typeof host !== "string") return false;
  const h = host.toLowerCase();
  return (
    h === "localhost" ||
    /(^|\.)example$/.test(h) ||
    /(^|\.)example\.(com|net|org)$/.test(h) ||
    /\.(invalid|test|localhost)$/.test(h)
  );
}
