import type { CaseSnapshotInput, Provenance } from "../src/lifecycle-serving/model";
import { LifecycleSnapshotRepository } from "../src/lifecycle-serving/repository";

/** Fictional deployment-pipeline snapshots: opaque ids only, no people. */
export const T0 = Date.UTC(2026, 9, 1);
export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

export const prov = (generation: number, source_watermark: number, as_of = T0): Provenance => ({
  generation,
  source_watermark,
  as_of,
  reducer_version: "lifecycle@1",
});

/** A closed two-stage deploy unless overridden. */
export const snap = (
  case_id: string,
  over: Partial<CaseSnapshotInput> = {},
): CaseSnapshotInput => ({
  case_id,
  process_key: "deploy",
  process_version: 1,
  status: "closed",
  outcome: "success",
  current_stage: "release",
  parent_case_id: null,
  started_at: T0,
  ended_at: T0 + 2 * HOUR,
  last_event_at: T0 + 2 * HOUR,
  intervals: [
    { stage_key: "build", state: "active", entered_at: T0, exited_at: T0 + HOUR },
    { stage_key: "release", state: "active", entered_at: T0 + HOUR, exited_at: T0 + 2 * HOUR },
  ],
  ...over,
});

export const openSnap = (case_id: string, over: Partial<CaseSnapshotInput> = {}) =>
  snap(case_id, {
    status: "open",
    outcome: null,
    current_stage: "build",
    ended_at: null,
    last_event_at: T0,
    intervals: [{ stage_key: "build", state: "active", entered_at: T0, exited_at: null }],
    ...over,
  });

export const DEPLOY_V1 = {
  process_key: "deploy",
  version: 1,
  label: "Deploy pipeline",
  stages: [
    { key: "build", label: "Build" },
    { key: "release", label: "Release", terminal: true },
  ],
};

/** A repository whose clock the test controls. */
export function repo(db: D1Database, clock = { now: T0 + DAY }) {
  return { clock, repo: new LifecycleSnapshotRepository(db, () => clock.now) };
}

/** Begins, writes and commits generation 1 for an app. */
export async function seed(
  r: LifecycleSnapshotRepository,
  appId: string,
  cases: CaseSnapshotInput[],
  mark = { source_watermark: 100, as_of: T0 + DAY },
): Promise<number> {
  const gen = await r.beginRebuild(appId);
  await r.upsertProcessDefinition(appId, DEPLOY_V1, prov(gen, mark.source_watermark));
  for (const c of cases) await r.upsertCase(appId, c, prov(gen, mark.source_watermark));
  await r.commitRebuild(appId, { ...prov(gen, mark.source_watermark), as_of: mark.as_of });
  return gen;
}
