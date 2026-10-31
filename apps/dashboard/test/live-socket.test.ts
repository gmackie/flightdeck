import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  backoffDelay,
  HOUR_CLOSED,
  LiveSocket,
  OFFLINE_AFTER,
  PING_INTERVAL_MS,
  type SocketStatus,
} from "../src/live/socket";
import { FakeWebSocket } from "./helpers";

const URL = "wss://flightdeck.test/api/apps/app_alpha/live/ws";
const delta = { type: "delta", hour: "2026-10-30T14", events: 1, counters: [], minutes: [], at: 1 };

beforeEach(() => {
  FakeWebSocket.reset();
  vi.useFakeTimers();
  vi.setSystemTime(Date.UTC(2026, 9, 30, 14, 30));
});
afterEach(() => vi.useRealTimers());

function start() {
  const statuses: SocketStatus[] = [];
  const deltas: unknown[] = [];
  const onOpen = vi.fn();
  const socket = new LiveSocket(
    URL,
    { onDelta: (d) => deltas.push(d), onStatus: (s) => statuses.push(s), onOpen },
    { WebSocket: FakeWebSocket as unknown as typeof WebSocket, random: () => 0 },
  );
  socket.start();
  return { socket, statuses, deltas, onOpen };
}

describe("backoffDelay", () => {
  it("doubles from 1s up to 30s, with jitter down to half", () => {
    expect([0, 1, 2, 3, 4, 5, 6].map((n) => backoffDelay(n, 1))).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000,
    ]);
    expect(backoffDelay(2, 0)).toBe(2_000);
  });
});

describe("LiveSocket", () => {
  it("connects, passes deltas through and ignores anything else", () => {
    const { statuses, deltas, onOpen } = start();
    expect(FakeWebSocket.latest().url).toBe(URL);
    expect(statuses).toEqual(["connecting"]);
    FakeWebSocket.latest().open();
    expect(statuses.at(-1)).toBe("open");
    expect(onOpen).toHaveBeenCalledTimes(1);
    FakeWebSocket.latest().receive(delta);
    FakeWebSocket.latest().receive("pong");
    FakeWebSocket.latest().receive("{not json");
    FakeWebSocket.latest().receive({ type: "other" });
    expect(deltas).toEqual([delta]);
  });

  it("reconnects with backoff and reports offline after repeated failures", () => {
    const { statuses } = start();
    for (let attempt = 0; attempt < OFFLINE_AFTER; attempt++) {
      const count = FakeWebSocket.instances.length;
      FakeWebSocket.latest().serverClose(1006);
      vi.advanceTimersByTime(backoffDelay(attempt, 0) - 1);
      expect(FakeWebSocket.instances).toHaveLength(count);
      vi.advanceTimersByTime(1);
      expect(FakeWebSocket.instances).toHaveLength(count + 1);
    }
    expect(statuses).toContain("reconnecting");
    expect(statuses.at(-1)).toBe("offline");
    // A successful connection resets the backoff.
    FakeWebSocket.latest().open();
    expect(statuses.at(-1)).toBe("open");
    FakeWebSocket.latest().serverClose(1006);
    vi.advanceTimersByTime(backoffDelay(0, 0));
    expect(FakeWebSocket.instances).toHaveLength(OFFLINE_AFTER + 2);
  });

  it("moves to the next hour's shard at once when the server closes the hour", () => {
    start();
    FakeWebSocket.latest().open();
    FakeWebSocket.latest().serverClose(HOUR_CLOSED);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("reconnects shortly after the hour turns", () => {
    start();
    const first = FakeWebSocket.latest();
    first.open();
    vi.advanceTimersByTime(29 * 60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(60_000 + 1_000);
    expect(first.closedByClient).toBe(1000);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("pings to keep the connection alive", () => {
    start();
    FakeWebSocket.latest().open();
    vi.advanceTimersByTime(PING_INTERVAL_MS);
    expect(FakeWebSocket.latest().sent).toEqual(["ping"]);
  });

  it("reconnects on demand and stops cleanly", () => {
    const { socket } = start();
    FakeWebSocket.latest().serverClose(1006);
    socket.reconnect();
    expect(FakeWebSocket.instances).toHaveLength(2);
    socket.stop();
    expect(FakeWebSocket.latest().closedByClient).toBe(1000);
    vi.advanceTimersByTime(60 * 60_000);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });
});
