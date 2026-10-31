import { DurableObject } from "cloudflare:workers";
import type { StoredEvent, Transition } from "@flightdeckhq/schema";
import { writeHourlyRollup } from "../rollups";
import { DeltaBuffer, type LiveDelta, minuteOf, Throttle } from "./live";

/** The slice of a `StoredEvent` an AppDO counts. */
export type CounterRow = Pick<StoredEvent, "kind" | "name" | "path" | "session_id" | "ts">;

type Counter = { kind: string; name: string; count: number };

export type AppSnapshot = {
  /** Event counts by kind over every counter, not just the top ones. */
  totals: { kind: string; count: number }[];
  counters: Counter[];
  transitions: Transition[];
  sessions: number;
  /** Events per UTC minute of this hour (epoch ms of the minute start); at most 60. */
  minutes: { minute: number; count: number }[];
  /** Sessions whose latest event in this hour is at or after `activeSince`. */
  active: number;
};

/** What a finalized hour contributes to the D1 warm tier. */
export type HourRollup = { counters: Counter[]; sessions: number };

/** Most counters and transitions a snapshot returns, highest counts first. */
export const SNAPSHOT_LIMIT = 500;
/** Most names per hour a rollup keeps; the rest fold into one `$other` row per kind. */
export const ROLLUP_LIMIT = 1000;
export const OTHER = "$other";
/** A session is active while its latest event is at most this old. */
export const ACTIVE_WINDOW_MS = 5 * 60_000;
/** How long after its hour ends a shard waits for late events before flushing to D1. */
export const FLUSH_GRACE_MS = 10 * 60_000;
/** A late event after the flush schedules another one this soon. */
const LATE_FLUSH_DELAY_MS = 60_000;
/** A failed flush retries this much later, until the shard expires. */
const FLUSH_RETRY_MS = 5 * 60_000;
/** Live deltas go out at most once per this interval. */
const PUSH_INTERVAL_MS = 1_000;
const HOUR_MS = 3_600_000;
/** How long an hour shard keeps its data after the hour ends. */
const RETENTION_MS = 48 * HOUR_MS;
/** Close code telling live clients the hour is over and they should move to the next one. */
export const HOUR_CLOSED = 4000;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS counters (kind TEXT NOT NULL, name TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY (kind, name));
  CREATE TABLE IF NOT EXISTS transitions (source TEXT NOT NULL, target TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY (source, target));
  CREATE TABLE IF NOT EXISTS sessions (session_id TEXT PRIMARY KEY, last_ts INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS minutes (minute INTEGER PRIMARY KEY, count INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

/**
 * Live counters for one app and one UTC hour. Pushes deltas to WebSocket clients, flushes the
 * hour into D1 once it is over, and deletes itself 48h after the hour ends.
 */
export class AppDO extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  private readonly pending = new DeltaBuffer();
  private readonly push = new Throttle(PUSH_INTERVAL_MS, () => this.broadcast());

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(SCHEMA);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    // Shards created before minute buckets lack `last_ts`; they expire within 48h.
    const columns = this.sql.exec<{ name: string }>(
      "SELECT name FROM pragma_table_info('sessions')",
    );
    if (!columns.toArray().some((c) => c.name === "last_ts")) {
      this.sql.exec("ALTER TABLE sessions ADD COLUMN last_ts INTEGER NOT NULL DEFAULT 0");
    }
  }

  async recordEvents(appId: string, hour: string, rows: CounterRow[]): Promise<void> {
    const start = hourStart(hour);
    const live = this.ctx.getWebSockets().length > 0;
    this.remember(appId, hour);
    for (const r of rows) {
      const name = r.kind === "page" ? (r.path ?? r.name) : r.name;
      // Rows belong to this hour; clamping keeps a stray timestamp from adding a 61st bucket.
      const minute = minuteOf(Math.min(Math.max(r.ts, start), start + HOUR_MS - 1));
      this.sql.exec(
        "INSERT INTO counters (kind, name, count) VALUES (?, ?, 1) ON CONFLICT (kind, name) DO UPDATE SET count = count + 1",
        r.kind,
        name,
      );
      this.sql.exec(
        "INSERT INTO minutes (minute, count) VALUES (?, 1) ON CONFLICT (minute) DO UPDATE SET count = count + 1",
        minute,
      );
      if (r.session_id) {
        this.sql.exec(
          "INSERT INTO sessions (session_id, last_ts) VALUES (?, ?) ON CONFLICT (session_id) DO UPDATE SET last_ts = max(last_ts, excluded.last_ts)",
          r.session_id,
          r.ts,
        );
      }
      if (live) this.pending.add({ kind: r.kind, name, minute });
    }
    await this.armFlush(start);
    if (live) this.push.poke();
  }

  async recordTransitions(appId: string, hour: string, transitions: Transition[]): Promise<void> {
    const start = hourStart(hour);
    this.remember(appId, hour);
    for (const t of transitions) {
      this.sql.exec(
        "INSERT INTO transitions (source, target, count) VALUES (?, ?, ?) ON CONFLICT (source, target) DO UPDATE SET count = count + excluded.count",
        t.source,
        t.target,
        t.count,
      );
    }
    await this.armFlush(start);
  }

  snapshot(activeSince = Date.now() - ACTIVE_WINDOW_MS): AppSnapshot {
    return {
      totals: this.sql
        .exec<{ kind: string; count: number }>(
          "SELECT kind, sum(count) AS count FROM counters GROUP BY kind ORDER BY count DESC, kind",
        )
        .toArray(),
      counters: this.sql
        .exec<Counter>(
          "SELECT kind, name, count FROM counters ORDER BY count DESC, kind, name LIMIT ?",
          SNAPSHOT_LIMIT,
        )
        .toArray(),
      transitions: this.sql
        .exec<Transition>(
          "SELECT source, target, count FROM transitions ORDER BY count DESC, source, target LIMIT ?",
          SNAPSHOT_LIMIT,
        )
        .toArray(),
      sessions: this.sessionCount(),
      minutes: this.sql
        .exec<{ minute: number; count: number }>(
          "SELECT minute, count FROM minutes ORDER BY minute",
        )
        .toArray(),
      active: this.activeCount(activeSince),
    };
  }

  /** Ids of sessions active since `since`, so a window spanning two hours can be de-duplicated. */
  activeSessionIds(since: number): string[] {
    return this.sql
      .exec<{ session_id: string }>("SELECT session_id FROM sessions WHERE last_ts >= ?", since)
      .toArray()
      .map((r) => r.session_id);
  }

  /** The hour's counters, capped at `ROLLUP_LIMIT` names with the rest folded into `$other`. */
  rollup(): HourRollup {
    const counters = this.sql
      .exec<Counter>(
        "SELECT kind, name, count FROM counters ORDER BY count DESC, kind, name LIMIT ?",
        ROLLUP_LIMIT,
      )
      .toArray();
    if (counters.length === ROLLUP_LIMIT) {
      const rest = this.sql.exec<{ kind: string; count: number }>(
        `SELECT kind, sum(count) AS count FROM counters WHERE (kind, name) NOT IN
           (SELECT kind, name FROM counters ORDER BY count DESC, kind, name LIMIT ?)
         GROUP BY kind ORDER BY kind`,
        ROLLUP_LIMIT,
      );
      for (const r of rest) counters.push({ kind: r.kind, name: OTHER, count: r.count });
    }
    return { counters, sessions: this.sessionCount() };
  }

  /** Live clients connect here (via the Worker's Access-checked `/api/apps/:id/live/ws`). */
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected a WebSocket upgrade", { status: 426 });
    }
    const { 0: client, 1: server } = new WebSocketPair();
    // Hibernation API: the shard can sleep between events without dropping the socket.
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Clients only listen; the auto-response answers "ping" keepalives without waking us. */
  async webSocketMessage(): Promise<void> {}

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    try {
      ws.close(code === 1005 ? 1000 : code, "closing");
    } catch {
      // Already closed.
    }
  }

  /**
   * Flushes the finalized hour into D1 (re-run after late events; the write overwrites), then
   * waits for expiry. At expiry it drops everything, keeping empty tables for late reads.
   */
  async alarm(): Promise<void> {
    const meta = this.meta();
    if (!meta || Date.now() >= hourStart(meta.hour) + HOUR_MS + RETENTION_MS) {
      this.closeSockets();
      await this.ctx.storage.deleteAll();
      this.sql.exec(SCHEMA);
      return;
    }
    const expiry = hourStart(meta.hour) + HOUR_MS + RETENTION_MS;
    if (Date.now() >= hourStart(meta.hour) + HOUR_MS) this.closeSockets();
    try {
      await writeHourlyRollup(this.env.DB, meta.appId, meta.hour, this.rollup());
    } catch (err) {
      console.error(`flightdeck: rollup flush failed for ${meta.appId} ${meta.hour}`, err);
      await this.ctx.storage.setAlarm(Math.min(Date.now() + FLUSH_RETRY_MS, expiry));
      return;
    }
    await this.ctx.storage.setAlarm(expiry);
  }

  private sessionCount(): number {
    return this.sql.exec<{ n: number }>("SELECT count(*) AS n FROM sessions").one().n;
  }

  private activeCount(since: number): number {
    return this.sql
      .exec<{ n: number }>("SELECT count(*) AS n FROM sessions WHERE last_ts >= ?", since)
      .one().n;
  }

  private remember(appId: string, hour: string): void {
    this.sql.exec(
      "INSERT OR IGNORE INTO meta (key, value) VALUES ('app_id', ?), ('hour', ?)",
      appId,
      hour,
    );
  }

  private meta(): { appId: string; hour: string } | null {
    const rows = this.sql.exec<{ key: string; value: string }>("SELECT key, value FROM meta");
    const m = Object.fromEntries(rows.toArray().map((r) => [r.key, r.value]));
    return m.app_id && m.hour ? { appId: m.app_id, hour: m.hour } : null;
  }

  /**
   * The flush runs `FLUSH_GRACE_MS` after the hour ends; a write after that pulls it in to
   * `LATE_FLUSH_DELAY_MS` from now. An earlier pending alarm is kept.
   */
  private async armFlush(start: number): Promise<void> {
    const at = Math.max(start + HOUR_MS + FLUSH_GRACE_MS, Date.now() + LATE_FLUSH_DELAY_MS);
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > at) await this.ctx.storage.setAlarm(at);
  }

  private broadcast(): void {
    const body = this.pending.take();
    const meta = this.meta();
    if (!body || !meta) return;
    const now = Date.now();
    const delta: LiveDelta = {
      type: "delta",
      hour: meta.hour,
      ...body,
      sessions: this.sessionCount(),
      active: this.activeCount(now - ACTIVE_WINDOW_MS),
      at: now,
    };
    const message = JSON.stringify(delta);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(message);
      } catch {
        // A socket mid-close; the runtime cleans it up.
      }
    }
  }

  private closeSockets(): void {
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(HOUR_CLOSED, "hour closed");
      } catch {
        // Already closed.
      }
    }
  }
}

/** The start of `hour` (e.g. `2026-10-30T14`) in epoch ms; throws before any write on a bad key. */
function hourStart(hour: string): number {
  const start = Date.parse(`${hour}:00:00.000Z`);
  if (Number.isNaN(start)) throw new Error(`invalid hour key ${hour}`);
  return start;
}
