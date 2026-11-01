import type { Pipeline } from "cloudflare:pipelines";
import type { LifecycleRecord, SessionRecord, StoredEvent } from "@flightdeckhq/schema";
import lifecycleSchema from "../pipelines/lifecycle_events.schema.json";
import { LifecycleUnavailable } from "./ingest/lifecycle";

/** Optional stream fields are omitted on the wire; nested JSON nulls are retained. */
export function streamRow<T extends object>(
  row: T,
): { [K in keyof T]: Exclude<T[K], null> | (null extends T[K] ? undefined : never) } {
  return Object.fromEntries(Object.entries(row).filter(([, value]) => value !== null)) as {
    [K in keyof T]: Exclude<T[K], null> | (null extends T[K] ? undefined : never);
  };
}

export type StreamField = {
  name: string;
  type: string;
  required: boolean;
  unit?: string;
  items?: StreamField;
  fields?: StreamField[];
};

export const LIFECYCLE_FIELDS = lifecycleSchema.fields as StreamField[];

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function valueProblem(f: StreamField, value: unknown): string | null {
  switch (f.type) {
    case "string":
      return typeof value === "string" ? null : "expected string";
    case "bool":
      return typeof value === "boolean" ? null : "expected bool";
    case "int32":
      return Number.isInteger(value) && Math.abs(value as number) <= 2 ** 31 - 1
        ? null
        : "expected int32";
    case "int64":
    case "timestamp":
      return Number.isSafeInteger(value) ? null : `expected ${f.type}`;
    case "json":
      return isObject(value) ? null : "expected JSON object";
    case "struct":
      if (!isObject(value)) return "expected struct";
      return streamProblems(f.fields ?? [], value)[0] ?? null;
    case "list":
      if (!Array.isArray(value) || !f.items) return "expected list";
      for (const item of value) {
        const problem = item == null ? "null list item" : valueProblem(f.items, item);
        if (problem) return problem;
      }
      return null;
    default:
      return `unsupported type ${f.type}`;
  }
}

/**
 * Why `row` (as sent on the wire) would not match a structured stream schema. Basin can accept
 * and then silently drop non-conforming records, so lifecycle rows are checked before sending.
 */
export function streamProblems(fields: StreamField[], row: Record<string, unknown>): string[] {
  const problems: string[] = [];
  const known = new Set(fields.map((f) => f.name));
  for (const key of Object.keys(row)) if (!known.has(key)) problems.push(`${key}: not in schema`);
  for (const f of fields) {
    const value = row[f.name];
    if (value === undefined || value === null) {
      if (f.required) problems.push(`${f.name}: required`);
      continue;
    }
    const problem = valueProblem(f, value);
    if (problem) problems.push(`${f.name}: ${problem}`);
  }
  return problems;
}

/** The opt-in lifecycle stream; absent until an operator provisions and binds it. */
export function lifecycleStream(env: Env): Pipeline | undefined {
  return (env as { LIFECYCLE_EVENTS?: Pipeline }).LIFECYCLE_EVENTS;
}

/** Pipelines writes go through this object so tests can stub them with `vi.spyOn(sinks, ...)`. */
export const sinks = {
  events: (env: Env, rows: StoredEvent[]): Promise<void> => env.EVENTS.send(rows.map(streamRow)),
  sessions: (env: Env, rows: SessionRecord[]): Promise<void> =>
    env.SESSIONS.send(rows.map(streamRow)),
  lifecycle: async (env: Env, rows: LifecycleRecord[]): Promise<void> => {
    const stream = lifecycleStream(env);
    if (!stream) throw new LifecycleUnavailable("LIFECYCLE_EVENTS is not bound");
    const wire = rows.map(streamRow);
    for (const row of wire) {
      const problems = streamProblems(LIFECYCLE_FIELDS, row);
      // A bug, not bad input: fail the batch so the producer retries after a fix.
      if (problems.length) throw new Error(`lifecycle row breaks stream schema: ${problems[0]}`);
    }
    await stream.send(wire);
  },
};
