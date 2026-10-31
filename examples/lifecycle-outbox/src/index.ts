import {
  flightdeckLifecycle,
  isPermanentLifecycleError,
  type LifecycleEventInput,
} from "@flightdeckhq/worker";

/**
 * A deploy tracker that reports each deploy's lifecycle to Flightdeck through a transactional
 * outbox (docs/operations/lifecycle-ingestion.md):
 *
 * 1. A state change and its lifecycle event commit together in one D1 batch.
 * 2. A cron drains pending rows in `seq` order with the stable `event_id` minted at step 1.
 * 3. Rows are marked sent only after Flightdeck accepted them, so delivery is at least once;
 *    Flightdeck readers dedupe on `(app_id, event_id)`.
 */

const PROCESS = { processId: "deploy", processVersion: 1 } as const;
const BATCH = 100;
const STAGES = new Set(["build", "canary", "rollout", "done"]);

type Pending = { seq: number; event_id: string; payload: string };

/** `Omit` over each member of a union, keeping the transitions' distinct shapes. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** What the app writes: `eventId` is minted here, `sourceSequence` is the row's `seq`. */
type Draft = DistributiveOmit<LifecycleEventInput, "eventId" | "sourceSequence">;

const newEventId = () => `evt_${crypto.randomUUID().replaceAll("-", "")}`;

function enqueue(db: D1Database, draft: Draft): D1PreparedStatement {
  const eventId = newEventId();
  return db
    .prepare("INSERT INTO lifecycle_outbox (event_id, payload) VALUES (?, ?)")
    .bind(eventId, JSON.stringify({ ...draft, eventId }));
}

/** Moves a deploy to `stage`: exits the current stage instance and enters a new one. */
async function advance(db: D1Database, deployId: string, stage: string): Promise<void> {
  const current = await db
    .prepare("SELECT stage, stage_instance FROM deploys WHERE id = ?")
    .bind(deployId)
    .first<{ stage: string; stage_instance: string }>();
  const occurredAt = Date.now();
  const base = { schemaVersion: 1, ...PROCESS, caseId: `deploy:${deployId}`, occurredAt } as const;
  const instance = `${deployId}:${stage}:${occurredAt}`;
  const statements: D1PreparedStatement[] = [];
  if (!current) {
    statements.push(
      db
        .prepare("INSERT INTO deploys (id, stage, stage_instance) VALUES (?, ?, ?)")
        .bind(deployId, stage, instance),
      enqueue(db, { ...base, type: "case.created" }),
    );
  } else {
    statements.push(
      db
        .prepare("UPDATE deploys SET stage = ?, stage_instance = ? WHERE id = ?")
        .bind(stage, instance, deployId),
      enqueue(db, {
        ...base,
        type: "stage.exited",
        stageId: current.stage,
        stageInstanceId: current.stage_instance,
      }),
    );
  }
  statements.push(
    enqueue(db, { ...base, type: "stage.entered", stageId: stage, stageInstanceId: instance }),
  );
  if (stage === "done") statements.push(enqueue(db, { ...base, type: "case.completed" }));
  // One D1 batch is one transaction: the state change and its events commit together.
  await db.batch(statements);
}

const toEvent = (row: Pending): unknown => ({
  ...JSON.parse(row.payload),
  sourceSequence: row.seq,
});

async function mark(db: D1Database, column: "sent_at" | "quarantined_at", rows: Pending[]) {
  if (!rows.length) return;
  const now = Date.now();
  await db.batch(
    rows.map((r) =>
      db.prepare(`UPDATE lifecycle_outbox SET ${column} = ? WHERE seq = ?`).bind(now, r.seq),
    ),
  );
}

/** Sends pending events in order. Stops at the first retryable failure; the next run resumes. */
export async function drain(env: Env): Promise<void> {
  const lifecycle = flightdeckLifecycle(env);
  const { results } = await env.DB.prepare(
    `SELECT seq, event_id, payload FROM lifecycle_outbox
     WHERE sent_at IS NULL AND quarantined_at IS NULL ORDER BY seq LIMIT ?`,
  )
    .bind(BATCH)
    .all<Pending>();
  if (!results.length) return;
  try {
    await lifecycle.ingestLifecycleBatch({ events: results.map(toEvent) });
    await mark(env.DB, "sent_at", results);
    return;
  } catch (error) {
    if (!isPermanentLifecycleError(error)) throw error; // Retry the same batch next run.
  }
  // A batch is rejected whole, so isolate the bad events one at a time and quarantine them.
  for (const row of results) {
    try {
      await lifecycle.trackLifecycle(toEvent(row));
      await mark(env.DB, "sent_at", [row]);
    } catch (error) {
      if (!isPermanentLifecycleError(error)) throw error;
      console.error(`lifecycle event ${row.event_id} quarantined`, error);
      await mark(env.DB, "quarantined_at", [row]);
    }
  }
}

export default {
  async fetch(request, env) {
    const match = new URL(request.url).pathname.match(/^\/deploys\/([\w-]{1,64})\/(\w+)$/);
    if (request.method !== "POST" || !match?.[1] || !match[2]) {
      return new Response("Not found", { status: 404 });
    }
    if (!STAGES.has(match[2])) return new Response("Unknown stage", { status: 400 });
    await advance(env.DB, match[1], match[2]);
    return Response.json({ ok: true });
  },
  async scheduled(_controller, env) {
    await drain(env);
  },
} satisfies ExportedHandler<Env>;
