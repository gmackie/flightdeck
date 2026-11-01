import { useCallback, useEffect, useState } from "react";
import { getJson, type Loaded } from "../api";
import {
  type CaseDetail,
  type DataFreshness,
  isCaseDetailEnvelope,
  isCaseList,
  isOutcomeList,
  isProcessList,
  type LifecycleEnvelope,
  type LiveProcessCases,
  liveSnapshot,
  type OutcomeGroup,
  type ProcessDefinition,
  processId,
} from "./live-adapter";
import type { WorkflowSnapshot } from "./model";

/** Newest cases listed per process; each one costs a detail read. */
export const CASES_PER_PROCESS = 25;
/** Detail reads in flight at once. */
export const DETAIL_CONCURRENCY = 6;

type Failure = Exclude<Loaded<never>, { status: "ok" }>;

export type LiveProcess = {
  id: string;
  process: ProcessDefinition;
  /** Listed cases whose detail could not be read (e.g. deleted between list and detail). */
  unavailableCases: number;
  /** More cases exist than were fetched. */
  truncated: boolean;
  outcomes: Loaded<LifecycleEnvelope<OutcomeGroup[]>>;
};

export type LiveWorkflows = {
  freshness: DataFreshness;
  /** Newest projection time any response reported; null until the read model is projected. */
  asOf: number | null;
  /** Null while the read model is unavailable: there is nothing to draw. */
  snapshot: WorkflowSnapshot | null;
  processes: LiveProcess[];
};

const base = (appId: string) => `/api/apps/${encodeURIComponent(appId)}/lifecycle`;

/** Runs `fn` over `items` with at most `limit` calls in flight; keeps input order. */
async function mapBounded<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await fn(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Signed-out and forbidden answers on any lifecycle read stop the whole page. */
const fatal = (result: Loaded<unknown>): result is Failure =>
  result.status === "signed-out" || result.status === "forbidden";

/**
 * Reads processes → newest cases per process → each case's detail, plus one outcome summary per
 * process. Known limitation: the detail step is N+1 (one request per listed case, bounded by
 * CASES_PER_PROCESS and DETAIL_CONCURRENCY) until the API offers a batched intervals read.
 * Never throws; never substitutes demo data.
 */
export async function fetchLiveWorkflows(
  appId: string,
  fetcher: typeof fetch = fetch,
): Promise<Loaded<LiveWorkflows>> {
  const root = base(appId);
  const listed = await getJson(`${root}/processes`, isProcessList, "lifecycle processes", fetcher);
  if (listed.status !== "ok") return listed;
  let latest: LifecycleEnvelope<unknown> = listed.data;
  const seen = (envelope: LifecycleEnvelope<unknown>) => {
    if ((envelope.as_of ?? -1) > (latest.as_of ?? -1)) latest = envelope;
  };
  if (listed.data.data_freshness.status === "unavailable") {
    return {
      status: "ok",
      data: { freshness: listed.data.data_freshness, asOf: null, snapshot: null, processes: [] },
    };
  }

  const processes = listed.data.data;
  const perProcess = await Promise.all(
    processes.map(async (process) => {
      const query = new URLSearchParams({
        process_key: process.process_key,
        version: String(process.version),
      });
      const [cases, outcomes] = await Promise.all([
        getJson(
          `${root}/cases?${query}&limit=${CASES_PER_PROCESS}`,
          isCaseList,
          "lifecycle cases",
          fetcher,
        ),
        getJson(`${root}/summaries/outcomes?${query}`, isOutcomeList, "outcome summary", fetcher),
      ]);
      return { process, cases, outcomes };
    }),
  );
  for (const { cases } of perProcess) if (cases.status !== "ok") return cases;

  const groups: (LiveProcessCases & LiveProcess)[] = [];
  for (const { process, cases, outcomes } of perProcess) {
    if (cases.status !== "ok") continue;
    seen(cases.data);
    if (outcomes.status === "ok") seen(outcomes.data);
    const details = await mapBounded(cases.data.data, DETAIL_CONCURRENCY, (summary) =>
      getJson(
        `${root}/cases/${encodeURIComponent(summary.case_id)}`,
        isCaseDetailEnvelope,
        "lifecycle case",
        fetcher,
      ),
    );
    const failed = details.find(fatal);
    if (failed) return failed;
    const loaded: CaseDetail[] = [];
    for (const detail of details) {
      if (detail.status !== "ok") continue;
      seen(detail.data);
      loaded.push(detail.data.data);
    }
    groups.push({
      id: processId(process),
      process,
      cases: loaded,
      unavailableCases: details.length - loaded.length,
      truncated: Boolean(cases.data.page?.next_cursor),
      outcomes,
    });
  }

  const asOf = latest.as_of;
  return {
    status: "ok",
    data: {
      freshness: latest.data_freshness,
      asOf,
      snapshot: asOf === null ? null : liveSnapshot(groups, asOf),
      processes: groups.map(({ cases: _cases, ...rest }) => rest),
    },
  };
}

export type LiveWorkflowsState = { status: "loading" } | Loaded<LiveWorkflows>;

/** Loads the selected app's lifecycle read model; `reload` fetches again. */
export function useLiveWorkflows(
  appId: string,
  fetcher?: typeof fetch,
): [LiveWorkflowsState, () => void] {
  const [state, setState] = useState<LiveWorkflowsState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` re-runs the fetch on reload.
  useEffect(() => {
    let live = true;
    setState({ status: "loading" });
    fetchLiveWorkflows(appId, fetcher).then((result) => live && setState(result));
    return () => {
      live = false;
    };
  }, [appId, fetcher, attempt]);
  return [state, useCallback(() => setAttempt((n) => n + 1), [])];
}
