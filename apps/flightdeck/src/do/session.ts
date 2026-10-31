import { DurableObject } from "cloudflare:workers";
import {
  EXIT,
  hourKey,
  type SessionRecord,
  START,
  type StoredEvent,
  stepName,
  type Transition,
} from "@flightdeckhq/schema";
import { sinks } from "../sinks";
import { appShard } from "./shards";

const IDLE_MS = 30 * 60_000;
const MAX_STEPS = 200;
/** A failed close retries after `CLOSE_BACKOFF_MS * attempts`, up to `MAX_CLOSE_ATTEMPTS` times. */
const CLOSE_BACKOFF_MS = 60_000;
const MAX_CLOSE_ATTEMPTS = 5;

type SessionState = {
  appId: string;
  sessionId: string;
  anonymousId: string | null;
  userId: string | null;
  startedAt: number;
  lastTs: number;
  steps: string[];
  eventCount: number;
  country: string | null;
  device: string;
  /** Failed close attempts so far; absent until a close fails. */
  closeAttempts?: number;
};

/** One visitor session: orders its steps, streams transitions, and writes a path record when idle. */
export class SessionDO extends DurableObject<Env> {
  async append(appId: string, sessionId: string, rows: StoredEvent[]): Promise<void> {
    const sorted = [...rows].sort((a, b) => a.ts - b.ts);
    const first = sorted[0];
    if (!first) return;
    const state = (await this.ctx.storage.get<SessionState>("state")) ?? {
      appId,
      sessionId,
      anonymousId: null,
      userId: null,
      startedAt: first.ts,
      lastTs: first.ts,
      steps: [],
      eventCount: 0,
      country: first.country,
      device: first.device,
    };

    const byHour = new Map<string, Map<string, Transition>>();
    for (const r of sorted) {
      state.eventCount++;
      state.startedAt = Math.min(state.startedAt, r.ts);
      state.lastTs = Math.max(state.lastTs, r.ts);
      state.userId = r.user_id ?? state.userId;
      state.anonymousId ??= r.anonymous_id;
      const step = stepName(r);
      const prev = state.steps.at(-1);
      if (!step || step === prev || state.steps.length >= MAX_STEPS) continue;
      addTransition(byHour, hourKey(r.ts), prev ?? START, step);
      state.steps.push(step);
    }

    await this.ctx.storage.put("state", state);
    await this.ctx.storage.setAlarm(Date.now() + IDLE_MS);
    await Promise.all(
      [...byHour].map(([hour, transitions]) =>
        appShard(this.env, appId, hour).recordTransitions(appId, hour, [...transitions.values()]),
      ),
    );
  }

  /**
   * Closes the idle session. State is claimed (deleted) before any external call, so events
   * appended while the close is in flight start a new session instead of being wiped.
   */
  async alarm(): Promise<void> {
    const state = await this.ctx.storage.get<SessionState>("state");
    if (!state) return;
    await this.ctx.storage.delete("state");
    try {
      await sinks.sessions(this.env, [toRecord(state)]);
      const exit = state.steps.at(-1);
      if (exit) {
        const hour = hourKey(state.lastTs);
        await appShard(this.env, state.appId, hour).recordTransitions(state.appId, hour, [
          { source: exit, target: EXIT, count: 1 },
        ]);
      }
    } catch (error) {
      await this.closeFailed(state, error);
    }
  }

  /** Puts the session back and retries with backoff; never throws, so runtime retries stay off. */
  private async closeFailed(state: SessionState, error: unknown): Promise<void> {
    const attempts = (state.closeAttempts ?? 0) + 1;
    if (attempts >= MAX_CLOSE_ATTEMPTS) {
      console.error(
        `flightdeck: dropping session ${state.appId}:${state.sessionId} after ${attempts} failed closes`,
        error,
      );
      return;
    }
    if (await this.ctx.storage.get<SessionState>("state")) {
      // An append already started a new session; it owns the alarm now, so don't cut it short.
      console.error(
        `flightdeck: close failed for ${state.appId}:${state.sessionId} after a new session began; record lost`,
        error,
      );
      return;
    }
    await this.ctx.storage.put("state", { ...state, closeAttempts: attempts });
    await this.ctx.storage.setAlarm(Date.now() + CLOSE_BACKOFF_MS * attempts);
  }
}

function addTransition(
  byHour: Map<string, Map<string, Transition>>,
  hour: string,
  source: string,
  target: string,
): void {
  let hourMap = byHour.get(hour);
  if (!hourMap) {
    hourMap = new Map();
    byHour.set(hour, hourMap);
  }
  const key = `${source}\u0000${target}`;
  const existing = hourMap.get(key);
  if (existing) existing.count++;
  else hourMap.set(key, { source, target, count: 1 });
}

function toRecord(s: SessionState): SessionRecord {
  return {
    session_id: s.sessionId,
    app_id: s.appId,
    anonymous_id: s.anonymousId,
    user_id: s.userId,
    started_at: s.startedAt,
    ended_at: s.lastTs,
    duration_ms: s.lastTs - s.startedAt,
    entry: s.steps[0] ?? null,
    exit: s.steps.at(-1) ?? null,
    steps: [...s.steps],
    step_count: s.steps.length,
    event_count: s.eventCount,
    country: s.country,
    device: s.device,
  };
}
