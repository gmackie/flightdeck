import { vi } from "vitest";
import type { App } from "../src/api";

export const APPS: App[] = [
  { id: "app_alpha", name: "Alpha", created_at: Date.UTC(2026, 9, 1) },
  { id: "app_beta", name: "Beta", created_at: Date.UTC(2026, 9, 2) },
];

type Route = (url: URL) => { status?: number; body: unknown } | undefined;

/** An empty `GET /api/apps/:id/live` answer. */
export const emptyLive = (appId: string, now = Date.now()) => ({
  app_id: appId,
  now,
  active_window_ms: 300_000,
  active_sessions: 0,
  hours: [0, 1].map((i) => {
    const start = Math.floor(now / 3_600_000) * 3_600_000 - i * 3_600_000;
    return {
      hour: new Date(start).toISOString().slice(0, 13),
      start,
      totals: [],
      counters: [],
      transitions: [],
      sessions: 0,
      seq: 0,
      minutes: [],
    };
  }),
});

/** An empty `GET /api/apps/:id/trends` answer for the requested range and breakdown. */
export const emptyTrends = (url: URL) => ({
  app_id: url.pathname.split("/")[3],
  range: url.searchParams.get("range"),
  breakdown: url.searchParams.get("breakdown"),
  kind: null,
  bucket: url.searchParams.get("range") === "24h" ? "hour" : "day",
  buckets: [],
  series: [],
  totals: { events: 0, sessions: 0 },
});

/**
 * Stubs `fetch`: `GET /api/apps` answers with `status` and `body`; `route` may answer any
 * URL first; live and trends reads otherwise get empty views.
 */
export function mockApps(status: number, body: unknown = { apps: APPS }, route?: Route) {
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "https://flightdeck.test");
    const routed = route?.(url);
    if (routed) return Response.json(routed.body, { status: routed.status ?? 200 });
    if (url.pathname === "/api/apps") {
      return new Response(status === 401 ? null : JSON.stringify(body), { status });
    }
    if (url.pathname.endsWith("/live"))
      return Response.json(emptyLive(url.pathname.split("/")[3] ?? ""));
    if (url.pathname.endsWith("/trends")) return Response.json(emptyTrends(url));
    return new Response(null, { status: 404 });
  });
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

/** The URLs `fetch` was called with, as paths with queries. */
export const fetchedPaths = (fetcher: ReturnType<typeof mockApps>) =>
  fetcher.mock.calls.map(([input]) => {
    const url = new URL(String(input), "https://flightdeck.test");
    return url.pathname + url.search;
  });

/** A WebSocket the test drives: `open()`, `receive()` and `serverClose()` play the server. */
export class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static readonly OPEN = 1;
  readyState = 0;
  sent: string[] = [];
  closedByClient: number | null = null;
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  static latest(): FakeWebSocket {
    const ws = FakeWebSocket.instances.at(-1);
    if (!ws) throw new Error("no WebSocket was opened");
    return ws;
  }

  static reset(): void {
    FakeWebSocket.instances = [];
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code = 1000): void {
    this.readyState = 3;
    this.closedByClient = code;
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.(new Event("open"));
  }

  receive(data: unknown): void {
    this.onmessage?.(
      new MessageEvent("message", { data: typeof data === "string" ? data : JSON.stringify(data) }),
    );
  }

  serverClose(code = 1006): void {
    this.readyState = 3;
    this.onclose?.(new CloseEvent("close", { code }));
  }
}
