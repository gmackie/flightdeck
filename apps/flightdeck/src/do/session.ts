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
        appShard(this.env, appId, hour).recordTransitions([...transitions.values()]),
      ),
    );
  }

  async alarm(): Promise<void> {
    const state = await this.ctx.storage.get<SessionState>("state");
    if (!state) return;
    await sinks.sessions(this.env, [toRecord(state)]);
    const exit = state.steps.at(-1);
    if (exit) {
      await appShard(this.env, state.appId, hourKey(state.lastTs)).recordTransitions([
        { source: exit, target: EXIT, count: 1 },
      ]);
    }
    await this.ctx.storage.deleteAll();
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
    steps: JSON.stringify(s.steps),
    step_count: s.steps.length,
    event_count: s.eventCount,
    country: s.country,
    device: s.device,
  };
}
