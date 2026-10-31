import { hourKey } from "@flightdeckhq/schema";
import { ACTIVE_WINDOW_MS, type AppSnapshot } from "../do/app";
import { appShard } from "../do/shards";
import { fail } from "./http";

const HOUR_MS = 3_600_000;
export const DEFAULT_LIVE_HOURS = 2;
/** AppDOs keep 48h; a day of hourly snapshots is plenty for a live view. */
export const MAX_LIVE_HOURS = 24;

export type LiveHour = Omit<AppSnapshot, "active"> & { hour: string; start: number };

export type LiveView = {
  app_id: string;
  now: number;
  active_window_ms: number;
  /** Distinct sessions whose latest event is within `active_window_ms` of `now`. */
  active_sessions: number;
  /** Newest first: `hours[0]` is the current UTC hour. */
  hours: LiveHour[];
};

/** `?hours=` as an integer in 1..24; null when invalid. */
export function parseHours(param: string | null): number | null {
  if (param === null) return DEFAULT_LIVE_HOURS;
  if (!/^\d{1,2}$/.test(param)) return null;
  const hours = Number(param);
  return hours >= 1 && hours <= MAX_LIVE_HOURS ? hours : null;
}

/** Snapshots of the last `hours` hour shards of an already-verified app. */
export async function liveView(
  env: Env,
  appId: string,
  hours: number,
  now = Date.now(),
): Promise<LiveView> {
  const since = now - ACTIVE_WINDOW_MS;
  const keys = Array.from({ length: hours }, (_, i) => hourKey(now - i * HOUR_MS));
  const snapshots = await Promise.all(
    keys.map((hour) => appShard(env, appId, hour).snapshot(since)),
  );
  const current = keys[0] as string;
  const currentStart = Date.parse(`${current}:00:00.000Z`);
  let active = snapshots[0]?.active ?? 0;
  // Early in an hour the window reaches into the previous shard. Only its few in-window ids
  // travel; the current shard counts the union, so a session active on both sides counts once.
  if (since < currentStart) {
    const previous = await appShard(env, appId, hourKey(now - HOUR_MS)).activeSessionIds(since);
    if (previous.length > 0) {
      active = await appShard(env, appId, current).activeUnion(since, previous);
    }
  }
  return {
    app_id: appId,
    now,
    active_window_ms: ACTIVE_WINDOW_MS,
    active_sessions: active,
    hours: snapshots.map(({ active: _, ...snap }, i) => {
      const hour = keys[i] as string;
      return { hour, start: Date.parse(`${hour}:00:00.000Z`), ...snap };
    }),
  };
}

/**
 * Hands an Access-checked WebSocket upgrade to the current hour's AppDO. The shard name comes
 * from the verified app id and the server clock only; clients reconnect when the hour turns.
 */
export async function liveSocket(request: Request, env: Env, appId: string): Promise<Response> {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return fail(426, "Expected a WebSocket upgrade", { Upgrade: "websocket" });
  }
  // Upgrades skip CORS but carry the Access cookie; refuse other sites' pages.
  const origin = request.headers.get("Origin");
  if (origin && originHost(origin) !== new URL(request.url).host) {
    return fail(403, "Cross-origin WebSocket");
  }
  const hour = hourKey(Date.now());
  // The shard learns its app and hour from the Worker, never from the client's query.
  const target = new URL("https://app-do/live");
  target.searchParams.set("app", appId);
  target.searchParams.set("hour", hour);
  return appShard(env, appId, hour).fetch(target, { headers: { Upgrade: "websocket" } });
}

function originHost(origin: string): string | null {
  try {
    return new URL(origin).host;
  } catch {
    return null;
  }
}
