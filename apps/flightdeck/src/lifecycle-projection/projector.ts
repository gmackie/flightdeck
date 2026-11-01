import { replay } from "@flightdeckhq/lifecycle";
import type { ProcessDefinitionV1 } from "@flightdeckhq/schema";
import type { ProcessDefinitionInput, Provenance } from "../lifecycle-serving/model";
import { SnapshotRejected } from "../lifecycle-serving/model";
import { LifecycleSnapshotRepository } from "../lifecycle-serving/repository";
import { getDefinitions, processKey } from "../processes";
import { adaptCase } from "./adapter";
import { servingId, toSnapshot } from "./snapshot";
import { backoff, caseLog } from "./store";

/**
 * Projects the evidence log (0030) into the serving read model (0020): replays each queued case
 * from its full stored history (so late, reordered and corrected events need no special path),
 * maps the result to a snapshot and writes it with provenance. Rebuilds an app from scratch the
 * first time, or on request. Failures stay queued and retry with backoff, recording only codes.
 */

/** Stamped on every snapshot; bump when adapter or mapping semantics change, then rebuild. */
export const REDUCER_VERSION = "lifecycle@0.1.1+fd.1";
/** Cases projected per drain call, and per rebuild page. */
export const DRAIN_LIMIT = 50;
const REBUILD_PAGE = 100;

const QUEUE = "lifecycle_projection_queue";
const DIAGNOSTICS = "lifecycle_projection_diagnostics";
const LOG = "lifecycle_event_log";

export type ProjectOptions = { now?: () => number; limit?: number };
export type DrainResult = {
  rebuilt: boolean;
  projected: number;
  removed: number;
  failed: number;
  remaining: number;
};

export class LifecycleProjector {
  private readonly repo: LifecycleSnapshotRepository;
  private readonly now: () => number;

  constructor(
    private readonly db: D1Database,
    options: ProjectOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.repo = new LifecycleSnapshotRepository(db, this.now);
  }

  /** Projects due queued cases of one app; rebuilds first if the app was never projected. */
  async drain(appId: string, limit = DRAIN_LIMIT): Promise<DrainResult> {
    const state = await this.repo.state(appId);
    if (!state || (state.active_generation === 0 && state.building_generation === null)) {
      const projected = await this.rebuild(appId);
      return { rebuilt: true, ...projected, remaining: await this.pending(appId) };
    }
    const generation = state.building_generation ?? state.active_generation;
    const { results: due } = await this.db
      .prepare(
        `SELECT case_id, attempts FROM ${QUEUE} WHERE app_id = ? AND next_attempt_at <= ?
         ORDER BY next_attempt_at, case_id LIMIT ?`,
      )
      .bind(appId, this.now(), limit)
      .all<{ case_id: string; attempts: number }>();
    const totals = { rebuilt: false, projected: 0, removed: 0, failed: 0 };
    for (const item of due) {
      const outcome = await this.projectQueued(appId, item.case_id, item.attempts, generation);
      totals[outcome] += 1;
    }
    await this.advance(appId);
    return { ...totals, remaining: await this.pending(appId) };
  }

  /**
   * Rebuilds the app's whole projection into a new generation from the evidence log, then
   * activates it. Readers keep the previous generation until the commit.
   */
  async rebuild(appId: string): Promise<{ projected: number; removed: number; failed: number }> {
    const generation = await this.repo.beginRebuild(appId);
    const totals = { projected: 0, removed: 0, failed: 0 };
    try {
      const top = await this.db
        .prepare(`SELECT max(seq) AS seq FROM ${LOG} WHERE app_id = ?`)
        .bind(appId)
        .first<{ seq: number | null }>();
      const watermark = top?.seq ?? 0;
      let after = "";
      for (;;) {
        const { results } = await this.db
          .prepare(
            `SELECT DISTINCT case_id FROM ${LOG} WHERE app_id = ? AND seq <= ? AND case_id > ?
             ORDER BY case_id LIMIT ?`,
          )
          .bind(appId, watermark, after, REBUILD_PAGE)
          .all<{ case_id: string }>();
        for (const { case_id } of results) {
          try {
            const outcome = await this.projectCase(appId, case_id, generation);
            totals[outcome] += 1;
          } catch (error) {
            // One bad case must not block the app: it is queued for retry, the rest commit.
            totals.failed += 1;
            await this.requeue(appId, case_id, 0, errorCode(error));
          }
        }
        if (results.length < REBUILD_PAGE) break;
        after = results.at(-1)?.case_id ?? after;
      }
      await this.repo.commitRebuild(appId, this.provenance(generation, watermark));
      // Work the rebuild covered is done; anything that arrived during it stays queued.
      await this.db
        .prepare(
          `DELETE FROM ${QUEUE} WHERE app_id = ? AND enqueued_seq <= ? AND last_error_code IS NULL`,
        )
        .bind(appId, watermark)
        .run();
      return totals;
    } catch (error) {
      await this.repo.failRebuild(appId, generation, errorCode(error));
      throw error;
    }
  }

  private async projectQueued(
    appId: string,
    caseId: string,
    attempts: number,
    generation: number,
  ): Promise<"projected" | "removed" | "failed"> {
    try {
      return await this.projectCase(appId, caseId, generation);
    } catch (error) {
      await this.requeue(appId, caseId, attempts + 1, errorCode(error));
      return "failed";
    }
  }

  /** Replays one case from its full stored history and writes (or removes) its snapshot. */
  async projectCase(
    appId: string,
    caseId: string,
    generation: number,
  ): Promise<"projected" | "removed"> {
    const asOf = this.now();
    const { rows, maxSeq } = await caseLog(this.db, appId, caseId);
    const records = rows.map((r) => r.record);
    const keys = [...new Set(records.map((r) => processKey(r.process_id, r.process_version)))];
    const definitions = await getDefinitions(this.db, appId, keys);
    const adapted = adaptCase(caseId, records, definitions, asOf);
    const provenance = this.provenance(generation, maxSeq, asOf);
    let mapped: Awaited<ReturnType<typeof toSnapshot>>;
    if (adapted.facts) {
      mapped = await toSnapshot(replay(adapted.input), adapted.facts, adapted.issues);
    } else {
      const diagnostics = new Map<string, number>();
      for (const issue of adapted.issues) {
        diagnostics.set(issue.code, (diagnostics.get(issue.code) ?? 0) + 1);
      }
      mapped = { snapshot: null, diagnostics };
    }
    let outcome: "projected" | "removed" = "removed";
    if (mapped.snapshot && adapted.facts) {
      await this.repo.upsertProcessDefinition(
        appId,
        servingDefinition(adapted.facts.definition),
        provenance,
      );
      await this.repo.upsertCase(appId, mapped.snapshot, provenance);
      outcome = "projected";
    } else if (adapted.facts) {
      // Evidence no longer yields a servable case (e.g. its start was retracted): hide it.
      await this.repo.tombstoneCase(appId, await servingId(caseId), provenance);
    }
    await this.finish(appId, caseId, maxSeq, mapped.diagnostics);
    return outcome;
  }

  /** Records diagnostics and clears the queue entry if no newer event arrived meanwhile. */
  private async finish(
    appId: string,
    caseId: string,
    seq: number,
    diagnostics: Map<string, number>,
  ): Promise<void> {
    const now = this.now();
    await this.db.batch([
      this.db
        .prepare(`DELETE FROM ${DIAGNOSTICS} WHERE app_id = ? AND case_id = ?`)
        .bind(appId, caseId),
      ...[...diagnostics].map(([code, count]) =>
        this.db
          .prepare(
            `INSERT INTO ${DIAGNOSTICS} (app_id, case_id, code, count, updated_at)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .bind(appId, caseId, code, count, now),
      ),
      this.db
        .prepare(`DELETE FROM ${QUEUE} WHERE app_id = ? AND case_id = ? AND enqueued_seq <= ?`)
        .bind(appId, caseId, seq),
    ]);
  }

  private async requeue(appId: string, caseId: string, attempts: number, code: string) {
    const top = await this.db
      .prepare(`SELECT max(seq) AS seq FROM ${LOG} WHERE app_id = ? AND case_id = ?`)
      .bind(appId, caseId)
      .first<{ seq: number | null }>();
    await this.db
      .prepare(
        `INSERT INTO ${QUEUE} (app_id, case_id, enqueued_seq, attempts, next_attempt_at,
           last_error_code) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (app_id, case_id) DO UPDATE SET attempts = excluded.attempts,
           next_attempt_at = excluded.next_attempt_at, last_error_code = excluded.last_error_code`,
      )
      .bind(appId, caseId, top?.seq ?? 0, attempts, this.now() + backoff(attempts), code)
      .run();
  }

  /**
   * Moves the committed watermark to the highest seq below every still-queued case: all evidence
   * at or below it is reflected. `as_of` records when that was last confirmed.
   */
  private async advance(appId: string): Promise<void> {
    const row = await this.db
      .prepare(
        `SELECT coalesce((SELECT min(enqueued_seq) - 1 FROM ${QUEUE} WHERE app_id = ?),
           (SELECT max(seq) FROM ${LOG} WHERE app_id = ?), 0) AS seq`,
      )
      .bind(appId, appId)
      .first<{ seq: number }>();
    await this.repo.advanceWatermark(appId, { source_watermark: row?.seq ?? 0, as_of: this.now() });
  }

  private async pending(appId: string): Promise<number> {
    const row = await this.db
      .prepare(`SELECT count(*) AS n FROM ${QUEUE} WHERE app_id = ?`)
      .bind(appId)
      .first<{ n: number }>();
    return row?.n ?? 0;
  }

  private provenance(generation: number, watermark: number, asOf = this.now()): Provenance {
    return {
      generation,
      source_watermark: watermark,
      as_of: asOf,
      reducer_version: REDUCER_VERSION,
    };
  }
}

/** Apps with due projection work, oldest first (for the scheduled drain). */
export async function appsWithDueWork(db: D1Database, now: number, limit = 20): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT app_id FROM ${QUEUE} WHERE next_attempt_at <= ?
       GROUP BY app_id ORDER BY min(next_attempt_at) LIMIT ?`,
    )
    .bind(now, limit)
    .all<{ app_id: string }>();
  return results.map((r) => r.app_id);
}

/** Definition labels are free product text; the read model allows a narrow charset. */
const LABEL_CHARS = /[^\p{L}\p{N} _.,:()&/+-]/gu;
const label = (text: string, fallback: string) =>
  text.replace(LABEL_CHARS, " ").trim().slice(0, 80) || fallback;

export function servingDefinition(d: ProcessDefinitionV1): ProcessDefinitionInput {
  return {
    process_key: d.processId,
    version: d.version,
    label: label(d.name, d.processId),
    stages: d.stages.map((s) => ({
      key: s.stageId,
      label: label(s.name, s.stageId),
      ...(s.terminal ? { terminal: true } : {}),
    })),
  };
}

/** Error codes only: never messages, which could carry values. */
function errorCode(error: unknown): string {
  if (error instanceof SnapshotRejected) return `snapshot_${error.reason}`;
  return "projection_error";
}
