import { OPAQUE_ID, SLUG } from "./model";

/** Query-string parsing for the serving API. Parsers throw BadQuery, which the handler turns into a 400. */

export class BadQuery extends Error {}

export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 100;
const DAY_MS = 86_400_000;
/** Aggregates default to the last 30 days and never span more than a year. */
export const DEFAULT_WINDOW_MS = 30 * DAY_MS;
export const MAX_WINDOW_MS = 366 * DAY_MS;

const DATE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2}))?$/;
const VERSION = /^[1-9]\d{0,8}$/;

/** Rejects parameters the endpoint does not support, and repeated ones, instead of ignoring them. */
export function onlyParams(params: URLSearchParams, allowed: readonly string[]): void {
  const seen = new Set<string>();
  for (const name of params.keys()) {
    if (!allowed.includes(name)) throw new BadQuery(`unsupported parameter: ${name.slice(0, 32)}`);
    if (seen.has(name)) throw new BadQuery(`repeated parameter: ${name}`);
    seen.add(name);
  }
}

export function slugParam(params: URLSearchParams, name: string): string | null {
  const value = params.get(name);
  if (value === null) return null;
  if (!SLUG.test(value)) throw new BadQuery(`${name} must be a lowercase key`);
  return value;
}

export function idParam(params: URLSearchParams, name: string): string | null {
  const value = params.get(name);
  if (value === null) return null;
  if (!OPAQUE_ID.test(value)) throw new BadQuery(`${name} must be an opaque id`);
  return value;
}

export function versionParam(params: URLSearchParams): number | null {
  const value = params.get("version");
  if (value === null) return null;
  if (!VERSION.test(value)) throw new BadQuery("version must be a positive integer");
  return Number(value);
}

export function limitParam(params: URLSearchParams): number {
  const value = params.get("limit");
  if (value === null) return DEFAULT_LIMIT;
  const n = Number(value);
  if (!/^\d{1,3}$/.test(value) || n < 1 || n > MAX_LIMIT) {
    throw new BadQuery(`limit must be an integer from 1 to ${MAX_LIMIT}`);
  }
  return n;
}

/** `YYYY-MM-DD` (UTC midnight) or an ISO 8601 date-time with a zone; epoch ms. */
export function dateParam(params: URLSearchParams, name: string): number | null {
  const value = params.get(name);
  if (value === null) return null;
  const ms = DATE.test(value) ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(ms) || ms < 0) throw new BadQuery(`${name} must be an ISO 8601 date`);
  return ms;
}

/** `[after, before)` bounds on started_at; both optional for lists. */
export function startedRange(params: URLSearchParams): {
  after: number | null;
  before: number | null;
} {
  const after = dateParam(params, "started_after");
  const before = dateParam(params, "started_before");
  if (after !== null && before !== null && after >= before) {
    throw new BadQuery("started_after must be before started_before");
  }
  return { after, before };
}

/** Aggregates always have a bounded window: defaults fill in, and over-long spans are refused. */
export function aggregateWindow(
  params: URLSearchParams,
  now: number,
): { after: number; before: number } {
  const range = startedRange(params);
  const before = range.before ?? (range.after !== null ? range.after + DEFAULT_WINDOW_MS : now);
  const after = range.after ?? before - DEFAULT_WINDOW_MS;
  if (before - after > MAX_WINDOW_MS) throw new BadQuery("date window must be at most 366 days");
  return { after, before };
}

/**
 * Opaque keyset cursors. The payload is bound to a digest of the app and filters it was issued
 * for, so a cursor replayed against other filters is rejected rather than silently skipping rows.
 */
export function encodeCursor(scope: string, key: readonly (string | number)[]): string {
  const bytes = new TextEncoder().encode(JSON.stringify({ s: digest(scope), k: key }));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function decodeCursor(
  params: URLSearchParams,
  scope: string,
  shape: readonly ("string" | "number")[],
): (string | number)[] | null {
  const raw = params.get("cursor");
  if (raw === null) return null;
  const invalid = new BadQuery("cursor is invalid for this query");
  if (raw.length > 512 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw invalid;
  let parsed: unknown;
  try {
    const binary = atob(raw.replace(/-/g, "+").replace(/_/g, "/"));
    parsed = JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0))));
  } catch {
    throw invalid;
  }
  if (typeof parsed !== "object" || parsed === null) throw invalid;
  const { s, k } = parsed as { s?: unknown; k?: unknown };
  if (s !== digest(scope) || !Array.isArray(k) || k.length !== shape.length) throw invalid;
  if (
    !k.every(
      (part, i) =>
        typeof part === shape[i] &&
        (typeof part !== "number" || (Number.isSafeInteger(part) && part >= 0)),
    )
  )
    throw invalid;
  return k;
}

/** FNV-1a: a stable tag, not a security boundary (every query is app-bound regardless). */
function digest(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}
