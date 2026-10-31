import {
  ClientEvent,
  type EventSource,
  hourKey,
  IngestBatch,
  type IngestResult,
  normalizeRoute,
  type Props,
  parseUserAgent,
  type StoredEvent,
  type UserAgentInfo,
} from "@flightdeckhq/schema";
import * as v from "valibot";
import type { CounterRow } from "../do/app";

const MAX_FUTURE_MS = 5 * 60_000;
const MAX_PAST_MS = 24 * 60 * 60_000;
/** Largest serialized `props` an event may carry; bigger events are rejected. */
export const MAX_PROPS_BYTES = 4096;

const encoder = new TextEncoder();

export interface IngestDeps {
  now(): number;
  newId(): string;
  resolveUser(accessJwt: string): Promise<string | null>;
  /** The commit point: once this resolves the batch is accepted. */
  sendEvents(rows: StoredEvent[]): Promise<void>;
  appendToSession(appId: string, sessionId: string, rows: StoredEvent[]): Promise<void>;
  recordCounts(appId: string, hour: string, rows: CounterRow[]): Promise<void>;
  /** Keeps best-effort work alive after the call returns (`ctx.waitUntil` in the Worker). */
  defer(work: Promise<unknown>): void;
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

/** Longest issue summary appended to an "invalid batch" message. */
const MAX_SUMMARY = 200;

export async function ingestBatch(
  appId: string,
  input: unknown,
  source: EventSource,
  deps: IngestDeps,
): Promise<IngestResult> {
  const parsed = v.safeParse(IngestBatch, input);
  if (!parsed.success) {
    throw new IngestError(
      `invalid batch: ${summarize(parsed.issues[0])}`,
      v.flatten(parsed.issues),
    );
  }
  const { events, context, accessJwt } = parsed.output;

  const ua = parseUserAgent(context?.userAgent);
  if (ua.device === "bot") return { accepted: 0, rejected: 0 };

  const accepted: ClientEvent[] = [];
  for (const raw of events) {
    const event = validateEvent(raw);
    if (event) accepted.push(event);
  }
  const rejected = events.length - accepted.length;
  if (accepted.length === 0) return { accepted: 0, rejected };

  const receivedAt = deps.now();
  const accessUser = accessJwt ? await deps.resolveUser(accessJwt) : null;
  const country = context?.country ?? null;
  const rows = accepted.map((e) =>
    toRow(appId, e, { newId: deps.newId, receivedAt, ua, accessUser, source, country }),
  );

  // Pipelines is the system of record: if it fails the caller retries the whole batch.
  await deps.sendEvents(rows);
  deps.defer(fanOut(appId, rows, deps));
  return { accepted: rows.length, rejected };
}

/** Live views (SessionDOs, AppDOs) are best-effort: failures are logged, never surfaced. */
async function fanOut(appId: string, rows: StoredEvent[], deps: IngestDeps): Promise<void> {
  const work: Promise<void>[] = [];
  for (const [sessionId, group] of groupBy(rows, (r) => r.session_id)) {
    work.push(deps.appendToSession(appId, sessionId, group));
  }
  for (const [hour, group] of groupBy(rows, (r) => hourKey(r.ts))) {
    work.push(deps.recordCounts(appId, hour, group.map(toCounterRow)));
  }
  for (const result of await Promise.allSettled(work)) {
    if (result.status === "rejected") {
      console.error(`flightdeck: live fan-out failed for ${appId}`, result.reason);
    }
  }
}

const toCounterRow = ({ kind, name, path, session_id, ts }: StoredEvent): CounterRow => ({
  kind,
  name,
  path,
  session_id,
  ts,
});

function summarize(issue: v.BaseIssue<unknown> | undefined): string {
  if (!issue) return "unknown issue";
  const path = v.getDotPath(issue);
  const text = path ? `${path}: ${issue.message}` : issue.message;
  return text.length > MAX_SUMMARY ? `${text.slice(0, MAX_SUMMARY)}...` : text;
}

function validateEvent(raw: unknown): ClientEvent | null {
  const parsed = v.safeParse(ClientEvent, raw);
  if (!parsed.success) return null;
  const event = parsed.output;
  if (event.props && propsBytes(event.props) > MAX_PROPS_BYTES) return null;
  return event;
}

const propsBytes = (props: Props) => encoder.encode(JSON.stringify(props)).byteLength;

type RowContext = {
  newId(): string;
  receivedAt: number;
  ua: UserAgentInfo;
  accessUser: string | null;
  source: EventSource;
  country: string | null;
};

function toRow(appId: string, e: ClientEvent, c: RowContext): StoredEvent {
  const skewed = e.ts > c.receivedAt + MAX_FUTURE_MS || e.ts < c.receivedAt - MAX_PAST_MS;
  const path = e.path ? normalizeRoute(e.path) : null;
  return {
    event_id: e.eventId ?? c.newId(),
    app_id: appId,
    kind: e.kind,
    // Page names are routes; normalize them so per-name counters don't grow per id.
    name: e.kind === "page" && path ? path : e.name,
    ts: skewed ? c.receivedAt : e.ts,
    received_at: c.receivedAt,
    session_id: e.sessionId ?? null,
    anonymous_id: e.anonymousId ?? null,
    // A verified Access identity beats whatever the client claims.
    user_id: c.accessUser ?? e.userId ?? null,
    path,
    referrer: e.referrer ? referrerHost(e.referrer) : null,
    props: e.props ?? null,
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
