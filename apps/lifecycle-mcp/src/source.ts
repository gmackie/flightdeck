/**
 * The read-only contract between the MCP tools and whatever serves lifecycle data: today the
 * synthetic fixture source, later the Workstream H read API (`sources/read-api.ts`). The source
 * of truth is that read API's derived read model, never Basin/R2 raw events.
 *
 * Every data method takes an `AppScope`, which only `authorize()` can mint, so a source is never
 * asked about an app the caller holds no grant for. There are no write methods by design.
 */

/** Grant roles; they mirror the FLIG-18 read authorization contract (PR #31). */
export type Role = "reader" | "analyst" | "owner" | "admin";

/** `lifecycle:read` covers definitions and single cases; `process:read` covers aggregates. */
export type Capability = "lifecycle:read" | "process:read";

/** A verified Cloudflare Access caller: a person (`email`) or a service token. */
export type Principal = {
  sub: string;
  email?: string;
  serviceToken: boolean;
  /** The verified Access JWT, forwarded to the read API. Never logged or returned. */
  assertion: string | null;
};

export type Grant = { appId: string; role: Role; expiresAt: number | null };

declare const scopeBrand: unique symbol;

/** Proof that `principal` may use `capability` on `appId`. Mint it with `authorize()` only. */
export type AppScope = {
  readonly appId: string;
  readonly capability: Capability;
  readonly principal: Principal;
  readonly [scopeBrand]: true;
};

export type Freshness = {
  /** `unavailable` until the source has projected anything for the app. */
  status: "fresh" | "stale" | "unavailable";
  /** Events up to this time (ms) are reflected in the data. */
  watermark: number | null;
  lag_ms: number | null;
};

export type SourceMeta = {
  /** When the source computed or snapshotted the answer (ms). */
  as_of: number;
  freshness: Freshness;
  /** The source's contract or projection version, e.g. `synthetic-fixtures@1`. */
  source_version: string;
  /** Required by the live D1 contract; recent projection does not prove event coverage. */
  event_time_completeness?: "unknown";
  /** Ingestion sequence, NOT an event-time completeness watermark. */
  projection?: {
    source_watermark: number;
    generation: number;
    status: "ready" | "rebuilding" | "failed" | "empty";
    lag_ms: number;
  };
};

export type Sourced<T> = { data: T; meta: SourceMeta };

/** `cursor` is the source's own opaque cursor; the MCP layer wraps and bounds it. */
export type PageRequest = { limit: number; cursor: string | null };
export type Page<T> = { items: T[]; next_cursor: string | null };

export type StageDef = { key: string; label: string; order: number; terminal: boolean };
/** Categorical dimensions only: every value an aggregate may be grouped or filtered by is listed. */
export type DimensionDef = { key: string; label: string; values: string[] };

export type WorkflowDefinition = {
  workflow_key: string;
  version: number;
  label: string;
  description: string;
  stages: StageDef[];
  outcomes: string[];
  dimensions: DimensionDef[];
  published_at: number;
};

export type CaseSummary = {
  case_id: string;
  workflow_key: string;
  version: number;
  status: "open" | "closed";
  outcome: string | null;
  current_stage: string | null;
  started_at: number;
  ended_at: number | null;
  last_event_at: number;
  dimensions: Record<string, string>;
};

export type IntervalState = "active" | "completed" | "skipped" | "interrupted";

export type TimelineEntry = {
  stage_key: string;
  /** 1 for the first visit to a stage, 2 for the first re-entry, and so on. */
  attempt: number;
  state: IntervalState;
  entered_at: number;
  exited_at: number | null;
};

/** The cohort an aggregate covers: cases of one workflow that started inside the window. */
export type AggregateQuery = {
  workflowKey: string;
  version: number;
  from: number;
  to: number;
  groupBy: string | null;
  filters: Record<string, string>;
};

/** Distinct-case counts (`n`) let the MCP layer suppress small groups itself. */
export type DwellGroup = {
  stage_key: string;
  group: string | null;
  /** Distinct cases with a completed interval in the stage. */
  n: number;
  /** Distinct cases currently in the stage. */
  open_n: number;
  p50_ms: number | null;
  p90_ms: number | null;
  mean_ms: number | null;
  /** Set when the source already withheld the group. */
  suppressed?: boolean;
};

export type FunnelGroup = {
  group: string | null;
  cohort_n: number;
  /** Distinct cases that reached each stage, in the requested order. */
  steps: { stage_key: string; reached_n: number }[];
  suppressed?: boolean;
};

export type VariantRow = {
  /** Stage keys in visit order; re-entries repeat a key. */
  path: string[];
  n: number;
  completed_n: number;
  median_cycle_ms: number | null;
};

export type VariantStats = {
  total_n: number;
  completed_n: number;
  median_cycle_ms: number | null;
  /** Most frequent first, at most `limit` rows. */
  variants: VariantRow[];
};

export type AppFreshness = Freshness & {
  workflows: { workflow_key: string; last_event_at: number | null }[];
};

export interface LifecycleReadSource {
  readonly kind: "synthetic" | "lifecycle-read-api";
  /** The caller's app grants. The upstream read API remains the authoritative check. */
  grantsFor(principal: Principal): Promise<Grant[]>;
  listWorkflowDefinitions(
    scope: AppScope,
    q: { workflowKey: string | null; page: PageRequest },
  ): Promise<Sourced<Page<WorkflowDefinition>>>;
  /** `version: null` asks for the latest version. */
  getWorkflowDefinition(
    scope: AppScope,
    workflowKey: string,
    version: number | null,
  ): Promise<Sourced<WorkflowDefinition | null>>;
  getCaseSummary(scope: AppScope, caseId: string): Promise<Sourced<CaseSummary | null>>;
  getCaseTimeline(
    scope: AppScope,
    caseId: string,
    page: PageRequest,
  ): Promise<Sourced<Page<TimelineEntry> | null>>;
  getStageDwell(scope: AppScope, q: AggregateQuery): Promise<Sourced<DwellGroup[]>>;
  getFunnel(
    scope: AppScope,
    q: AggregateQuery & { stages: string[] },
  ): Promise<Sourced<FunnelGroup[]>>;
  getVariantStats(
    scope: AppScope,
    q: AggregateQuery & { limit: number },
  ): Promise<Sourced<VariantStats>>;
  getFreshness(scope: AppScope): Promise<Sourced<AppFreshness>>;
}

/** The source cannot answer right now; tools report `source_unavailable` without details. */
export class SourceUnavailableError extends Error {
  constructor(message = "Lifecycle read source unavailable") {
    super(message);
    this.name = "SourceUnavailableError";
  }
}

/** A current backend grant check denied the app; never reveals app existence. */
export class SourceForbiddenError extends Error {}
