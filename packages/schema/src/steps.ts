import type { StoredEvent } from "./events.js";

export const START = "$start";
export const EXIT = "$exit";

export type Transition = { source: string; target: string; count: number };

/** The journey step an event contributes, or null when it is not a step. */
export function stepName(e: Pick<StoredEvent, "kind" | "name" | "path">): string | null {
  if (e.kind === "identify") return null;
  if (e.kind === "page") return e.path ?? e.name;
  return e.name;
}
