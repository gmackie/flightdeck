import { vi } from "vitest";
import type {
  CaseDetail,
  CaseSummary,
  DataFreshness,
  OutcomeGroup,
  ProcessDefinition,
  StageInterval,
} from "../../src/workflows/live-adapter";

/** A fake `/api/apps/:app/lifecycle/*` for tests: two hiring cases, parent and child. */

export const AS_OF = Date.UTC(2026, 9, 31, 12);
export const HOUR = 3_600_000;

export const FRESH: DataFreshness = {
  status: "fresh",
  projection: "ready",
  lag_ms: 42_000,
  generation: 3,
  source_watermark: 99,
  pending_cases: 2,
};

export const HIRING: ProcessDefinition = {
  process_key: "hiring",
  version: 2,
  label: "Hiring",
  stages: [
    { key: "applied", label: "Applied", terminal: false },
    { key: "screen", label: "Screen", terminal: false },
    { key: "offer", label: "Offer", terminal: false },
    { key: "done", label: "Done", terminal: true },
  ],
  as_of: AS_OF,
};

export const summary = (overrides: Partial<CaseSummary> & { case_id: string }): CaseSummary => ({
  process_key: "hiring",
  process_version: 2,
  status: "open",
  outcome: null,
  current_stage: null,
  parent_case_id: null,
  started_at: AS_OF - 10 * HOUR,
  ended_at: null,
  last_event_at: AS_OF - HOUR,
  ...overrides,
});

export const detail = (
  base: CaseSummary,
  intervals: (Partial<StageInterval> & { stage_key: string; entered_at: number })[],
): CaseDetail => ({
  ...base,
  intervals: intervals.map((interval) => ({
    state: "active",
    exited_at: null,
    outcome: null,
    ...interval,
  })),
});

export const PARENT = detail(
  summary({ case_id: "case_01PARENTAAAA1111", current_stage: "screen" }),
  [
    { stage_key: "applied", entered_at: AS_OF - 10 * HOUR, exited_at: AS_OF - 2 * HOUR },
    { stage_key: "screen", entered_at: AS_OF - 2 * HOUR },
  ],
);

export const CHILD = detail(
  summary({
    case_id: "case_01CHILDBBBBB2222",
    parent_case_id: PARENT.case_id,
    status: "closed",
    outcome: "rejected",
    current_stage: "screen",
    started_at: AS_OF - 8 * HOUR,
    ended_at: AS_OF - 3 * HOUR,
  }),
  [
    { stage_key: "applied", entered_at: AS_OF - 8 * HOUR, exited_at: AS_OF - 5 * HOUR },
    { stage_key: "screen", entered_at: AS_OF - 5 * HOUR, exited_at: AS_OF - 3 * HOUR },
  ],
);

export const OUTCOMES: OutcomeGroup[] = [
  {
    status: "closed",
    outcome: "hired",
    case_count: 7,
    duration_ms: { mean: 50 * HOUR, p50: 48 * HOUR, p90: 72 * HOUR },
  },
  {
    status: "open",
    outcome: null,
    case_count: 12,
    duration_ms: { mean: null, p50: null, p90: null },
  },
];

export const envelope = (data: unknown, extra: Record<string, unknown> = {}) => ({
  app_id: "app_alpha",
  as_of: AS_OF,
  data_freshness: FRESH,
  cohort: {},
  sample_count: Array.isArray(data) ? data.length : 1,
  suppressed: false,
  data,
  ...extra,
});

type Answer = { status?: number; body?: unknown };
/** Per-endpoint overrides, keyed by the path after `/lifecycle/` (`processes`, `cases`, …). */
export type LifecycleOverrides = Partial<
  Record<"processes" | "cases" | "outcomes" | "detail", Answer | ((url: URL) => Answer)>
>;

/** Answers a lifecycle URL, or undefined for anything else (so `mockApps` can chain it). */
export function lifecycleRoute(overrides: LifecycleOverrides = {}, cases = [PARENT, CHILD]) {
  return (url: URL): { status?: number; body: unknown } | undefined => {
    const match = url.pathname.match(/^\/api\/apps\/[^/]+\/lifecycle\/(.+)$/);
    if (!match?.[1]) return undefined;
    const path = match[1];
    const endpoint = path.startsWith("cases/")
      ? "detail"
      : path === "summaries/outcomes"
        ? "outcomes"
        : (path as "processes" | "cases");
    const override = overrides[endpoint];
    const answer = typeof override === "function" ? override(url) : override;
    if (answer) return { status: answer.status ?? 200, body: answer.body ?? null };
    if (endpoint === "processes") return { body: envelope([HIRING]) };
    if (endpoint === "cases") {
      const listed = cases.map(({ intervals: _intervals, ...rest }) => rest);
      return { body: envelope(listed, { page: { limit: 25, next_cursor: null } }) };
    }
    if (endpoint === "outcomes") return { body: envelope(OUTCOMES) };
    const found = cases.find((item) => path === `cases/${item.case_id}`);
    return found ? { body: envelope(found) } : { status: 404, body: { error: "Unknown case" } };
  };
}

/** A `fetch` stub that answers only lifecycle reads. */
export function lifecycleFetcher(overrides?: LifecycleOverrides, cases?: CaseDetail[]) {
  const route = lifecycleRoute(overrides, cases);
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "https://flightdeck.test");
    const answer = route(url);
    if (!answer) return new Response(null, { status: 404 });
    return new Response(answer.status === 401 ? null : JSON.stringify(answer.body), {
      status: answer.status ?? 200,
    });
  });
}
