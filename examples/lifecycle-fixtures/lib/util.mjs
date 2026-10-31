export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** Value at `key`, created with `make()` on first use. Works on Map and plain objects. */
export function ensure(store, key, make) {
  if (store instanceof Map) {
    if (!store.has(key)) store.set(key, make());
    return store.get(key);
  }
  if (!(key in store)) store[key] = make();
  return store[key];
}

export const toIso = (ms) => new Date(ms).toISOString();

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
/** Epoch ms for a strict `YYYY-MM-DDTHH:mm:ss.sssZ` string, else NaN. */
export function parseIso(s) {
  if (typeof s !== "string" || !ISO_RE.test(s)) return Number.NaN;
  const ms = Date.parse(s);
  return Number.isNaN(ms) || new Date(ms).toISOString() !== s ? Number.NaN : ms;
}

/** Nearest-rank percentile of an ascending-sorted array. */
export function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
}

/** Parse `1k`, `100k`, `1m`, `2500` into an integer. */
export function parseSize(text) {
  const m = /^(\d+(?:\.\d+)?)([km]?)$/i.exec(String(text).trim());
  if (!m) throw new Error(`invalid size ${JSON.stringify(text)} (use 1k, 100k, 1m or a number)`);
  const mult = { "": 1, k: 1e3, m: 1e6 }[m[2].toLowerCase()];
  return Math.round(Number(m[1]) * mult);
}

/** Parse `90m`, `2h`, `3d`, `45s` into ms. */
export function parseDuration(text) {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(String(text).trim());
  if (!m) throw new Error(`invalid duration ${JSON.stringify(text)} (use 500ms, 30s, 5m, 2h, 3d)`);
  return Math.round(Number(m[1]) * { ms: 1, s: SECOND, m: MINUTE, h: HOUR, d: DAY }[m[2]]);
}

/** Recursive diff of two JSON-like values. Returns up to `limit` `path: a != b` lines. */
export function diff(a, b, path = "$", out = [], limit = 20) {
  if (out.length >= limit) return out;
  if (Object.is(a, b)) return out;
  const aObj = a !== null && typeof a === "object";
  const bObj = b !== null && typeof b === "object";
  if (!aObj || !bObj || Array.isArray(a) !== Array.isArray(b)) {
    out.push(`${path}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
    return out;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) diff(a[k], b[k], `${path}.${k}`, out, limit);
  return out;
}

/** Mismatches where `expected` is not a subset of `actual`. Arrays must match exactly. */
export function subsetMismatches(actual, expected, path = "$", out = []) {
  if (expected === null || typeof expected !== "object") {
    if (!Object.is(actual, expected)) {
      out.push(`${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
    return out;
  }
  if (Array.isArray(expected)) {
    if (expected.length > 0 && expected.every((x) => x !== null && typeof x === "object")) {
      if (!Array.isArray(actual) || actual.length !== expected.length) {
        out.push(
          `${path}: expected ${expected.length} items, got ${Array.isArray(actual) ? actual.length : "none"}`,
        );
        return out;
      }
      for (const [i, x] of expected.entries()) subsetMismatches(actual[i], x, `${path}[${i}]`, out);
      return out;
    }
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      out.push(
        `${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual ?? null)}`,
      );
    }
    return out;
  }
  if (actual === null || typeof actual !== "object") {
    out.push(`${path}: expected object, got ${JSON.stringify(actual ?? null)}`);
    return out;
  }
  for (const k of Object.keys(expected))
    subsetMismatches(actual[k], expected[k], `${path}.${k}`, out);
  return out;
}
