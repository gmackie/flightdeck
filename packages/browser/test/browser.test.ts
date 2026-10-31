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
  referrer?: string;
  props?: Record<string, unknown>;
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
  it("rotates the session when fd_last is corrupt", () => {
    sessionStorage.setItem("fd_sid", "a".repeat(32));
    sessionStorage.setItem("fd_last", "garbage");
    expect(sessionId(Date.now())).not.toBe("a".repeat(32));
  });

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
      [
        {
          isIntersecting: true,
          intersectionRatio: 1,
          target,
        } as unknown as IntersectionObserverEntry,
      ],
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
    const entry = {
      isIntersecting: true,
      intersectionRatio: 1,
      target,
    } as unknown as IntersectionObserverEntry;
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

type IOStub = {
  callback: IntersectionObserverCallback;
  options?: IntersectionObserverInit;
  observed: Element[];
};
const stubIO = (): IOStub => {
  const stub: IOStub = { callback: () => {}, observed: [] };
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(cb: IntersectionObserverCallback, options?: IntersectionObserverInit) {
        stub.callback = cb;
        stub.options = options;
      }
      observe(el: Element) {
        stub.observed.push(el);
      }
      unobserve() {}
      disconnect() {}
    },
  );
  return stub;
};
const viewEntry = (
  target: Element,
  intersectionRatio: number,
  rectHeight: number,
  rootHeight = 800,
) =>
  ({
    isIntersecting: true,
    intersectionRatio,
    target,
    intersectionRect: { height: rectHeight },
    rootBounds: { height: rootHeight },
  }) as unknown as IntersectionObserverEntry;

describe("view accuracy", () => {
  it("observes at thresholds 0 and 0.5", () => {
    const io = stubIO();
    init({ trackPages: false });
    expect(io.options?.threshold).toEqual([0, 0.5]);
  });

  it("ignores a barely intersecting element", async () => {
    const io = stubIO();
    document.body.innerHTML = `<section data-flightdeck="hero" data-flightdeck-view></section>`;
    init({ trackPages: false });
    const target = document.querySelector("section") as Element;
    io.callback([viewEntry(target, 0.01, 4)], {} as IntersectionObserver);
    expect(await flush()).toEqual([]);
  });

  it("counts an element at least half visible once", async () => {
    const io = stubIO();
    document.body.innerHTML = `<section data-flightdeck="hero" data-flightdeck-view></section>`;
    init({ trackPages: false });
    const target = document.querySelector("section") as Element;
    io.callback([viewEntry(target, 0.6, 120)], {} as IntersectionObserver);
    io.callback([viewEntry(target, 0.6, 120)], {} as IntersectionObserver);
    expect((await flush()).map((e) => [e.kind, e.name])).toEqual([["view", "hero"]]);
  });

  it("counts a tall element filling half the viewport", async () => {
    const io = stubIO();
    document.body.innerHTML = `<section data-flightdeck="tall" data-flightdeck-view></section>`;
    init({ trackPages: false });
    const target = document.querySelector("section") as Element;
    io.callback([viewEntry(target, 0.3, 400, 800)], {} as IntersectionObserver);
    expect((await flush()).map((e) => [e.kind, e.name])).toEqual([["view", "tall"]]);
  });

  it("observes view elements added after init", async () => {
    const io = stubIO();
    init({ trackPages: false });
    const rescan = vi.spyOn(document, "querySelectorAll");
    const wrap = document.createElement("div");
    wrap.innerHTML = `<section data-flightdeck="late" data-flightdeck-view></section>`;
    const direct = document.createElement("aside");
    direct.setAttribute("data-flightdeck", "direct");
    direct.setAttribute("data-flightdeck-view", "");
    document.body.append(wrap, direct);
    await new Promise((r) => setTimeout(r, 0));
    expect(io.observed).toContain(wrap.firstElementChild);
    expect(io.observed).toContain(direct);
    expect(io.observed).not.toContain(wrap);
    expect(rescan).not.toHaveBeenCalled();
  });

  it("skips the MutationObserver without IntersectionObserver", () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const created = vi.fn();
    vi.stubGlobal(
      "MutationObserver",
      class {
        constructor() {
          created();
        }
        observe() {}
        disconnect() {}
      },
    );
    init({ trackPages: false });
    expect(created).not.toHaveBeenCalled();
  });
});

describe("robustness", () => {
  it("captures clicks inside an open shadow root", async () => {
    document.body.innerHTML = `<div id="host"></div>`;
    const host = document.getElementById("host") as HTMLElement;
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `<button data-flightdeck="shadow.cta" data-flightdeck-plan="pro"><span>Go</span></button>`;
    init({ trackPages: false });
    // Browsers retarget a composed event to the shadow host outside the shadow tree, so the
    // document listener only sees the button through composedPath().
    const span = root.querySelector("span") as HTMLElement;
    const button = root.querySelector("button") as HTMLElement;
    const ev = new MouseEvent("click", { bubbles: true, composed: true });
    const path = [span, button, root, host, document.body, document.documentElement, document];
    Object.defineProperty(ev, "composedPath", { value: () => path });
    host.dispatchEvent(ev);
    expect((await flush()).map((e) => [e.kind, e.name, e.props])).toEqual([
      ["click", "shadow.cta", { plan: "pro" }],
    ]);
  });

  it("rejects empty and over-long user ids", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    init({ trackPages: false });
    identify("");
    identify("u".repeat(129));
    track("after");
    const events = await flush();
    expect(events.map((e) => [e.kind, e.userId])).toEqual([["track", undefined]]);
    expect(warn).toHaveBeenCalledTimes(2);
    identify("u".repeat(128));
    expect((await flush()).at(-1)?.userId).toBe("u".repeat(128));
  });

  it("never breaks navigation when emitting throws", () => {
    init();
    vi.stubGlobal("crypto", {
      randomUUID: () => {
        throw new Error("boom");
      },
    });
    expect(() => history.pushState(null, "", "/a")).not.toThrow();
    expect(location.pathname).toBe("/a");
    expect(() => history.replaceState(null, "", "/b")).not.toThrow();
    expect(location.pathname).toBe("/b");
  });

  it("sends only the referrer origin, and none for an invalid referrer", async () => {
    Object.defineProperty(document, "referrer", {
      configurable: true,
      value: "https://search.example/q?term=secret",
    });
    init();
    expect((await flush())[0]?.referrer).toBe("https://search.example");
    _reset();
    beacons.length = 0;
    Object.defineProperty(document, "referrer", { configurable: true, value: "not a url" });
    init();
    const [page] = await flush();
    expect(page?.kind).toBe("page");
    expect(page?.referrer).toBeUndefined();
    Object.defineProperty(document, "referrer", { configurable: true, value: "" });
  });

  it("truncates long names and string props before queueing", async () => {
    init({ trackPages: false });
    track("n".repeat(300), { long: "v".repeat(600), n: 5, ok: true });
    const [e] = await flush();
    expect(e?.name).toHaveLength(256);
    expect(e?.props).toEqual({ long: "v".repeat(512), n: 5, ok: true });
  });

  it("records a page view when restored from the back/forward cache", async () => {
    init();
    const show = (persisted: boolean) =>
      dispatchEvent(Object.assign(new Event("pageshow"), { persisted }));
    show(false);
    show(true);
    expect((await flush()).map((e) => [e.kind, e.name])).toEqual([
      ["page", "/"],
      ["page", "/"],
    ]);
  });
});

describe("privacy", () => {
  it("never captures query strings or fragments in paths", async () => {
    history.replaceState(null, "", "/search?q=jane%40example.com#token=abc");
    init();
    history.pushState(null, "", "/students?name=jane");
    track("search.run");
    expect((await flush()).map((e) => [e.kind, e.name, e.path])).toEqual([
      ["page", "/search", "/search"],
      ["page", "/students", "/students"],
      ["track", "search.run", "/students"],
    ]);
  });

  it("strips redactProps keys from tracked and captured props", async () => {
    document.body.innerHTML = `<button data-flightdeck="cta" data-flightdeck-email="a@b.c" data-flightdeck-plan="pro">Go</button>`;
    init({ trackPages: false, redactProps: ["email", "studentId"] });
    track("roster.export", { studentId: "s-1", rows: 3 });
    document.querySelector("button")?.click();
    expect((await flush()).map((e) => [e.name, e.props])).toEqual([
      ["roster.export", { rows: 3 }],
      ["cta", { plan: "pro" }],
    ]);
  });

  it("runs beforeSend on every event, which can rewrite or drop it", async () => {
    const seen: string[] = [];
    init({
      beforeSend: (event) => {
        seen.push(event.kind);
        if (event.name === "secret") return null;
        return { ...event, path: "/redacted", props: { ...event.props, scrubbed: true } };
      },
    });
    track("secret");
    track("kept", { a: 1 });
    identify("user-1");
    const events = await flush();
    expect(seen).toEqual(["page", "track", "track", "identify"]);
    expect(events.map((e) => [e.kind, e.name, e.path, e.props])).toEqual([
      ["page", "/", "/redacted", { scrubbed: true }],
      ["track", "kept", "/redacted", { a: 1, scrubbed: true }],
      ["identify", "identify", "/redacted", { scrubbed: true }],
    ]);
  });

  it("drops the event when beforeSend throws", async () => {
    init({
      trackPages: false,
      beforeSend: (event) => {
        if (event.name === "bad") throw new Error("boom");
        return event;
      },
    });
    expect(() => track("bad")).not.toThrow();
    track("good");
    expect((await flush()).map((e) => e.name)).toEqual(["good"]);
  });
});
