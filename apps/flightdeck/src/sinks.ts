import type { SessionRecord, StoredEvent } from "@flightdeckhq/schema";

/** Pipelines writes go through this object so tests can stub them with `vi.spyOn(sinks, ...)`. */
export const sinks = {
  events: (env: Env, rows: StoredEvent[]): Promise<void> => env.EVENTS.send(rows),
  sessions: (env: Env, rows: SessionRecord[]): Promise<void> => env.SESSIONS.send(rows),
};
