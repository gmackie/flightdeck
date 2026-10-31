import { isLiveDelta, type LiveDelta } from "./model";

/** `offline` means the socket keeps failing; the page falls back to polling meanwhile. */
export type SocketStatus = "connecting" | "open" | "reconnecting" | "offline";

/** Close code the AppDO sends when its hour is over (matches the Worker's `HOUR_CLOSED`). */
export const HOUR_CLOSED = 4000;
export const OFFLINE_AFTER = 3;
export const PING_INTERVAL_MS = 30_000;
const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 30_000;
const HOUR_MS = 3_600_000;
/** Reconnect this long after the hour turns (plus jitter), once the new shard exists. */
const ROLLOVER_DELAY_MS = 1_000;
const ROLLOVER_JITTER_MS = 2_000;

/** Exponential backoff capped at 30s; `random` in [0, 1) scales it down by up to half. */
export function backoffDelay(failures: number, random: number): number {
  const full = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** failures);
  return Math.round(full * (0.5 + random * 0.5));
}

/** The live socket URL on the dashboard's own origin. */
export function liveSocketUrl(appId: string, loc: Location = location): string {
  const scheme = loc.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${loc.host}/api/apps/${encodeURIComponent(appId)}/live/ws`;
}

type Handlers = {
  onDelta(delta: LiveDelta): void;
  onStatus(status: SocketStatus): void;
  /** Every successful (re)connect: a chance to refetch what was missed. */
  onOpen?(): void;
};

type Deps = { WebSocket: typeof WebSocket; random(): number };

/**
 * One app's live delta stream. Each UTC hour is a separate AppDO, so the socket moves to the
 * new hour shortly after it turns (or at once when the server closes the old one).
 */
export class LiveSocket {
  private ws: WebSocket | null = null;
  private failures = 0;
  private stopped = true;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private rollover: ReturnType<typeof setTimeout> | undefined;
  private ping: ReturnType<typeof setInterval> | undefined;
  private readonly deps: Deps;

  constructor(
    private readonly url: string,
    private readonly handlers: Handlers,
    deps: Partial<Deps> = {},
  ) {
    this.deps = { WebSocket: globalThis.WebSocket, random: Math.random, ...deps };
  }

  start(): void {
    this.stopped = false;
    this.handlers.onStatus("connecting");
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.teardown();
  }

  /** A manual retry: drops any pending backoff and connects now. */
  reconnect(): void {
    this.teardown();
    this.failures = 0;
    this.stopped = false;
    this.handlers.onStatus("connecting");
    this.connect();
  }

  private connect(): void {
    let ws: WebSocket;
    try {
      ws = new this.deps.WebSocket(this.url);
    } catch {
      this.fail();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.failures = 0;
      this.handlers.onStatus("open");
      this.handlers.onOpen?.();
      this.ping = setInterval(() => ws.send("ping"), PING_INTERVAL_MS);
      const next = (Math.floor(Date.now() / HOUR_MS) + 1) * HOUR_MS;
      const jitter = Math.round(this.deps.random() * ROLLOVER_JITTER_MS);
      this.rollover = setTimeout(
        () => this.cycle(),
        next - Date.now() + ROLLOVER_DELAY_MS + jitter,
      );
    };
    ws.onmessage = (ev: MessageEvent) => {
      if (typeof ev.data !== "string" || ev.data === "pong") return;
      let message: unknown;
      try {
        message = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (isLiveDelta(message)) this.handlers.onDelta(message);
    };
    ws.onclose = (ev: CloseEvent) => {
      this.clearTimers();
      this.ws = null;
      if (this.stopped) return;
      if (ev.code === HOUR_CLOSED) this.connect();
      else this.fail();
    };
  }

  /** Moves to the new hour's shard without counting a failure. */
  private cycle(): void {
    this.teardown();
    this.connect();
  }

  private fail(): void {
    const delay = backoffDelay(this.failures, this.deps.random());
    this.failures++;
    this.handlers.onStatus(this.failures >= OFFLINE_AFTER ? "offline" : "reconnecting");
    this.retry = setTimeout(() => this.connect(), delay);
  }

  private teardown(): void {
    this.clearTimers();
    clearTimeout(this.retry);
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    ws.onopen = ws.onmessage = ws.onclose = null;
    ws.close(1000);
  }

  private clearTimers(): void {
    clearInterval(this.ping);
    clearTimeout(this.rollover);
  }
}
