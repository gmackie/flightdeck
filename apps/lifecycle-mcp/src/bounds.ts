/** Hard output and query bounds. Inputs outside them are rejected, never silently widened. */
export const LIMITS = {
  /** Rows per page for list tools. */
  maxPageSize: 50,
  defaultPageSize: 20,
  /** Timeline entries per page. */
  maxTimelinePage: 100,
  defaultTimelinePage: 50,
  /** A cursor chain ends after this many pages, so no caller can walk a whole table. */
  maxPages: 20,
  /** Same bound as the Workstream H read API. */
  maxWindowDays: 366,
  defaultWindowDays: 90,
  maxFunnelStages: 12,
  maxFilters: 3,
  maxVariants: 15,
  maxBottlenecks: 10,
  /** Serialized structured result size; larger answers ask the caller to narrow the query. */
  maxResultChars: 48_000,
  /** Combined array elements and object members in one `tools/call` arguments payload. */
  maxToolInputElements: 64,
  maxRequestBytes: 64 * 1024,
} as const;

const DAY_MS = 86_400_000;
/** No lifecycle data predates this; it also keeps `from` from becoming a full-history scan. */
const EARLIEST = Date.UTC(2000, 0, 1);

export class BoundsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BoundsError";
  }
}

/** Resolves `[from, to)` in ms. Omitted ends default to the last `defaultWindowDays` days. */
export function resolveWindow(
  input: { from?: string | undefined; to?: string | undefined },
  now: number,
): { from: number; to: number } {
  const to = input.to === undefined ? now : parseInstant(input.to, "to");
  const from =
    input.from === undefined
      ? to - LIMITS.defaultWindowDays * DAY_MS
      : parseInstant(input.from, "from");
  if (from >= to) throw new BoundsError("from must be before to");
  if (from < EARLIEST) throw new BoundsError("from must be 2000-01-01 or later");
  if (to > now + DAY_MS) throw new BoundsError("to must not be in the future");
  if (to - from > LIMITS.maxWindowDays * DAY_MS) {
    throw new BoundsError(`The date range must be at most ${LIMITS.maxWindowDays} days`);
  }
  return { from, to };
}

/** Accepts `YYYY-MM-DD` (UTC midnight) or an ISO 8601 date-time with an explicit offset. */
function parseInstant(value: string, name: string): number {
  const ok = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2}))?$/.test(
    value,
  );
  const ms = ok ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(ms)) throw new BoundsError(`${name} must be YYYY-MM-DD or an ISO 8601 time`);
  return ms;
}

type CursorBinding = { tool: string; appId: string; query: unknown };
type CursorState = { v: 1; t: string; a: string; q: string; p: number; s: string };

/**
 * Wraps a source cursor so it is only valid for the same tool, app and query, and only for
 * `maxPages` pages. It is not a secret: the app grant is re-checked on every call regardless.
 */
export async function encodeCursor(
  binding: CursorBinding,
  page: number,
  sourceCursor: string | null,
): Promise<string | null> {
  if (sourceCursor === null || page >= LIMITS.maxPages) return null;
  const state: CursorState = {
    v: 1,
    t: binding.tool,
    a: binding.appId,
    q: await fingerprint(binding.query),
    p: page + 1,
    s: sourceCursor,
  };
  return base64url(JSON.stringify(state));
}

/** The page number (1 for the first page) and source cursor, or a BoundsError. */
export async function decodeCursor(
  cursor: string | undefined,
  binding: CursorBinding,
): Promise<{ page: number; sourceCursor: string | null }> {
  if (cursor === undefined) return { page: 1, sourceCursor: null };
  let state: Partial<CursorState>;
  try {
    state = JSON.parse(fromBase64url(cursor));
  } catch {
    throw new BoundsError("Invalid cursor");
  }
  if (
    state?.v !== 1 ||
    state.t !== binding.tool ||
    state.a !== binding.appId ||
    state.q !== (await fingerprint(binding.query)) ||
    !Number.isInteger(state.p) ||
    typeof state.s !== "string" ||
    state.s.length > 512
  ) {
    throw new BoundsError("Invalid cursor: it belongs to a different tool, app or query");
  }
  const page = state.p as number;
  if (page < 2 || page > LIMITS.maxPages) throw new BoundsError("Invalid cursor");
  return { page, sourceCursor: state.s };
}

async function fingerprint(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(value ?? null)),
  );
  return [...new Uint8Array(digest).slice(0, 12)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function base64url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(text: string): string {
  if (!/^[A-Za-z0-9_-]{1,1024}$/.test(text)) throw new Error("not base64url");
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}
