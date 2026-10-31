import type { SessionRecord, StoredEvent } from "@flightdeckhq/schema";

/** Optional stream fields are omitted on the wire; nested JSON nulls are retained. */
export function streamRow<T extends object>(
  row: T,
): { [K in keyof T]: Exclude<T[K], null> | (null extends T[K] ? undefined : never) } {
  return Object.fromEntries(Object.entries(row).filter(([, value]) => value !== null)) as {
    [K in keyof T]: Exclude<T[K], null> | (null extends T[K] ? undefined : never);
  };
}

/** Pipelines writes go through this object so tests can stub them with `vi.spyOn(sinks, ...)`. */
export const sinks = {
  events: (env: Env, rows: StoredEvent[]): Promise<void> => env.EVENTS.send(rows.map(streamRow)),
  sessions: (env: Env, rows: SessionRecord[]): Promise<void> =>
    env.SESSIONS.send(rows.map(streamRow)),
};
