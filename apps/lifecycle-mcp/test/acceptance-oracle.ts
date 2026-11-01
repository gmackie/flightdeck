import type { InvestigationEvidence } from "../src/investigation-contract";
import { type SyntheticCase, syntheticCases } from "../src/sources/synthetic-data";

/**
 * An independent oracle for the acceptance tests: it recomputes expected aggregates straight from
 * the raw synthetic fixtures, without going through the source, the privacy layer or the MCP
 * handler. The tests compare it with what a real MCP client received.
 */

export const HOUR = 3_600_000;

export function cohortCases(
  appId: string,
  workflowKey: string,
  version: number,
  from: string,
  to: string,
): SyntheticCase[] {
  const lo = Date.parse(from);
  const hi = Date.parse(to);
  return syntheticCases().filter(
    (c) =>
      c.appId === appId &&
      c.workflow_key === workflowKey &&
      c.version === version &&
      c.started_at >= lo &&
      c.started_at < hi,
  );
}

/** Nearest-rank percentile, written out separately from the source's implementation. */
function nearestRank(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil(p * sorted.length);
  return sorted[rank - 1] ?? null;
}

export type ExpectedDwell = {
  n: number;
  open_n: number;
  p50_ms: number | null;
  p90_ms: number | null;
};

/** Completed intervals only; cases still in the stage count as open (right-censored). */
export function expectedDwell(cases: SyntheticCase[], stageKey: string): ExpectedDwell {
  const durations: number[] = [];
  const done = new Set<string>();
  const open = new Set<string>();
  for (const c of cases) {
    for (const i of c.intervals) {
      if (i.stage_key !== stageKey) continue;
      if (i.exited_at === null) open.add(c.case_id);
      else {
        durations.push(i.exited_at - i.entered_at);
        done.add(c.case_id);
      }
    }
  }
  return {
    n: done.size,
    open_n: open.size,
    p50_ms: nearestRank(durations, 0.5),
    p90_ms: nearestRank(durations, 0.9),
  };
}

/** What the privacy layer must release for an expected cell at threshold `k`. */
export function released(cell: ExpectedDwell, k: number) {
  if (cell.n > 0 && cell.n < k) return { suppressed: true };
  return {
    suppressed: false,
    n: cell.n,
    open_n: cell.open_n > 0 && cell.open_n < k ? null : cell.open_n,
    p50_ms: cell.p50_ms,
    p90_ms: cell.p90_ms,
  };
}

export function sample(cases: SyntheticCase[]) {
  const closed = cases.filter((c) => c.status === "closed").length;
  return { n: cases.length, completed_n: closed, open_n: cases.length - closed };
}

async function sha256(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return `sha256:${[...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Recomputes a pack's content address the way a client would verify it: strip the id and ref,
 * turn the qualified `urn#entry-n` refs back into local refs, hash the rest.
 */
export async function contentAddress(pack: InvestigationEvidence): Promise<string> {
  const { evidence_id: _id, evidence_ref, ...rest } = pack;
  const local = (ref: string) => ref.replace(`${evidence_ref}#`, "");
  return sha256({
    ...rest,
    source_reads: pack.source_reads.map((r) => ({ ...r, ref: local(r.ref) })),
    entries: pack.entries.map((e) => ({
      ...e,
      ref: local(e.ref),
      source_refs: e.source_refs.map(local),
    })),
  });
}

/** Released dwell rows of one cohort's get_stage_dwell entry, keyed by stage. */
export function dwellRows(pack: InvestigationEvidence, cohortRef: string) {
  const entry = pack.entries.find(
    (e) => e.cohort_ref === cohortRef && e.evidence.tool === "get_stage_dwell",
  )?.evidence;
  if (entry?.tool !== "get_stage_dwell") throw new Error(`no dwell entry for ${cohortRef}`);
  return Object.fromEntries(entry.result.data.stages.map((row) => [row.stage_key, row]));
}

/** A compact, reviewable digest of a pack for the golden fixture. */
export function goldenSummary(pack: InvestigationEvidence) {
  return {
    evidence_id: pack.evidence_id,
    app_id: pack.app_id,
    workflow_key: pack.workflow_key,
    as_of: pack.as_of,
    watermark: pack.watermark,
    status: pack.checks.status,
    any_suppressed: pack.checks.any_suppressed,
    samples: pack.checks.samples,
    query_ids: pack.entries.map((e) => `${e.cohort_ref}:${e.evidence.tool}:${e.query_id}`),
    dwell: Object.fromEntries(
      pack.plan.cohorts.map((c) => [
        c.cohort_ref,
        Object.fromEntries(
          Object.entries(dwellRows(pack, c.cohort_ref)).map(([stage, row]) => [
            stage,
            row.suppressed
              ? { suppressed: row.reason }
              : { n: row.n, open_n: row.open_n, p50_ms: row.p50_ms, p90_ms: row.p90_ms },
          ]),
        ),
      ]),
    ),
  };
}
