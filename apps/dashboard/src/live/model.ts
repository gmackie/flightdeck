/** Shapes of `GET /api/apps/:id/live` and the live WebSocket, and what the Live page derives. */

const MINUTE_MS = 60_000;
/** Events per minute averages this many complete minutes. */
export const RATE_MINUTES = 5;
/** Rows shown in the top pages and top events tables. */
export const TOP_ROWS = 10;

export type Counter = { kind: string; name: string; count: number };
export type KindTotal = { kind: string; count: number };
export type MinuteCount = { minute: number; count: number };

export type LiveHour = {
  hour: string;
  start: number;
  totals: KindTotal[];
  counters: Counter[];
  transitions: { source: string; target: string; count: number }[];
  sessions: number;
  /** The shard's write sequence when this snapshot was taken. */
  seq: number;
  minutes: MinuteCount[];
};

export type LiveView = {
  app_id: string;
  now: number;
  active_window_ms: number;
  active_sessions: number;
  /** Newest first. */
  hours: LiveHour[];
};

/** Increments pushed by the current hour's AppDO; `sessions` and `active` are absolute. */
export type LiveDelta = {
  type: "delta";
  hour: string;
  events: number;
  counters: Counter[];
  minutes: MinuteCount[];
  /** More counters changed than the delta lists: refetch for exact tables. */
  truncated: boolean;
  /** Covers the shard's writes `since + 1` through `seq`. */
  since: number;
  seq: number;
  sessions: number;
  active: number;
  at: number;
};

/** The first message on a live socket, stamped by the server clock. */
export type LiveHello = { type: "hello"; hour: string; hour_end: number; seq: number; now: number };

export function isLiveView(value: unknown): value is LiveView {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.app_id === "string" &&
    typeof v.now === "number" &&
    typeof v.active_sessions === "number" &&
    Array.isArray(v.hours) &&
    v.hours.every(
      (h) =>
        typeof h === "object" &&
        h !== null &&
        Array.isArray(h.totals) &&
        Array.isArray(h.counters) &&
        Array.isArray(h.minutes),
    )
  );
}

export function isLiveDelta(value: unknown): value is LiveDelta {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.type === "delta" &&
    typeof v.hour === "string" &&
    Array.isArray(v.counters) &&
    Array.isArray(v.minutes) &&
    typeof v.at === "number" &&
    typeof v.seq === "number" &&
    typeof v.since === "number"
  );
}

export function isLiveHello(value: unknown): value is LiveHello {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return v.type === "hello" && typeof v.hour_end === "number" && typeof v.now === "number";
}

const byCount =
  <T extends { count: number }>(key: (t: T) => string) =>
  (a: T, b: T) =>
    b.count - a.count || key(a).localeCompare(key(b));

function addCounters(base: Counter[], add: Counter[]): Counter[] {
  const merged = new Map(base.map((c) => [`${c.kind}\u0000${c.name}`, { ...c }]));
  for (const c of add) {
    const key = `${c.kind}\u0000${c.name}`;
    const hit = merged.get(key);
    if (hit) hit.count += c.count;
    else merged.set(key, { ...c });
  }
  return [...merged.values()].sort(byCount((c) => c.kind + c.name));
}

function addTotals(base: KindTotal[], add: Counter[]): KindTotal[] {
  const merged = new Map(base.map((t) => [t.kind, { ...t }]));
  for (const c of add) {
    const hit = merged.get(c.kind);
    if (hit) hit.count += c.count;
    else merged.set(c.kind, { kind: c.kind, count: c.count });
  }
  return [...merged.values()].sort((a, b) => b.count - a.count);
}

function addMinutes(base: MinuteCount[], add: MinuteCount[]): MinuteCount[] {
  const merged = new Map(base.map((m) => [m.minute, { ...m }]));
  for (const m of add) {
    const hit = merged.get(m.minute);
    if (hit) hit.count += m.count;
    else merged.set(m.minute, { ...m });
  }
  return [...merged.values()].sort((a, b) => a.minute - b.minute);
}

/**
 * Folds a pushed delta into the view, using the shard sequence to stay exact:
 * - `seq <= hour.seq`: the snapshot already has it; skip.
 * - `since < hour.seq`: it overlaps the snapshot; skip and refetch rather than double-count.
 * - `since > hour.seq`: writes went unpushed (e.g. before the socket opened); apply, then refetch.
 * `resync` asks the caller to refetch the snapshot; truncated deltas ask for one too.
 */
export function applyDelta(view: LiveView, delta: LiveDelta): { view: LiveView; resync: boolean } {
  const [current, ...older] = view.hours;
  let hours: LiveHour[];
  let hour: LiveHour;
  if (current && delta.hour === current.hour) {
    if (delta.seq <= current.seq) return { view, resync: false };
    if (delta.since < current.seq) return { view, resync: true };
    hour = current;
    hours = older;
  } else if (!current || delta.hour > current.hour) {
    const start = Date.parse(`${delta.hour}:00:00.000Z`);
    hour = {
      hour: delta.hour,
      start,
      totals: [],
      counters: [],
      transitions: [],
      sessions: 0,
      seq: 0,
      minutes: [],
    };
    hours = view.hours;
  } else {
    return { view, resync: false };
  }
  const next: LiveHour = {
    ...hour,
    totals: addTotals(hour.totals, delta.counters),
    counters: addCounters(hour.counters, delta.counters),
    minutes: addMinutes(hour.minutes, delta.minutes),
    sessions: delta.sessions,
    seq: delta.seq,
  };
  // The shard only knows its own hour: early in an hour some active sessions live in the
  // previous one, so keep the larger count until the next full fetch.
  const exact = delta.at - view.active_window_ms >= next.start;
  return {
    view: {
      ...view,
      now: delta.at,
      active_sessions: exact ? delta.active : Math.max(view.active_sessions, delta.active),
      // A new hour pushes the oldest one out, so the view keeps the number of hours it asked for.
      hours: [next, ...hours].slice(0, Math.max(1, view.hours.length)),
    },
    resync: delta.truncated || delta.since > hour.seq,
  };
}

export type LiveSummary = {
  activeSessions: number;
  /** Mean over the last `RATE_MINUTES` complete minutes. */
  eventsPerMinute: number;
  /** Page views in the current UTC hour. */
  pageViews: number;
  /** `[minute start, events]` for the last 60 minutes, oldest first, current minute last. */
  perMinute: [number, number][];
  /** Across the fetched hours, most viewed first. */
  topPages: { name: string; count: number }[];
  topEvents: Counter[];
  hasEvents: boolean;
};

export function summarize(view: LiveView, now: number): LiveSummary {
  const current = Math.floor(now / MINUTE_MS) * MINUTE_MS;
  const minutes = new Map<number, number>();
  for (const h of view.hours) {
    for (const m of h.minutes) minutes.set(m.minute, (minutes.get(m.minute) ?? 0) + m.count);
  }
  const perMinute = Array.from({ length: 60 }, (_, i): [number, number] => {
    const t = current - (59 - i) * MINUTE_MS;
    return [t, minutes.get(t) ?? 0];
  });
  const recent = perMinute.slice(-1 - RATE_MINUTES, -1).reduce((n, [, c]) => n + c, 0);
  const counters = view.hours.reduce<Counter[]>((all, h) => addCounters(all, h.counters), []);
  return {
    activeSessions: view.active_sessions,
    eventsPerMinute: recent / RATE_MINUTES,
    pageViews: view.hours[0]?.totals.find((t) => t.kind === "page")?.count ?? 0,
    perMinute,
    topPages: counters
      .filter((c) => c.kind === "page")
      .slice(0, TOP_ROWS)
      .map(({ name, count }) => ({ name, count })),
    topEvents: counters.filter((c) => c.kind !== "page").slice(0, TOP_ROWS),
    hasEvents: view.hours.some((h) => h.totals.some((t) => t.count > 0)),
  };
}
