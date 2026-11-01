import { erasureConfig, retentionConfig } from "./config";
import { type BasinErasureExecutor, failClosedExecutor } from "./executor";
import { drainJob, dueJobs } from "./jobs";
import { verifierFromEnv } from "./receipt";
import { applyRetention } from "./retention";

/**
 * Scheduled erasure and retention maintenance. With both modes "off" (the default) this reads
 * nothing and writes nothing. It never creates erasure jobs (only an operator can), and it only
 * ever advances existing ones using the executor it is given: by default the fail-closed one.
 */
export async function maintainErasure(
  env: Env,
  now: () => number = Date.now,
  executor: BasinErasureExecutor = failClosedExecutor,
): Promise<void> {
  const erasure = erasureConfig(env);
  if (erasure.mode === "enforce") {
    const deps = { db: env.DB, config: erasure, executor, verifier: verifierFromEnv(env), now };
    for (const key of await dueJobs(env.DB, now()))
      await drainJob(deps, key).catch(() => undefined);
  }
  const retention = retentionConfig(env);
  if (retention.mode === "enforce") {
    const { results } = await env.DB.prepare(
      "SELECT app_id FROM lifecycle_retention_checkpoints",
    ).all<{
      app_id: string;
    }>();
    for (const { app_id } of results) {
      await applyRetention({ db: env.DB, config: retention, now }, app_id).catch(() => undefined);
    }
  }
}
