import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _reset, identify, init, track } from "../src";
import { anonymousId, randomId, SESSION_IDLE_MS, sessionId } from "../src/ids";
import { EventQueue, MAX_BODY_BYTES, sendBatch } from "../src/queue";

type SentEvent = {
  kind: string;
  name: string;
  eventId?: string;
  userId?: string;
  path?: string;
  props?: Record<string, string>;
};
type Sent = { events: SentEvent[] };
const beacons: Sent[] = [];

beforeEach(() => {
  beacons.length = 0;
  sessionStorage.clear();
  localStorage.clear();
  document.body.innerHTML = "";
  history.replaceState(null, "", "/");
  Object.defineProperty(navigator, "sendBeacon", {
    configurable: true,
    value: (_url: string, blob: Blob) => {
      void blob.text().then((t) => beacons.push(JSON.parse(t)));
      return true;
    },
  });
});
afterEach(() => {
  _reset();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const flush = async () => {
  document.dispatchEvent(new Event("visibilitychange"));
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
  document.dispatchEvent(new Event("visibilitychange"));
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  await new Promise((r) => setTimeout(r, 0));
  return beacons.flatMap((b) => b.events);
};

describe("ids", () => {
  it("keeps the session id until 30 minutes idle", () => {
    const a = sessionId(1_000);
    expect(sessionId(1_000 + SESSION_IDLE_MS - 1)).toBe(a);
    expect(sessionId(1_000 + 2 * SESSION_IDLE_MS)).not.toBe(a);
  });

  it("persists the anonymous id by default", () => {
    const a = anonymousId(true);
    expect(localStorage.getItem("fd_aid")).toBe(a);
    expect(anonymousId(false)).not.toBe(a);
  });

  it("mints 32-hex ids, falling back to getRandomValues without randomUUID", () => {
    expect(randomId()).toMatch(/^[a-f0-9]{32}$/);
    const getRandomValues = crypto.getRandomValues.bind(crypto);
    vi.stubGlobal("crypto", { getRandomValues });
    const ids = [randomId(), randomId()];
    expect(ids[0]).toMatch(/^[a-f0-9]{32}$/);
    expect(ids[1]).toMatch(/^[a-f0-9]{32}$/);
    expect(ids[0]).not.toBe(ids[1]);
  });
});

describe("capture", () => {
  it("emits a page view, clicks with props, and form submits", async () => {
    document.body.innerHTML = `
      <button data-flightdeck="pricing.cta" data-flightdeck-plan="pro"><span id="inner">Go</span></button>
      <form data-flightdeck="signup.form"><button id="submit" type="button">Sign up</button></form>`;
    init({ flushIntervalMs: 60_000 });
    document.getElementById("inner")?.click();
    document.getElementById("submit")?.click();
    document.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true }));
    expect((await flush()).map((e) => [e.kind, e.name, e.props])).toEqual([
      ["page", "/", undefined],
      ["click", "pricing.cta", { plan: "pro" }],
      ["submit", "signup.form", undefined],
    ]);
  });

  it("ignores elements whose data-flightdeck value is empty", async () => {
    let callback: IntersectionObserverCallback = () => {};
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(cb: IntersectionObserverCallback) {
          callback = cb;
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    document.body.innerHTML = `
      <button data-flightdeck="">Go</button>
      <form data-flightdeck=""></form>
      <section data-flightdeck="" data-flightdeck-view></section>`;
    init({ trackPages: false });
    document.querySelector("button")?.click();
    document.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true }));
    const target = document.querySelector("section") as Element;
    callback(
      [{ isIntersecting: true, target } as unknown as IntersectionObserverEntry],
      {} as IntersectionObserver,
    );
    expect(await flush()).toEqual([]);
  });

  it("emits views once for data-flightdeck-view elements", async () => {
    let callback: IntersectionObserverCallback = () => {};
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(cb: IntersectionObserverCallback) {
          callback = cb;
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    document.body.innerHTML = `<section data-flightdeck="hero" data-flightdeck-view></section>`;
    init({ trackPages: false });
    const target = document.querySelector("section") as Element;
    const entry = { isIntersecting: true, target } as unknown as IntersectionObserverEntry;
    callback([entry], {} as IntersectionObserver);
    callback([entry], {} as IntersectionObserver);
    target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect((await flush()).map((e) => [e.kind, e.name])).toEqual([["view", "hero"]]);
  });

  it("tracks SPA navigations once per path and custom events", async () => {
    init();
    history.pushState(null, "", "/docs");
    history.pushState(null, "", "/docs");
    track("export.csv", { rows: "10" });
    expect((await flush()).map((e) => [e.kind, e.name])).toEqual([
      ["page", "/"],
      ["page", "/docs"],
      ["track", "export.csv"],
    ]);
  });

  it("identify includes the userId and later events carry it", async () => {
    init({ trackPages: false });
    identify("user-1");
    track("after");
    expect((await flush()).map((e) => [e.kind, e.name, e.userId])).toEqual([
      ["identify", "identify", "user-1"],
      ["track", "after", "user-1"],
    ]);
  });

  it("gives every event a unique 32-hex eventId", async () => {
    document.body.innerHTML = `<button data-flightdeck="cta">Go</button>`;
    init();
    document.querySelector("button")?.click();
    track("a");
    track("a");
    identify("user-1");
    history.pushState(null, "", "/next");
    const events = await flush();
    expect(events).toHaveLength(6);
    for (const e of events) expect(e.eventId).toMatch(/^[a-f0-9]{32}$/);
    expect(new Set(events.map((e) => e.eventId)).size).toBe(events.length);
  });
});

describe("EventQueue", () => {
  it("flushes when maxBatch is reached", () => {
    const transport = vi.fn();
    const q = new EventQueue({ endpoint: "/_fd/e", maxBatch: 2 }, transport);
    q.push({ kind: "track", name: "a", ts: 1 });
    expect(transport).not.toHaveBeenCalled();
    q.push({ kind: "track", name: "b", ts: 2 });
    expect(transport).toHaveBeenCalledOnce();
  });

  it("caps each send at 50 events", () => {
    const transport = vi.fn();
    const q = new EventQueue({ endpoint: "/_fd/e", maxBatch: 1_000 }, transport);
    for (let i = 0; i < 120; i++) q.push({ kind: "track", name: `e${i}`, ts: i });
    q.flush();
    const sizes = transport.mock.calls.map(([, body]) => JSON.parse(body).events.length);
    expect(sizes).toEqual([50, 50, 20]);
  });

  it("splits a flush so every body stays under the byte limit", () => {
    const transport = vi.fn();
    const q = new EventQueue({ endpoint: "/_fd/e", maxBatch: 1_000 }, transport);
    const props = Object.fromEntries(
      Array.from({ length: 20 }, (_, i) => [`p${i}`, "é".repeat(500)]),
    );
    for (let i = 0; i < 30; i++) q.push({ kind: "track", name: `e${i}`, ts: i, props });
    q.flush();
    expect(transport.mock.calls.length).toBeGreaterThan(1);
    const names: string[] = [];
    for (const [, body] of transport.mock.calls) {
      expect(new TextEncoder().encode(body).length).toBeLessThanOrEqual(MAX_BODY_BYTES);
      for (const e of JSON.parse(body).events) names.push(e.name);
    }
    expect(names).toEqual(Array.from({ length: 30 }, (_, i) => `e${i}`));
  });
});

describe("sendBatch", () => {
  it("falls back to a keepalive text/plain fetch when the beacon is refused", () => {
    Object.defineProperty(navigator, "sendBeacon", { configurable: true, value: () => false });
    const fetchMock = vi.fn(() => Promise.resolve(new Response(null, { status: 202 })));
    vi.stubGlobal("fetch", fetchMock);
    sendBatch("/_fd/e", '{"events":[]}');
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/_fd/e");
    expect(init).toMatchObject({ method: "POST", body: '{"events":[]}', keepalive: true });
    expect(new Request("http://x/", init).headers.get("Content-Type")).toMatch(/^text\/plain/);
  });

  it("uses fetch when sendBeacon is unavailable", () => {
    Object.defineProperty(navigator, "sendBeacon", { configurable: true, value: undefined });
    const fetchMock = vi.fn(() => Promise.resolve(new Response(null, { status: 202 })));
    vi.stubGlobal("fetch", fetchMock);
    sendBatch("/_fd/e", '{"events":[]}');
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
