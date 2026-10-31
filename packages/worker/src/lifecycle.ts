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
 * keys, future time, duplicate ids): retrying the same events fails the same way, so quarantine
 * them. Anything else (`lifecycle forbidden`, `lifecycle unavailable`, network) is retryable.
 */
export function isPermanentLifecycleError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("lifecycle rejected");
}
