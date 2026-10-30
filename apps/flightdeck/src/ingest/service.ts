import {
  ClientEvent,
  type EventSource,
  hourKey,
  IngestBatch,
  type IngestResult,
  normalizeRoute,
  parseUserAgent,
  type StoredEvent,
  type UserAgentInfo,
} from "@flightdeckhq/schema";
import * as v from "valibot";

const MAX_FUTURE_MS = 5 * 60_000;
const MAX_PAST_MS = 24 * 60 * 60_000;
/** Largest serialized `props` an event may carry; bigger events are rejected. */
export const MAX_PROPS_BYTES = 4096;

const encoder = new TextEncoder();

export interface IngestDeps {
  now(): number;
  newId(): string;
  resolveUser(accessJwt: string): Promise<string | null>;
  sendEvents(rows: StoredEvent[]): Promise<void>;
  appendToSession(appId: string, sessionId: string, rows: StoredEvent[]): Promise<void>;
  recordCounts(appId: string, hour: string, rows: StoredEvent[]): Promise<void>;
}

export class IngestError extends Error {
  constructor(
    message: string,
    readonly issues?: unknown,
  ) {
    super(message);
    this.name = "IngestError";
  }
}

/** A validated event plus its serialized props, so props are stringified once. */
type Accepted = { event: ClientEvent; props: string | null };

export async function ingestBatch(
  appId: string,
  input: unknown,
  source: EventSource,
  deps: IngestDeps,
): Promise<IngestResult> {
  const parsed = v.safeParse(IngestBatch, input);
  if (!parsed.success) throw new IngestError("invalid batch", v.flatten(parsed.issues));
  const { events, context, accessJwt } = parsed.output;

  const ua = parseUserAgent(context?.userAgent);
  if (ua.device === "bot") return { accepted: 0, rejected: 0 };

  const accepted: Accepted[] = [];
  for (const raw of events) {
    const event = validateEvent(raw);
    if (event) accepted.push(event);
  }
  const rejected = events.length - accepted.length;
  if (accepted.length === 0) return { accepted: 0, rejected };

  const receivedAt = deps.now();
  const accessUser = accessJwt ? await deps.resolveUser(accessJwt) : null;
  const country = context?.country ?? null;
  const rows = accepted.map((a) =>
    toRow(appId, a, { id: deps.newId(), receivedAt, ua, accessUser, source, country }),
  );

  const work = [deps.sendEvents(rows)];
  for (const [sessionId, group] of groupBy(rows, (r) => r.session_id)) {
    work.push(deps.appendToSession(appId, sessionId, group));
  }
  for (const [hour, group] of groupBy(rows, (r) => hourKey(r.ts))) {
    work.push(deps.recordCounts(appId, hour, group));
  }
  await Promise.all(work);
  return { accepted: rows.length, rejected };
}

function validateEvent(raw: unknown): Accepted | null {
  const parsed = v.safeParse(ClientEvent, raw);
  if (!parsed.success) return null;
  const event = parsed.output;
  const props = event.props ? JSON.stringify(event.props) : null;
  if (props !== null && encoder.encode(props).byteLength > MAX_PROPS_BYTES) return null;
  return { event, props };
}

type RowContext = {
  id: string;
  receivedAt: number;
  ua: UserAgentInfo;
  accessUser: string | null;
  source: EventSource;
  country: string | null;
};

function toRow(appId: string, { event: e, props }: Accepted, c: RowContext): StoredEvent {
  const skewed = e.ts > c.receivedAt + MAX_FUTURE_MS || e.ts < c.receivedAt - MAX_PAST_MS;
  const path = e.path ? normalizeRoute(e.path) : null;
  return {
    event_id: c.id,
    app_id: appId,
    kind: e.kind,
    // Page names are routes; normalize them so per-name counters don't grow per id.
    name: e.kind === "page" && path ? path : e.name,
    ts: skewed ? c.receivedAt : e.ts,
    received_at: c.receivedAt,
    session_id: e.sessionId ?? null,
    anonymous_id: e.anonymousId ?? null,
    user_id: e.userId ?? c.accessUser,
    path,
    referrer: e.referrer ? referrerHost(e.referrer) : null,
    props,
    country: c.country,
    device: c.ua.device,
    browser: c.ua.browser,
    os: c.ua.os,
    source: c.source,
  };
}

/** Keep only the referring host; full referrer URLs often carry personal data. */
function referrerHost(referrer: string): string | null {
  try {
    return new URL(referrer).host || null;
  } catch {
    return null;
  }
}

function groupBy<T>(items: T[], key: (item: T) => string | null): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    if (k === null) continue;
    const group = groups.get(k);
    if (group) group.push(item);
    else groups.set(k, [item]);
  }
  return groups;
}
