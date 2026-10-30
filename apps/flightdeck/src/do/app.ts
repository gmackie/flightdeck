import { DurableObject } from "cloudflare:workers";
import type { StoredEvent, Transition } from "@flightdeckhq/schema";

export type AppSnapshot = {
  counters: { kind: string; name: string; count: number }[];
  transitions: Transition[];
  sessions: number;
};

/** Live counters for one app and one UTC hour. */
export class AppDO extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS counters (kind TEXT NOT NULL, name TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY (kind, name));
      CREATE TABLE IF NOT EXISTS transitions (source TEXT NOT NULL, target TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY (source, target));
      CREATE TABLE IF NOT EXISTS sessions (session_id TEXT PRIMARY KEY);
    `);
  }

  recordEvents(rows: StoredEvent[]): void {
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
  }

  recordTransitions(transitions: Transition[]): void {
    for (const t of transitions) {
      this.sql.exec(
        "INSERT INTO transitions (source, target, count) VALUES (?, ?, ?) ON CONFLICT (source, target) DO UPDATE SET count = count + excluded.count",
        t.source,
        t.target,
        t.count,
      );
    }
  }

  snapshot(): AppSnapshot {
    return {
      counters: this.sql
        .exec<{ kind: string; name: string; count: number }>(
          "SELECT kind, name, count FROM counters ORDER BY kind, name",
        )
        .toArray(),
      transitions: this.sql
        .exec<Transition>("SELECT source, target, count FROM transitions ORDER BY source, target")
        .toArray(),
      sessions: this.sql.exec<{ n: number }>("SELECT count(*) AS n FROM sessions").one().n,
    };
  }
}
