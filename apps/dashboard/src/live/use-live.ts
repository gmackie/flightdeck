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
 * drift (sessions counted across the hour boundary). Deltas that overlap a snapshot, leave a
 * gap after it, or are truncated trigger a refetch instead of drifting.
 */
export function useLive(appId: string) {
  const [state, setState] = useState<LiveState>({ status: "loading" });
  const [socket, setSocket] = useState<SocketStatus>("connecting");
  const [, setTick] = useState(0);
  const socketRef = useRef<LiveSocket | null>(null);
  const currentApp = useRef(appId);
  currentApp.current = appId;
  // The latest view, kept outside React state so deltas apply in arrival order and can ask
  // for a refetch synchronously.
  const viewRef = useRef<LiveView | null>(null);

  const load = useCallback(async () => {
    const result = await fetchLive(appId);
    // The user switched apps while this was in flight.
    if (currentApp.current !== appId) return;
    if (result.status === "ok") {
      viewRef.current = result.data;
      setState({ status: "ok", view: result.data });
      return;
    }
    // A failed refresh keeps the last good data on screen; the status badge shows trouble.
    if (viewRef.current && result.status === "error") return;
    viewRef.current = null;
    setState(result);
  }, [appId]);

  useEffect(() => {
    let live = true;
    let opened = false;
    viewRef.current = null;
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
        // Before the first snapshot arrives, that snapshot will include this delta.
        if (!live || !viewRef.current) return;
        const { view, resync } = applyDelta(viewRef.current, delta);
        if (view !== viewRef.current) {
          viewRef.current = view;
          setState({ status: "ok", view });
        }
        if (resync) guarded();
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
