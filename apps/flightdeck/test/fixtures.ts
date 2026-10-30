import type { StoredEvent } from "@flightdeckhq/schema";

export const T0 = Date.UTC(2026, 9, 30, 14, 0);
export const CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
export const sid = (c: string) => c.repeat(32);

export function row(over: Partial<StoredEvent> = {}): StoredEvent {
  return {
    event_id: crypto.randomUUID(),
    app_id: "app_test",
    kind: "page",
    name: "page",
    ts: T0,
    received_at: T0,
    session_id: sid("a"),
    anonymous_id: sid("z"),
    user_id: null,
    path: "/",
    referrer: null,
    props: null,
    country: "US",
    device: "desktop",
    browser: "Chrome",
    os: "macOS",
    source: "browser",
    ...over,
  };
}
