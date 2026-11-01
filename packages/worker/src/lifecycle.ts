import type { LifecycleRpc } from "@flightdeckhq/schema";

/**
 * Returns the lifecycle methods of the Flightdeck service binding (`trackLifecycle`,
 * `ingestLifecycleBatch`). Unlike `track`, they do not fail open: a lifecycle producer keeps
 * events in an outbox and must know whether Flightdeck stored them, so errors are thrown.
 */
export function flightdeckLifecycle<E extends object>(
  env: E,
  options: { binding?: string } = {},
): LifecycleRpc {
  const name = options.binding ?? "FLIGHTDECK";
  const binding = (env as Record<string, LifecycleRpc | undefined>)[name];
  if (!binding) throw new Error(`Flightdeck: env.${name} service binding is missing`);
  return binding;
}

/**
 * True when Flightdeck rejected the batch for good (invalid, unsupported version, personal-data
 * keys, duplicate ids): retrying the same events fails the same way, so quarantine them.
 * Anything else is retryable: `lifecycle forbidden`, `lifecycle unavailable`,
 * `lifecycle throttled`, network errors,
 * `future_occurred_at` (clock skew, which passes once Flightdeck's clock catches up) and
 * `unknown_process` (passes once the process version is registered).
 */
export function isPermanentLifecycleError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const { message } = error;
  return (
    message.startsWith("lifecycle rejected") &&
    !message.startsWith("lifecycle rejected (future_occurred_at)") &&
    !message.startsWith("lifecycle rejected (unknown_process)")
  );
}
