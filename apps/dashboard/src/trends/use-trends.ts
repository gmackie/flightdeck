import { useEffect, useState } from "react";
import { getJson, type Loaded } from "../api";
import type { Range } from "../pages/range-filter";

export const BREAKDOWNS = [
  { id: "kind", label: "Kind" },
  { id: "name", label: "Event" },
  { id: "page", label: "Page" },
] as const;
export type Breakdown = (typeof BREAKDOWNS)[number]["id"];

/** The API's name for everything outside the top series. */
export const OTHER = "$other";

/** `GET /api/apps/:id/trends`: UTC buckets, oldest first, with one count per bucket per series. */
export type TrendsView = {
  app_id: string;
  range: Range;
  breakdown: Breakdown;
  kind: string | null;
  bucket: "hour" | "day";
  buckets: number[];
  series: { name: string; total: number; counts: number[] }[];
  totals: { events: number; sessions: number };
};

function isTrendsView(value: unknown): value is TrendsView {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  const totals = v.totals as Record<string, unknown> | undefined;
  return (
    (v.bucket === "hour" || v.bucket === "day") &&
    Array.isArray(v.buckets) &&
    Array.isArray(v.series) &&
    v.series.every((s) => typeof s?.name === "string" && Array.isArray(s.counts)) &&
    typeof totals?.events === "number" &&
    typeof totals.sessions === "number"
  );
}

export function fetchTrends(appId: string, range: Range, breakdown: Breakdown) {
  const query = new URLSearchParams({ range, breakdown });
  return getJson(`/api/apps/${encodeURIComponent(appId)}/trends?${query}`, isTrendsView, "trends");
}

export type TrendsState =
  | { status: "loading"; previous: TrendsView | null }
  | Exclude<Loaded<TrendsView>, { status: "ok" }>
  | { status: "ok"; view: TrendsView };

/** Fetches whenever the app, range or breakdown changes; keeps the last view while loading. */
export function useTrends(appId: string, range: Range, breakdown: Breakdown): TrendsState {
  const [state, setState] = useState<TrendsState>({ status: "loading", previous: null });
  useEffect(() => {
    let live = true;
    setState((prev) => ({
      status: "loading",
      previous: prev.status === "ok" ? prev.view : prev.status === "loading" ? prev.previous : null,
    }));
    fetchTrends(appId, range, breakdown).then((result) => {
      if (!live) return;
      setState(result.status === "ok" ? { status: "ok", view: result.data } : result);
    });
    return () => {
      live = false;
    };
  }, [appId, range, breakdown]);
  return state;
}
