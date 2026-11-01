import { appsWithDueWork, LifecycleProjector } from "./projector";
import { forwardOutbox } from "./store";

/** Outbox passes per scheduled run: bounded so one run stays within its CPU budget. */
const FORWARD_PASSES = 10;

/**
 * The scheduled drain: projects due cases for the apps with the oldest due work, then forwards
 * pending outbox rows to Basin. Each app is isolated: one failing app does not stop the others.
 */
export async function drainLifecycle(env: Env, now: () => number = Date.now): Promise<void> {
  const projector = new LifecycleProjector(env.DB, { now });
  for (const appId of await appsWithDueWork(env.DB, now())) {
    await projector.drain(appId).catch(() => undefined);
  }
  for (let pass = 0; pass < FORWARD_PASSES; pass++) {
    const result = await forwardOutbox(env, now());
    if (!result.bound || result.sent === 0) break;
  }
}
