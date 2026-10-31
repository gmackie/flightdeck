import { useSyncExternalStore } from "react";

export type PageId =
  | "live"
  | "trends"
  | "workflows"
  | "journeys"
  | "funnels"
  | "retention"
  | "apps";

export const PAGES: PageId[] = [
  "live",
  "trends",
  "workflows",
  "journeys",
  "funnels",
  "retention",
  "apps",
];

/** The selected app lives in `?app=`, so links and reloads keep it. */
export const APP_PARAM = "app";

const NAVIGATE = "fd:navigate";

function subscribe(onChange: () => void): () => void {
  addEventListener("popstate", onChange);
  addEventListener(NAVIGATE, onChange);
  return () => {
    removeEventListener("popstate", onChange);
    removeEventListener(NAVIGATE, onChange);
  };
}

const snapshot = () => location.pathname + location.search;

/** Re-renders on every navigation; returns `pathname + search`. */
export function useLocation(): string {
  return useSyncExternalStore(subscribe, snapshot);
}

/** `?view=demo` opts into the synthetic Workflows demo; live data is the default. */
export const VIEW_PARAM = "view";

export function isDemoView(search = location.search): boolean {
  return new URLSearchParams(search).get(VIEW_PARAM) === "demo";
}

/** The synthetic Workflows demo, keeping the selected app for the way back to live data. */
export function workflowsDemoHref(appId = selectedAppParam()): string {
  const params = new URLSearchParams({ [VIEW_PARAM]: "demo" });
  if (appId) params.set(APP_PARAM, appId);
  return `/workflows?${params}`;
}

/** `/trends` -> "trends"; `/` -> "live"; anything else -> null (not found). */
export function pageFrom(pathname: string): PageId | null {
  const segment = pathname.split("/")[1] || "live";
  return (PAGES as string[]).includes(segment) ? (segment as PageId) : null;
}

export function selectedAppParam(search = location.search): string | null {
  return new URLSearchParams(search).get(APP_PARAM);
}

/** The URL for `page` with `appId` selected; by default it keeps the current selection. */
export function pageHref(page: PageId, appId = selectedAppParam()): string {
  return appId ? `/${page}?${APP_PARAM}=${encodeURIComponent(appId)}` : `/${page}`;
}

/** The current URL with `?app=` set (or removed when `appId` is null). */
export function withApp(appId: string | null): string {
  const params = new URLSearchParams(location.search);
  if (appId) params.set(APP_PARAM, appId);
  else params.delete(APP_PARAM);
  const query = params.toString();
  return location.pathname + (query ? `?${query}` : "");
}

/** Client-side navigation; `replace` rewrites the current entry instead of adding one. */
export function navigate(href: string, { replace = false } = {}): void {
  if (href === snapshot()) return;
  if (replace) history.replaceState(null, "", href);
  else history.pushState(null, "", href);
  dispatchEvent(new Event(NAVIGATE));
}
