import { useCallback, useEffect, useRef, useState } from "react";
import { getJson, type Loaded } from "../api";
import { applyDelta, isLiveView, type LiveView } from "./model";
import { LiveSocket, liveSocketUrl, type SocketStatus } from "./socket";

/** How often to refetch while the socket is down, and to reconcile while it is up. */
export const POLL_MS = 10_000;
export const RECONCILE_MS = 60_000;
/** Re-render this often so the minute chart and the rate keep moving without events. */
const TICK_MS = 15_000;

export type LiveState =
  | { status: "loading" }
  | Exclude<Loaded<LiveView>, { status: "ok" }>
  | {
      status: "ok";
      view: LiveView;
    };

export const fetchLive = (appId: string) =>
  getJson(`/api/apps/${encodeURIComponent(appId)}/live`, isLiveView, "live data");

/**
 * The Live page's data: a snapshot fetch, then WebSocket deltas folded in. While the socket is
 * down the snapshot is polled instead; while it is up it is refetched now and then to correct
 * drift (truncated deltas, sessions counted across the hour boundary).
 */
export function useLive(appId: string) {
  const [state, setState] = useState<LiveState>({ status: "loading" });
  const [socket, setSocket] = useState<SocketStatus>("connecting");
  const [, setTick] = useState(0);
  const socketRef = useRef<LiveSocket | null>(null);
  const currentApp = useRef(appId);
  currentApp.current = appId;

  const load = useCallback(async () => {
    const result = await fetchLive(appId);
    // The user switched apps while this was in flight.
    if (currentApp.current !== appId) return;
    setState((prev) => {
      if (result.status === "ok") return { status: "ok", view: result.data };
      // A failed refresh keeps the last good data on screen; the status badge shows trouble.
      return prev.status === "ok" && result.status === "error" ? prev : result;
    });
  }, [appId]);

  useEffect(() => {
    let live = true;
    let opened = false;
    setState({ status: "loading" });
    const guarded = () => {
      if (live) void load();
    };
    guarded();
    const ws = new LiveSocket(liveSocketUrl(appId), {
      onStatus: (s) => live && setSocket(s),
      // The first open races the initial fetch; later ones catch up on what was missed.
      onOpen: () => {
        if (opened) guarded();
        opened = true;
      },
      onDelta: (delta) => {
        if (!live) return;
        setState((prev) =>
          prev.status === "ok" ? { status: "ok", view: applyDelta(prev.view, delta) } : prev,
        );
        if (delta.truncated) guarded();
      },
    });
    socketRef.current = ws;
    ws.start();
    return () => {
      live = false;
      ws.stop();
      socketRef.current = null;
    };
  }, [appId, load]);

  useEffect(() => {
    const id = setInterval(() => void load(), socket === "open" ? RECONCILE_MS : POLL_MS);
    return () => clearInterval(id);
  }, [socket, load]);

  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), TICK_MS);
    return () => clearInterval(id);
  }, []);

  const reconnect = useCallback(() => socketRef.current?.reconnect(), []);
  return { state, socket, reconnect };
}
