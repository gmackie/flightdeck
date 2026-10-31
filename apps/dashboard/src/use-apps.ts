import { useCallback, useEffect, useState } from "react";
import { type AppsResult, fetchApps } from "./api";

export type AppsState = { status: "loading" } | AppsResult;

/** Loads `/api/apps` once on mount; `reload` fetches again (e.g. after an error). */
export function useApps(enabled = true): [AppsState, () => void] {
  const [state, setState] = useState<AppsState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` re-runs the fetch on reload.
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    setState({ status: "loading" });
    fetchApps().then((result) => live && setState(result));
    return () => {
      live = false;
    };
  }, [attempt, enabled]);
  return [state, useCallback(() => setAttempt((n) => n + 1), [])];
}
