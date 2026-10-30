import type { ClientEventInput, EventKind } from "@flightdeckhq/schema";
import { installCapture } from "./capture";
import { anonymousId, randomId, sessionId } from "./ids";
import { EventQueue } from "./queue";

export type InitOptions = {
  /** Same-origin endpoint served by withFlightdeck/handleFlightdeck. Default `/_fd/e`. */
  endpoint?: string;
  /** Keep a persistent anonymous id in localStorage. Default true. */
  persistAnonymousId?: boolean;
  /** Record page views, including SPA navigations. Default true. */
  trackPages?: boolean;
  maxBatch?: number;
  flushIntervalMs?: number;
};

export type Props = Record<string, string | number | boolean | null>;

class Client {
  private readonly queue: EventQueue;
  private readonly persist: boolean;
  private readonly cleanup: (() => void)[] = [];
  private userId: string | undefined;
  private lastPath: string | undefined;

  constructor(o: InitOptions) {
    this.persist = o.persistAnonymousId ?? true;
    this.queue = new EventQueue({ endpoint: o.endpoint ?? "/_fd/e", maxBatch: o.maxBatch ?? 20 });
    const flush = () => this.queue.flush();
    const onHidden = () => document.visibilityState === "hidden" && flush();
    const timer = setInterval(flush, o.flushIntervalMs ?? 5_000);
    document.addEventListener("visibilitychange", onHidden);
    addEventListener("pagehide", flush);
    this.cleanup.push(() => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onHidden);
      removeEventListener("pagehide", flush);
    });
    this.cleanup.push(
      installCapture(document, (kind, name, props) => this.emit(kind, name, props)),
    );
    if (o.trackPages ?? true) {
      this.page();
      this.cleanup.push(watchHistory(() => this.page()));
      // A back/forward cache restore is a new view of the same path.
      const onShow = (ev: PageTransitionEvent) => ev.persisted && this.page(true);
      addEventListener("pageshow", onShow);
      this.cleanup.push(() => removeEventListener("pageshow", onShow));
    }
  }

  emit(kind: EventKind, name: string, props?: Props, extra?: Partial<ClientEventInput>): void {
    // Mirror the server's truncation so one oversized value can't push a batch over the limit.
    if (props) {
      props = { ...props };
      for (const k in props) {
        const v = props[k];
        if (typeof v === "string") props[k] = v.slice(0, 512);
      }
    }
    this.queue.push({
      kind,
      name: name.slice(0, 256),
      eventId: randomId(),
      ts: Date.now(),
      sessionId: sessionId(),
      anonymousId: anonymousId(this.persist),
      path: location.pathname,
      ...(this.userId ? { userId: this.userId } : {}),
      ...(props ? { props } : {}),
      ...extra,
    });
  }

  /** `force` records the view even when the path is unchanged (bfcache restores). */
  page(force?: boolean): void {
    const path = location.pathname;
    if (path === this.lastPath && !force) return;
    const first = this.lastPath === undefined;
    this.lastPath = path;
    this.emit("page", path, undefined, first ? referrer() : {});
  }

  identify(userId: string): void {
    this.userId = userId;
    this.emit("identify", "identify");
  }

  destroy(): void {
    this.queue.flush();
    for (const fn of this.cleanup) fn();
  }
}

/** Only the referring origin: full URLs can carry search terms, tokens, or other PII. */
function referrer(): Partial<ClientEventInput> {
  try {
    const origin = new URL(document.referrer).origin;
    // Opaque origins (about:, data:, file:) serialize as "null".
    return origin === "null" ? {} : { referrer: origin };
  } catch {
    return {};
  }
}

/** Analytics must never break navigation, so errors from onChange are swallowed. */
function watchHistory(track: () => void): () => void {
  const onChange = () => {
    try {
      track();
    } catch {}
  };
  const { pushState, replaceState } = history;
  history.pushState = function (...args: Parameters<History["pushState"]>) {
    pushState.apply(this, args);
    onChange();
  };
  history.replaceState = function (...args: Parameters<History["replaceState"]>) {
    replaceState.apply(this, args);
    onChange();
  };
  addEventListener("popstate", onChange);
  return () => {
    history.pushState = pushState;
    history.replaceState = replaceState;
    removeEventListener("popstate", onChange);
  };
}

let client: Client | undefined;

export function init(options: InitOptions = {}): void {
  if (client || typeof window === "undefined") return;
  client = new Client(options);
}

export function track(name: string, props?: Props): void {
  client?.emit("track", name, props);
}

/** Associates later events with `userId` and records an identify event. */
export function identify(userId: string): void {
  if (!userId || userId.length > 128) {
    console.warn("Flightdeck: identify() needs a userId of 1-128 characters");
    return;
  }
  client?.identify(userId);
}

/** Test hook: tear down the singleton. */
export function _reset(): void {
  client?.destroy();
  client = undefined;
}
