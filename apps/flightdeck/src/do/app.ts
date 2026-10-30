import { DurableObject } from "cloudflare:workers";
import type { StoredEvent, Transition } from "@flightdeckhq/schema";

/** The slice of a `StoredEvent` an AppDO counts. */
export type CounterRow = Pick<StoredEvent, "kind" | "name" | "path" | "session_id">;

export type AppSnapshot = {
  counters: { kind: string; name: string; count: number }[];
  transitions: Transition[];
  sessions: number;
};

/** Most counters and transitions a snapshot returns, highest counts first. */
export const SNAPSHOT_LIMIT = 500;
const HOUR_MS = 3_600_000;
/** How long an hour shard keeps its data after the hour ends. */
const RETENTION_MS = 48 * HOUR_MS;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS counters (kind TEXT NOT NULL, name TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY (kind, name));
  CREATE TABLE IF NOT EXISTS transitions (source TEXT NOT NULL, target TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY (source, target));
  CREATE TABLE IF NOT EXISTS sessions (session_id TEXT PRIMARY KEY);
`;

/** Live counters for one app and one UTC hour; deletes itself 48h after the hour ends. */
export class AppDO extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(SCHEMA);
  }

  async recordEvents(hour: string, rows: CounterRow[]): Promise<void> {
    const expiry = expiryFor(hour);
    for (const r of rows) {
      this.sql.exec(
        "INSERT INTO counters (kind, name, count) VALUES (?, ?, 1) ON CONFLICT (kind, name) DO UPDATE SET count = count + 1",
        r.kind,
        r.kind === "page" ? (r.path ?? r.name) : r.name,
      );
      if (r.session_id) {
        this.sql.exec("INSERT OR IGNORE INTO sessions (session_id) VALUES (?)", r.session_id);
      }
    }
    await this.armExpiry(expiry);
  }

  async recordTransitions(hour: string, transitions: Transition[]): Promise<void> {
    const expiry = expiryFor(hour);
    for (const t of transitions) {
      this.sql.exec(
        "INSERT INTO transitions (source, target, count) VALUES (?, ?, ?) ON CONFLICT (source, target) DO UPDATE SET count = count + excluded.count",
        t.source,
        t.target,
        t.count,
      );
    }
    await this.armExpiry(expiry);
  }

  snapshot(): AppSnapshot {
    return {
      counters: this.sql
        .exec<{ kind: string; name: string; count: number }>(
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
      sessions: this.sql.exec<{ n: number }>("SELECT count(*) AS n FROM sessions").one().n,
    };
  }

  /** The hour is over and past retention: drop everything, keeping empty tables for late reads. */
  async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
    this.sql.exec(SCHEMA);
  }

  /** Set on the first write only; later writes keep the existing alarm. */
  private async armExpiry(at: number): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(at);
  }
}

/** When the shard for `hour` (e.g. `2026-10-30T14`) expires; throws before any write on a bad key. */
function expiryFor(hour: string): number {
  const start = Date.parse(`${hour}:00:00.000Z`);
  if (Number.isNaN(start)) throw new Error(`invalid hour key ${hour}`);
  return start + HOUR_MS + RETENTION_MS;
}
