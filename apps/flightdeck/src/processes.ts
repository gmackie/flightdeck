import { ProcessDefinitionV1 } from "@flightdeckhq/schema";
import * as v from "valibot";

/** `processId@version`, the registry key within one app. */
export const processKey = (processId: string, version: number) => `${processId}@${version}`;

// Definitions are immutable once registered, so a hit never goes stale. Misses are not cached:
// a producer that registers and then retries must see its definition at once.
const MAX_CACHED = 1_000;
const cache = new Map<string, ProcessDefinitionV1>();
const cacheKey = (appId: string, key: string) => `${appId}\n${key}`;

export function clearProcessCache(): void {
  cache.clear();
}

/** The registered definitions among `keys` for `appId`, in one query. */
export async function getDefinitions(
  db: D1Database,
  appId: string,
  keys: string[],
): Promise<Map<string, ProcessDefinitionV1>> {
  const found = new Map<string, ProcessDefinitionV1>();
  const missing: string[] = [];
  for (const key of new Set(keys)) {
    const hit = cache.get(cacheKey(appId, key));
    if (hit) found.set(key, hit);
    else missing.push(key);
  }
  if (!missing.length) return found;
  // One bound parameter however many keys: D1 caps bound parameters per statement.
  const { results } = await db
    .prepare(
      `SELECT process_id, version, definition FROM process_definitions
       WHERE app_id = ? AND process_id || '@' || version IN (SELECT value FROM json_each(?))`,
    )
    .bind(appId, JSON.stringify(missing))
    .all<{ process_id: string; version: number; definition: string }>();
  for (const row of results) {
    // Stored rows were validated on registration; parse again so a bad row fails closed.
    const parsed = v.safeParse(ProcessDefinitionV1, JSON.parse(row.definition));
    if (!parsed.success) continue;
    const key = processKey(row.process_id, row.version);
    found.set(key, parsed.output);
    if (cache.size >= MAX_CACHED) cache.clear();
    cache.set(cacheKey(appId, key), parsed.output);
  }
  return found;
}

export type RegisterResult =
  | { status: "created" | "unchanged"; definition: ProcessDefinitionV1 }
  | { status: "conflict" }
  | { status: "invalid"; message: string };

/**
 * Registers a process version for `appId`. Idempotent for identical content; a different
 * definition under an existing version is a conflict, since events already reference it.
 */
export async function registerDefinition(
  db: D1Database,
  appId: string,
  input: unknown,
): Promise<RegisterResult> {
  const parsed = v.safeParse(ProcessDefinitionV1, input);
  if (!parsed.success) {
    const issue = parsed.issues[0];
    const path = issue ? v.getDotPath(issue) : null;
    // Never echo the input: drop valibot's "received <value>" suffix.
    const text = (issue?.message ?? "invalid").replace(/(:| but)? [Rr]eceived .*$/s, "");
    return { status: "invalid", message: (path ? `${path}: ${text}` : text).slice(0, 160) };
  }
  const definition = parsed.output;
  // The parsed output has a fixed key order, so equal definitions serialize identically.
  const json = JSON.stringify(definition);
  const insert = await db
    .prepare(
      `INSERT OR IGNORE INTO process_definitions (app_id, process_id, version, definition)
       VALUES (?, ?, ?, ?)`,
    )
    .bind(appId, definition.processId, definition.version, json)
    .run();
  if (insert.meta.changes > 0) return { status: "created", definition };
  const existing = await db
    .prepare(
      "SELECT definition FROM process_definitions WHERE app_id = ? AND process_id = ? AND version = ?",
    )
    .bind(appId, definition.processId, definition.version)
    .first<{ definition: string }>();
  return existing?.definition === json
    ? { status: "unchanged", definition }
    : { status: "conflict" };
}
