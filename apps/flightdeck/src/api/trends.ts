import { hourKey } from "@flightdeckhq/schema";
import { OTHER } from "../do/app";
import { appShard } from "../do/shards";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export const RANGES = {
  "24h": { bucket: "hour", count: 24 },
  "7d": { bucket: "day", count: 7 },
  "30d": { bucket: "day", count: 30 },
} as const;
export type Range = keyof typeof RANGES;
export const BREAKDOWNS = ["kind", "name", "page"] as const;
export type Breakdown = (typeof BREAKDOWNS)[number];
/** Series shown individually; the rest fold into one `$other` series. */
export const TOP_SERIES = 5;
const KIND = /^[a-z_]{1,32}$/;

export type TrendsQuery = { range: Range; breakdown: Breakdown; kind: string | null };

export type TrendsView = TrendsQuery & {
  app_id: string;
  bucket: "hour" | "day";
  /** UTC bucket starts in epoch ms, oldest first. */
  buckets: number[];
  /** Highest totals first; `$other` (if any) last. `counts` lines up with `buckets`. */
  series: { name: string; total: number; counts: number[] }[];
  /** `sessions` sums each hour's unique sessions, so a session spanning hours counts per hour. */
  totals: { events: number; sessions: number };
};

/** Parses `?range=&breakdown=&kind=`; returns an error message when invalid. */
export function parseTrendsQuery(params: URLSearchParams): TrendsQuery | string {
  const range = params.get("range") ?? "24h";
  if (!Object.hasOwn(RANGES, range)) return "range must be 24h, 7d or 30d";
  const breakdown = params.get("breakdown") ?? "kind";
  if (!(BREAKDOWNS as readonly string[]).includes(breakdown)) {
    return "breakdown must be kind, name or page";
  }
  const kind = params.get("kind");
  if (kind !== null && !KIND.test(kind)) return "kind must be a lowercase event kind";
  return { range: range as Range, breakdown: breakdown as Breakdown, kind };
}

type Row = { bucket: string; series: string; count: number };

/**
 * Event counts over time. Hours older than the previous one come from the D1 rollups; the
 * previous and current hours come from their AppDOs, which stay authoritative until expiry
 * (the previous hour may not be flushed yet, and a flush can lag late events).
 */
export async function trendsView(
  env: Env,
  appId: string,
  query: TrendsQuery,
  now = Date.now(),
): Promise<TrendsView> {
  const { bucket, count } = RANGES[query.range];
  const keyLength = bucket === "hour" ? 13 : 10;
  const step = bucket === "hour" ? HOUR_MS : DAY_MS;
  const bucketKeys = Array.from({ length: count }, (_, i) =>
    new Date(now - (count - 1 - i) * step).toISOString().slice(0, keyLength),
  );
  const from = bucket === "hour" ? bucketKeys[0] : `${bucketKeys[0]}T00`;
  const liveHours = [hourKey(now - HOUR_MS), hourKey(now)];
  const kind = query.breakdown === "page" ? "page" : query.kind;
  const seriesColumn = query.breakdown === "kind" ? "kind" : "name";
  // Without a kind, a name breakdown skips page views: their names are paths.
  const excludePages = query.breakdown === "name" && kind === null;

  const filters = [
    kind !== null ? "AND kind = ?" : "",
    excludePages ? "AND kind != 'page'" : "",
  ].join(" ");
  const range = [appId, from, liveHours[0]];
  const [warm, warmSessions, ...hot] = await Promise.all([
    env.DB.prepare(
      `SELECT substr(hour, 1, ?) AS bucket, ${seriesColumn} AS series, sum(count) AS count
       FROM hourly_rollups WHERE app_id = ? AND hour >= ? AND hour < ? ${filters}
       GROUP BY bucket, series`,
    )
      .bind(keyLength, ...range, ...(kind !== null ? [kind] : []))
      .all<Row>(),
    env.DB.prepare(
      `SELECT substr(hour, 1, ?) AS bucket, sum(sessions) AS sessions
       FROM hourly_sessions WHERE app_id = ? AND hour >= ? AND hour < ? GROUP BY bucket`,
    )
      .bind(keyLength, ...range)
      .all<{ bucket: string; sessions: number }>(),
    ...liveHours.map((hour) => appShard(env, appId, hour).rollup()),
  ]);

  const rows: Row[] = [...warm.results];
  let sessions = warmSessions.results.reduce((n, r) => n + r.sessions, 0);
  hot.forEach((rollup, i) => {
    const b = (liveHours[i] as string).slice(0, keyLength);
    if (!bucketKeys.includes(b)) return;
    sessions += rollup.sessions;
    for (const c of rollup.counters) {
      if (kind !== null && c.kind !== kind) continue;
      if (excludePages && c.kind === "page") continue;
      rows.push({
        bucket: b,
        series: query.breakdown === "kind" ? c.kind : c.name,
        count: c.count,
      });
    }
  });

  return {
    app_id: appId,
    ...query,
    bucket,
    buckets: bucketKeys.map((k) =>
      Date.parse(bucket === "hour" ? `${k}:00:00Z` : `${k}T00:00:00Z`),
    ),
    series: toSeries(rows, bucketKeys),
    totals: { events: rows.reduce((n, r) => n + r.count, 0), sessions },
  };
}

function toSeries(rows: Row[], bucketKeys: string[]): TrendsView["series"] {
  const index = new Map(bucketKeys.map((k, i) => [k, i]));
  const all = new Map<string, { name: string; total: number; counts: number[] }>();
  for (const r of rows) {
    const i = index.get(r.bucket);
    if (i === undefined) continue;
    let s = all.get(r.series);
    if (!s) {
      s = { name: r.series, total: 0, counts: bucketKeys.map(() => 0) };
      all.set(r.series, s);
    }
    s.total += r.count;
    s.counts[i] = (s.counts[i] ?? 0) + r.count;
  }
  const ranked = [...all.values()]
    .filter((s) => s.name !== OTHER)
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
  const top = ranked.slice(0, TOP_SERIES);
  const rest = [...ranked.slice(TOP_SERIES), ...(all.has(OTHER) ? [all.get(OTHER)] : [])];
  if (rest.length === 0) return top;
  const other = { name: OTHER, total: 0, counts: bucketKeys.map(() => 0) };
  for (const s of rest) {
    if (!s) continue;
    other.total += s.total;
    s.counts.forEach((n, i) => {
      other.counts[i] = (other.counts[i] ?? 0) + n;
    });
  }
  return [...top, other];
}
