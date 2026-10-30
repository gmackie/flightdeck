import * as v from "valibot";

export const MAX_BATCH = 50;
export const MAX_PROPS = 32;

const Id = v.pipe(v.string(), v.minLength(8), v.maxLength(64), v.regex(/^[A-Za-z0-9_-]+$/));
const truncate = (max: number) => v.transform((s: string) => s.slice(0, max));
const PropValue = v.union([
  v.pipe(v.string(), truncate(512)),
  v.pipe(v.number(), v.finite()),
  v.boolean(),
  v.null(),
]);
const Props = v.pipe(
  v.record(v.pipe(v.string(), v.minLength(1), v.maxLength(64)), PropValue),
  v.check((p) => Object.keys(p).length <= MAX_PROPS, `at most ${MAX_PROPS} props`),
);

export const EventKind = v.picklist(["page", "click", "submit", "view", "track", "identify"]);
export type EventKind = v.InferOutput<typeof EventKind>;

/** One event. The ingest service validates each event on its own so one bad event never drops a batch. */
export const ClientEvent = v.pipe(
  v.object({
    kind: EventKind,
    name: v.pipe(v.string(), truncate(256), v.minLength(1)),
    ts: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(8_640_000_000_000_000)),
    sessionId: v.nullish(Id),
    anonymousId: v.nullish(Id),
    userId: v.nullish(v.pipe(v.string(), v.minLength(1), v.maxLength(128))),
    path: v.nullish(v.pipe(v.string(), truncate(2048))),
    referrer: v.nullish(v.pipe(v.string(), truncate(2048))),
    props: v.nullish(Props),
  }),
  v.check((e) => e.kind !== "identify" || !!e.userId, "identify requires userId"),
);
export type ClientEvent = v.InferOutput<typeof ClientEvent>;
/** What producers (the browser SDK, server helpers) build before validation. */
export type ClientEventInput = v.InferInput<typeof ClientEvent>;

export const RequestContext = v.object({
  country: v.optional(v.pipe(v.string(), v.maxLength(2))),
  userAgent: v.optional(v.pipe(v.string(), truncate(512))),
});
export type RequestContext = v.InferOutput<typeof RequestContext>;

/** The batch envelope. Events are validated individually with `ClientEvent` by the ingest service. */
export const IngestBatch = v.object({
  events: v.pipe(v.array(v.unknown()), v.minLength(1), v.maxLength(MAX_BATCH)),
  context: v.optional(RequestContext),
  accessJwt: v.optional(v.pipe(v.string(), v.maxLength(8192))),
});
export type IngestBatch = v.InferOutput<typeof IngestBatch>;

export type EventSource = "browser" | "server";

/** One row of the Iceberg `events` table. */
export type StoredEvent = {
  event_id: string;
  app_id: string;
  kind: EventKind;
  name: string;
  ts: number;
  received_at: number;
  session_id: string | null;
  anonymous_id: string | null;
  user_id: string | null;
  path: string | null;
  referrer: string | null;
  props: string | null;
  country: string | null;
  device: string;
  browser: string;
  os: string;
  source: EventSource;
};

/** One row of the Iceberg `sessions` table, written when a session closes. */
export type SessionRecord = {
  session_id: string;
  app_id: string;
  anonymous_id: string | null;
  user_id: string | null;
  started_at: number;
  ended_at: number;
  duration_ms: number;
  entry: string | null;
  exit: string | null;
  steps: string;
  step_count: number;
  event_count: number;
  country: string | null;
  device: string;
};

export type IngestResult = { accepted: number; rejected: number };

/** What `env.FLIGHTDECK` exposes to app Workers over the service binding. */
export interface IngestRpc {
  ingest(batch: unknown): Promise<IngestResult>;
  track(event: unknown): Promise<IngestResult>;
  identify(input: unknown): Promise<IngestResult>;
}
