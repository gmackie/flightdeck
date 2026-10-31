import { ulid } from "ulid";
import {
  CaseSnapshotInput,
  OPAQUE_ID,
  ProcessDefinitionInput,
  Provenance,
  parseInput,
  SLUG,
  SnapshotRejected,
} from "./model";

/**
 * Writes and maintains the derived lifecycle read model (migration 0020). Its only intended
 * caller is a projector that replays lifecycle evidence; none is connected yet.
 *
 * Generations: `beginRebuild` issues generation N+1 and the projector writes every snapshot with
 * it; `commitRebuild` makes it the active generation and soft-deletes rows from older
 * generations that the rebuild did not rewrite. Incremental updates between rebuilds write with
 * the active generation, or with the building one while a rebuild runs, then `advanceWatermark`.
 *
 * Idempotence: a write lands only when it is not older than the stored row, ordered by
 * (generation, source_watermark). Replaying the same snapshot rewrites identical values; an older
 * one is reported as `stale` and changes nothing.
 *
 * Deletion (migration 0021): `tombstoneCase` erases a case's rows and records a tombstone, even
 * for a case never projected. Every later write for it is refused as `tombstoned`, whatever its
 * generation or watermark, until `restoreCase` is approved by an injected authorizer; after that
 * only snapshots strictly newer than the deletion watermark land. Tombstones survive rebuilds,
 * `purgeDeleted` and `dropApp`.
 */

export type ProjectionStatus = "empty" | "ready" | "rebuilding" | "failed";

export type ProjectionState = {
  app_id: string;
  active_generation: number;
  building_generation: number | null;
  issued_generation: number;
  status: ProjectionStatus;
  source_watermark: number | null;
  as_of: number | null;
  reducer_version: string | null;
  rows_written: number;
  last_success_at: number | null;
  last_failure_at: number | null;
  last_error_code: string | null;
  updated_at: number;
};

export type WriteResult = "written" | "stale" | "tombstoned";

/**
 * Approves restoring one deleted case. There is no default: callers must inject a checker (e.g.
 * an owner/admin grant from the RBAC module). Throwing or returning false refuses the restore.
 */
export type RestoreAuthorizer = (check: {
  appId: string;
  caseId: string;
  reason: string;
  approvalRef: string;
}) => Promise<boolean>;

export type ReplayRequest = {
  app_id: string;
  request_id: string;
  reason: string;
  from_watermark: number | null;
  status: "queued" | "running" | "done" | "failed";
  attempts: number;
  requested_at: number;
  started_at: number | null;
  finished_at: number | null;
  error_code: string | null;
};

/** D1 binds at most 100 parameters per statement; the 4 guard parameters leave room for these. */
const INTERVALS_PER_INSERT = 10;
const EDGES_PER_INSERT = 18;
/** Parent chains deeper than this are treated as cycles. */
const MAX_DEPTH = 64;

const CASES = "lifecycle_case_snapshots";
const DEFINITIONS = "lifecycle_process_definitions";
const INTERVALS = "lifecycle_stage_intervals";
const EDGES = "lifecycle_case_edges";
const STATE = "lifecycle_projection_state";
const REPLAYS = "lifecycle_replay_requests";
const TOMBSTONES = "lifecycle_case_tombstones";

/** The write is for a generation the projection accepts: the active or the building one. */
const ACCEPTS_GENERATION = `EXISTS (SELECT 1 FROM ${STATE} s WHERE s.app_id = ?
  AND (s.active_generation = ? OR s.building_generation = ?))`;
/** Newer generation wins; within one generation, the higher (or equal) watermark wins. */
const NOT_OLDER = (table: string) =>
  `excluded.generation > ${table}.generation OR (excluded.generation = ${table}.generation
   AND excluded.source_watermark >= ${table}.source_watermark)`;
/**
 * No tombstone blocks the write: none exists, or it was restored and the write is strictly newer
 * than the deletion. Binds (app_id, case_id, source_watermark).
 */
const NOT_TOMBSTONED = `NOT EXISTS (SELECT 1 FROM ${TOMBSTONES} t WHERE t.app_id = ?
  AND t.case_id = ? AND (t.restored_at IS NULL OR ? <= t.source_watermark))`;
/** Children are rewritten only when the case row now holds exactly this write. */
const CASE_HOLDS_WRITE = `EXISTS (SELECT 1 FROM ${CASES} c WHERE c.app_id = ? AND c.case_id = ?
  AND c.generation = ? AND c.source_watermark = ? AND c.deleted_at IS NULL)`;

export class LifecycleSnapshotRepository {
  constructor(
    private readonly db: D1Database,
    private readonly now: () => number = Date.now,
  ) {}

  async state(appId: string): Promise<ProjectionState | null> {
    return this.db
      .prepare(`SELECT * FROM ${STATE} WHERE app_id = ?`)
      .bind(appId)
      .first<ProjectionState>();
  }

  /** Issues a new generation for a full rebuild. Readers keep seeing the active one. */
  async beginRebuild(appId: string): Promise<number> {
    const now = this.now();
    const row = await this.db
      .prepare(
        `INSERT INTO ${STATE} (app_id, building_generation, issued_generation, status, updated_at)
         VALUES (?, 1, 1, 'rebuilding', ?)
         ON CONFLICT (app_id) DO UPDATE SET
           issued_generation = issued_generation + 1,
           building_generation = issued_generation + 1,
           status = 'rebuilding', updated_at = excluded.updated_at
         RETURNING building_generation`,
      )
      .bind(appId, now)
      .first<{ building_generation: number }>();
    if (!row) throw new Error("projection state unavailable");
    return row.building_generation;
  }

  /**
   * Activates a rebuilt generation at the watermark it reflects, and soft-deletes rows from
   * older generations that it did not rewrite (e.g. cases removed from the source).
   */
  async commitRebuild(
    appId: string,
    provenance: Provenance,
  ): Promise<{ superseded_cases: number; superseded_definitions: number }> {
    const p = parseInput(Provenance, provenance);
    const now = this.now();
    const gen = p.generation;
    const active = `EXISTS (SELECT 1 FROM ${STATE} WHERE app_id = ? AND active_generation = ?)`;
    const [commit, cases, definitions] = await this.db.batch([
      this.db
        .prepare(
          `UPDATE ${STATE} SET active_generation = ?, building_generation = NULL, status = 'ready',
             source_watermark = ?, as_of = ?, reducer_version = ?, last_success_at = ?,
             last_error_code = NULL, updated_at = ?,
             rows_written = (SELECT count(*) FROM ${CASES}
               WHERE app_id = ? AND generation = ? AND deleted_at IS NULL)
           WHERE app_id = ? AND building_generation = ?`,
        )
        .bind(
          gen,
          p.source_watermark,
          p.as_of,
          p.reducer_version,
          now,
          now,
          appId,
          gen,
          appId,
          gen,
        ),
      this.db
        .prepare(
          `UPDATE ${CASES} SET deleted_at = ?, deleted_reason = 'superseded'
           WHERE app_id = ? AND generation < ? AND deleted_at IS NULL AND ${active}`,
        )
        .bind(now, appId, gen, appId, gen),
      this.db
        .prepare(
          `UPDATE ${DEFINITIONS} SET deleted_at = ?, deleted_reason = 'superseded'
           WHERE app_id = ? AND generation < ? AND deleted_at IS NULL AND ${active}`,
        )
        .bind(now, appId, gen, appId, gen),
    ]);
    if (!commit?.meta.changes) {
      throw new SnapshotRejected("generation", "generation is not being rebuilt");
    }
    return {
      superseded_cases: cases?.meta.changes ?? 0,
      superseded_definitions: definitions?.meta.changes ?? 0,
    };
  }

  /** Abandons a rebuild. The active generation stays readable; the failure is recorded as a code. */
  async failRebuild(appId: string, generation: number, errorCode: string): Promise<void> {
    if (!SLUG.test(errorCode)) throw new SnapshotRejected("invalid", "errorCode: slug");
    const now = this.now();
    await this.db
      .prepare(
        `UPDATE ${STATE} SET building_generation = NULL, status = 'failed', last_failure_at = ?,
           last_error_code = ?, updated_at = ?
         WHERE app_id = ? AND building_generation = ?`,
      )
      .bind(now, errorCode, now, appId, generation)
      .run();
  }

  /** After incremental writes: moves the committed watermark forward, never back. */
  async advanceWatermark(
    appId: string,
    mark: { source_watermark: number; as_of: number },
  ): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE ${STATE} SET source_watermark = ?, as_of = ?, updated_at = ?
         WHERE app_id = ? AND active_generation > 0
           AND (source_watermark IS NULL OR source_watermark <= ?)`,
      )
      .bind(mark.source_watermark, mark.as_of, this.now(), appId, mark.source_watermark)
      .run();
    return result.meta.changes > 0;
  }

  async upsertProcessDefinition(
    appId: string,
    definition: ProcessDefinitionInput,
    provenance: Provenance,
  ): Promise<WriteResult> {
    const d = parseInput(ProcessDefinitionInput, definition);
    const p = parseInput(Provenance, provenance);
    const stages = d.stages.map((s) => ({ key: s.key, label: s.label, terminal: !!s.terminal }));
    const result = await this.db
      .prepare(
        `INSERT INTO ${DEFINITIONS} (app_id, process_key, version, label, stages_json, generation,
           source_watermark, as_of, updated_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${ACCEPTS_GENERATION}
         ON CONFLICT (app_id, process_key, version) DO UPDATE SET
           label = excluded.label, stages_json = excluded.stages_json,
           generation = excluded.generation, source_watermark = excluded.source_watermark,
           as_of = excluded.as_of, updated_at = excluded.updated_at,
           deleted_at = NULL, deleted_reason = NULL
         WHERE ${NOT_OLDER(DEFINITIONS)}`,
      )
      .bind(
        appId,
        d.process_key,
        d.version,
        d.label,
        JSON.stringify(stages),
        p.generation,
        p.source_watermark,
        p.as_of,
        this.now(),
        appId,
        p.generation,
        p.generation,
      )
      .run();
    return this.outcome(appId, p.generation, result.meta.changes);
  }

  /**
   * Replaces one case: its row, its stage intervals and its outgoing relations, atomically.
   * Rejects parent links that would form a cycle; a parent that has not been projected yet is
   * fine (out-of-order arrival) and is reported as unavailable by the read API.
   */
  async upsertCase(
    appId: string,
    snapshot: CaseSnapshotInput,
    provenance: Provenance,
  ): Promise<WriteResult> {
    const c = parseInput(CaseSnapshotInput, snapshot);
    const p = parseInput(Provenance, provenance);
    if (c.parent_case_id && (await this.wouldCycle(appId, c.case_id, c.parent_case_id))) {
      throw new SnapshotRejected("cycle", "parent_case_id is a descendant of the case");
    }
    const now = this.now();
    const guard = [appId, c.case_id, p.generation, p.source_watermark];
    const statements = [
      this.db
        .prepare(
          `INSERT INTO ${CASES} (app_id, case_id, process_key, process_version, status, outcome,
             current_stage, parent_case_id, started_at, ended_at, last_event_at, generation,
             source_watermark, reducer_version, as_of, updated_at)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
           WHERE ${ACCEPTS_GENERATION} AND ${NOT_TOMBSTONED}
           ON CONFLICT (app_id, case_id) DO UPDATE SET
             process_key = excluded.process_key, process_version = excluded.process_version,
             status = excluded.status, outcome = excluded.outcome,
             current_stage = excluded.current_stage, parent_case_id = excluded.parent_case_id,
             started_at = excluded.started_at, ended_at = excluded.ended_at,
             last_event_at = excluded.last_event_at, generation = excluded.generation,
             source_watermark = excluded.source_watermark,
             reducer_version = excluded.reducer_version, as_of = excluded.as_of,
             updated_at = excluded.updated_at, deleted_at = NULL, deleted_reason = NULL
           WHERE ${NOT_OLDER(CASES)}`,
        )
        .bind(
          appId,
          c.case_id,
          c.process_key,
          c.process_version,
          c.status,
          c.outcome ?? null,
          c.current_stage ?? null,
          c.parent_case_id ?? null,
          c.started_at,
          c.ended_at ?? null,
          c.last_event_at,
          p.generation,
          p.source_watermark,
          p.reducer_version,
          p.as_of,
          now,
          appId,
          p.generation,
          p.generation,
          appId,
          c.case_id,
          p.source_watermark,
        ),
      this.db
        .prepare(
          `DELETE FROM ${INTERVALS} WHERE app_id = ? AND case_id = ? AND ${CASE_HOLDS_WRITE}`,
        )
        .bind(appId, c.case_id, ...guard),
      this.db
        .prepare(
          `DELETE FROM ${EDGES} WHERE app_id = ? AND from_case_id = ? AND ${CASE_HOLDS_WRITE}`,
        )
        .bind(appId, c.case_id, ...guard),
    ];
    for (let i = 0; i < c.intervals.length; i += INTERVALS_PER_INSERT) {
      const chunk = c.intervals.slice(i, i + INTERVALS_PER_INSERT);
      statements.push(
        this.db
          .prepare(
            `INSERT INTO ${INTERVALS} (app_id, case_id, seq, stage_key, state, entered_at,
               exited_at, outcome, generation)
             SELECT * FROM (VALUES ${chunk.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ")})
             WHERE ${CASE_HOLDS_WRITE}`,
          )
          .bind(
            ...chunk.flatMap((iv, j) => [
              appId,
              c.case_id,
              i + j,
              iv.stage_key,
              iv.state,
              iv.entered_at,
              iv.exited_at,
              iv.outcome ?? null,
              p.generation,
            ]),
            ...guard,
          ),
      );
    }
    // Duplicate relations collapse to one edge.
    const relations = [
      ...new Map((c.relations ?? []).map((r) => [`${r.relation} ${r.to_case_id}`, r])).values(),
    ];
    for (let i = 0; i < relations.length; i += EDGES_PER_INSERT) {
      const chunk = relations.slice(i, i + EDGES_PER_INSERT);
      statements.push(
        this.db
          .prepare(
            `INSERT INTO ${EDGES} (app_id, from_case_id, relation, to_case_id, generation)
             SELECT * FROM (VALUES ${chunk.map(() => "(?, ?, ?, ?, ?)").join(", ")})
             WHERE ${CASE_HOLDS_WRITE}`,
          )
          .bind(
            ...chunk.flatMap((r) => [appId, c.case_id, r.relation, r.to_case_id, p.generation]),
            ...guard,
          ),
      );
    }
    const [upsert] = await this.db.batch(statements);
    return this.outcome(appId, p.generation, upsert?.meta.changes ?? 0, {
      caseId: c.case_id,
      sourceWatermark: p.source_watermark,
    });
  }

  /**
   * Deletes a case for good: removes its row, intervals and outgoing relations, and records a
   * tombstone so no later or replayed snapshot can recreate it. Works for cases never projected
   * (out-of-order deletion) and regardless of generation state, so erasure cannot be refused.
   * Re-deleting keeps the highest watermark and re-arms a restored tombstone.
   */
  async tombstoneCase(
    appId: string,
    caseId: string,
    provenance: Provenance,
    reason = "source_deleted",
  ): Promise<WriteResult> {
    const p = parseInput(Provenance, provenance);
    if (!OPAQUE_ID.test(caseId)) throw new SnapshotRejected("invalid", "case_id: opaque id");
    if (!SLUG.test(reason)) throw new SnapshotRejected("invalid", "reason: slug");
    const now = this.now();
    await this.db.batch([
      this.db
        .prepare(`DELETE FROM ${INTERVALS} WHERE app_id = ? AND case_id = ?`)
        .bind(appId, caseId),
      this.db
        .prepare(`DELETE FROM ${EDGES} WHERE app_id = ? AND from_case_id = ?`)
        .bind(appId, caseId),
      this.db.prepare(`DELETE FROM ${CASES} WHERE app_id = ? AND case_id = ?`).bind(appId, caseId),
      this.db
        .prepare(
          `INSERT INTO ${TOMBSTONES} (app_id, case_id, reason, source_watermark, as_of, deleted_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (app_id, case_id) DO UPDATE SET
             reason = excluded.reason,
             source_watermark = max(source_watermark, excluded.source_watermark),
             as_of = max(as_of, excluded.as_of), deleted_at = excluded.deleted_at,
             restored_at = NULL, restore_reason = NULL, restore_ref = NULL`,
        )
        .bind(appId, caseId, reason, p.source_watermark, p.as_of, now),
    ]);
    return "written";
  }

  /**
   * Lifts a tombstone after the injected authorizer approves. Only snapshots strictly newer than
   * the deletion watermark are admitted afterwards; the restore itself writes no case data.
   * Returns false when the case has no active tombstone.
   */
  async restoreCase(
    appId: string,
    caseId: string,
    approval: { reason: string; approval_ref: string },
    authorize: RestoreAuthorizer,
  ): Promise<boolean> {
    if (!OPAQUE_ID.test(caseId)) throw new SnapshotRejected("invalid", "case_id: opaque id");
    if (!SLUG.test(approval.reason)) throw new SnapshotRejected("invalid", "reason: slug");
    if (!OPAQUE_ID.test(approval.approval_ref)) {
      throw new SnapshotRejected("invalid", "approval_ref: opaque id");
    }
    let allowed = false;
    try {
      allowed =
        (await authorize({
          appId,
          caseId,
          reason: approval.reason,
          approvalRef: approval.approval_ref,
        })) === true;
    } catch {
      allowed = false;
    }
    if (!allowed) throw new SnapshotRejected("unauthorized", "restore was not approved");
    const result = await this.db
      .prepare(
        `UPDATE ${TOMBSTONES} SET restored_at = ?, restore_reason = ?, restore_ref = ?
         WHERE app_id = ? AND case_id = ? AND restored_at IS NULL`,
      )
      .bind(this.now(), approval.reason, approval.approval_ref, appId, caseId)
      .run();
    return result.meta.changes > 0;
  }

  /** Retention: soft-deletes closed cases that ended before the cutoff. Open cases are kept. */
  async applyRetention(appId: string, closedBefore: number): Promise<number> {
    const result = await this.db
      .prepare(
        `UPDATE ${CASES} SET deleted_at = ?, deleted_reason = 'retention'
         WHERE app_id = ? AND status = 'closed' AND ended_at < ? AND deleted_at IS NULL`,
      )
      .bind(this.now(), appId, closedBefore)
      .run();
    return result.meta.changes;
  }

  /** Hard-deletes rows soft-deleted before the cutoff, with their intervals and relations. */
  async purgeDeleted(appId: string, deletedBefore: number): Promise<{ cases: number }> {
    const doomed = `SELECT case_id FROM ${CASES}
      WHERE app_id = ? AND deleted_at IS NOT NULL AND deleted_at < ?`;
    const [, , cases] = await this.db.batch([
      this.db
        .prepare(`DELETE FROM ${INTERVALS} WHERE app_id = ? AND case_id IN (${doomed})`)
        .bind(appId, appId, deletedBefore),
      this.db
        .prepare(`DELETE FROM ${EDGES} WHERE app_id = ? AND from_case_id IN (${doomed})`)
        .bind(appId, appId, deletedBefore),
      this.db
        .prepare(
          `DELETE FROM ${CASES} WHERE app_id = ? AND deleted_at IS NOT NULL AND deleted_at < ?`,
        )
        .bind(appId, deletedBefore),
      this.db
        .prepare(
          `DELETE FROM ${DEFINITIONS} WHERE app_id = ? AND deleted_at IS NOT NULL AND deleted_at < ?`,
        )
        .bind(appId, deletedBefore),
    ]);
    return { cases: cases?.meta.changes ?? 0 };
  }

  /**
   * Forgets everything derived for an app ahead of a clean rebuild. Keeps tombstones (so the
   * rebuild cannot resurrect deleted cases) and replay history.
   */
  async dropApp(appId: string): Promise<void> {
    await this.db.batch(
      [INTERVALS, EDGES, CASES, DEFINITIONS, STATE].map((table) =>
        this.db.prepare(`DELETE FROM ${table} WHERE app_id = ?`).bind(appId),
      ),
    );
  }

  /** Queues a rebuild; while one is already queued for the app, returns that one instead. */
  async requestReplay(
    appId: string,
    request: { reason: string; from_watermark?: number | null },
  ): Promise<{ request_id: string; created: boolean }> {
    if (!SLUG.test(request.reason)) throw new SnapshotRejected("invalid", "reason: slug");
    const id = ulid();
    const result = await this.db
      .prepare(
        `INSERT INTO ${REPLAYS} (app_id, request_id, reason, from_watermark, status, requested_at)
         SELECT ?, ?, ?, ?, 'queued', ?
         WHERE NOT EXISTS (SELECT 1 FROM ${REPLAYS} WHERE app_id = ? AND status = 'queued')`,
      )
      .bind(appId, id, request.reason, request.from_watermark ?? null, this.now(), appId)
      .run();
    if (result.meta.changes > 0) return { request_id: id, created: true };
    const queued = await this.db
      .prepare(
        `SELECT request_id FROM ${REPLAYS} WHERE app_id = ? AND status = 'queued'
         ORDER BY requested_at LIMIT 1`,
      )
      .bind(appId)
      .first<{ request_id: string }>();
    if (!queued) throw new Error("replay queue unavailable");
    return { request_id: queued.request_id, created: false };
  }

  /** Marks the oldest queued request running and returns it, or null when none is queued. */
  async claimReplay(appId: string): Promise<ReplayRequest | null> {
    return this.db
      .prepare(
        `UPDATE ${REPLAYS} SET status = 'running', attempts = attempts + 1, started_at = ?
         WHERE app_id = ? AND request_id = (SELECT request_id FROM ${REPLAYS}
           WHERE app_id = ? AND status = 'queued' ORDER BY requested_at LIMIT 1)
         RETURNING *`,
      )
      .bind(this.now(), appId, appId)
      .first<ReplayRequest>();
  }

  async finishReplay(appId: string, requestId: string, errorCode?: string): Promise<void> {
    if (errorCode !== undefined && !SLUG.test(errorCode)) {
      throw new SnapshotRejected("invalid", "errorCode: slug");
    }
    await this.db
      .prepare(
        `UPDATE ${REPLAYS} SET status = ?, finished_at = ?, error_code = ?
         WHERE app_id = ? AND request_id = ? AND status = 'running'`,
      )
      .bind(errorCode ? "failed" : "done", this.now(), errorCode ?? null, appId, requestId)
      .run();
  }

  /**
   * Operator view of one app's projection: state, row counts and the queue. Counts and codes
   * only: no case ids, approval references or snapshot content.
   */
  async diagnostics(appId: string) {
    const [state, rows, tombstones, replays] = await Promise.all([
      this.state(appId),
      this.db
        .prepare(
          `SELECT count(*) FILTER (WHERE deleted_at IS NULL) AS live,
             count(*) FILTER (WHERE deleted_at IS NOT NULL) AS deleted
           FROM ${CASES} WHERE app_id = ?`,
        )
        .bind(appId)
        .first<{ live: number; deleted: number }>(),
      this.db
        .prepare(
          `SELECT count(*) FILTER (WHERE restored_at IS NULL) AS active,
             count(*) FILTER (WHERE restored_at IS NOT NULL) AS restored
           FROM ${TOMBSTONES} WHERE app_id = ?`,
        )
        .bind(appId)
        .first<{ active: number; restored: number }>(),
      this.db
        .prepare(`SELECT status, count(*) AS n FROM ${REPLAYS} WHERE app_id = ? GROUP BY status`)
        .bind(appId)
        .all<{ status: string; n: number }>(),
    ]);
    return {
      state,
      cases: { live: rows?.live ?? 0, deleted: rows?.deleted ?? 0 },
      tombstones: { active: tombstones?.active ?? 0, restored: tombstones?.restored ?? 0 },
      replays: Object.fromEntries(replays.results.map((r) => [r.status, r.n])),
    };
  }

  /** True when `parentId` is `caseId` or one of its descendants (bounded walk up the parents). */
  private async wouldCycle(appId: string, caseId: string, parentId: string): Promise<boolean> {
    const hit = await this.db
      .prepare(
        `WITH RECURSIVE chain(id, depth) AS (
           SELECT ?, 0
           UNION
           SELECT c.parent_case_id, chain.depth + 1 FROM ${CASES} c JOIN chain
             ON c.app_id = ? AND c.case_id = chain.id
           WHERE c.parent_case_id IS NOT NULL AND c.deleted_at IS NULL AND chain.depth < ?
         )
         SELECT max(depth) AS depth, max(id = ?) AS cycle FROM chain`,
      )
      .bind(parentId, appId, MAX_DEPTH, caseId)
      .first<{ depth: number; cycle: number }>();
    return !!hit && (hit.cycle === 1 || hit.depth >= MAX_DEPTH);
  }

  /**
   * No change means a tombstone refused the write, its generation is not open, or it was older
   * than the stored row.
   */
  private async outcome(
    appId: string,
    generation: number,
    changes: number,
    blocked?: { caseId: string; sourceWatermark: number },
  ): Promise<WriteResult> {
    if (changes > 0) return "written";
    if (blocked) {
      const refused = await this.db
        .prepare(`SELECT NOT ${NOT_TOMBSTONED} AS hit`)
        .bind(appId, blocked.caseId, blocked.sourceWatermark)
        .first<{ hit: number }>();
      if (refused?.hit) return "tombstoned";
    }
    const state = await this.state(appId);
    if (
      !state ||
      (state.active_generation !== generation && state.building_generation !== generation)
    ) {
      throw new SnapshotRejected("generation", "generation is neither active nor being rebuilt");
    }
    return "stale";
  }
}
