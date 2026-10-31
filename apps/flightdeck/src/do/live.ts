/** Live push primitives for AppDO: coalesced deltas and a send throttle. */

const MINUTE_MS = 60_000;
/** Most distinct counters a single delta itemizes; the rest only count toward `events`. */
export const MAX_DELTA_COUNTERS = 100;

export const minuteOf = (ts: number) => Math.floor(ts / MINUTE_MS) * MINUTE_MS;

type Counter = { kind: string; name: string; count: number };
type Minute = { minute: number; count: number };

/** What changed since the last push. Counts are increments, not totals. */
export type DeltaBody = {
  events: number;
  counters: Counter[];
  minutes: Minute[];
  /** True when more counters changed than the delta itemizes; clients should refetch. */
  truncated: boolean;
  /** The shard sequence this delta starts from; it covers writes `since + 1` to `seq`. */
  since: number;
};

/** The WebSocket message an AppDO broadcasts. `sessions` and `active` are absolute. */
export type LiveDelta = DeltaBody & {
  type: "delta";
  hour: string;
  /** The shard's write sequence after this delta; snapshots carry the same counter. */
  seq: number;
  sessions: number;
  active: number;
  at: number;
};

/** The first message on a live socket: the hour end by the server clock, not the client's. */
export type LiveHello = { type: "hello"; hour: string; hour_end: number; seq: number; now: number };

/** Accumulates increments between pushes. */
export class DeltaBuffer {
  private events = 0;
  private since = 0;
  private truncated = false;
  private readonly counters = new Map<string, Counter>();
  private readonly minutes = new Map<number, Minute>();

  /** `seqBefore` is the shard sequence before the write; the first add since a take keeps it. */
  add(e: { kind: string; name: string; minute: number }, seqBefore: number): void {
    if (this.events === 0) this.since = seqBefore;
    this.events++;
    const key = `${e.kind}\u0000${e.name}`;
    const counter = this.counters.get(key);
    if (counter) counter.count++;
    else if (this.counters.size < MAX_DELTA_COUNTERS) {
      this.counters.set(key, { kind: e.kind, name: e.name, count: 1 });
    } else this.truncated = true;
    const minute = this.minutes.get(e.minute);
    if (minute) minute.count++;
    else this.minutes.set(e.minute, { minute: e.minute, count: 1 });
  }

  /** Returns and clears the pending increments, or null when nothing happened. */
  take(): DeltaBody | null {
    if (this.events === 0) return null;
    const body: DeltaBody = {
      events: this.events,
      counters: [...this.counters.values()],
      minutes: [...this.minutes.values()],
      truncated: this.truncated,
      since: this.since,
    };
    this.events = 0;
    this.truncated = false;
    this.counters.clear();
    this.minutes.clear();
    return body;
  }
}

export type Timers = { now(): number; setTimeout(fn: () => void, ms: number): unknown };

/**
 * Calls `send` at most once per `intervalMs`. A poke after a quiet period sends at once;
 * pokes inside the interval collapse into one trailing send at the end of it.
 */
export class Throttle {
  private last = Number.NEGATIVE_INFINITY;
  private scheduled = false;

  constructor(
    private readonly intervalMs: number,
    private readonly send: () => void,
    private readonly timers: Timers = { now: Date.now, setTimeout: (fn, ms) => setTimeout(fn, ms) },
  ) {}

  poke(): void {
    if (this.scheduled) return;
    const wait = this.last + this.intervalMs - this.timers.now();
    if (wait <= 0) {
      this.fire();
      return;
    }
    this.scheduled = true;
    this.timers.setTimeout(() => {
      this.scheduled = false;
      this.fire();
    }, wait);
  }

  private fire(): void {
    this.last = this.timers.now();
    this.send();
  }
}
