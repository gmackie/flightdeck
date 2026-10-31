// Types for the dependency-free synthetic fixture generator (examples/lifecycle-fixtures, FLIG-20).
declare module "*/lifecycle-fixtures/lib/processes.mjs" {
  export type FixtureKind = {
    kind: string;
    parent?: string;
    terminal: string[];
    stageNames: Set<string>;
  };
  export const PROCESSES: Record<string, { root: string; kinds: Record<string, FixtureKind> }>;
}
declare module "*/lifecycle-fixtures/lib/model.mjs" {
  export function validateEvent(event: unknown): string | null;
}
declare module "*/lifecycle-fixtures/lib/generate.mjs" {
  export type FixtureAppTruth = {
    entities: Record<string, { total: number; outcomes?: Record<string, number> }>;
    stages: Record<
      string,
      {
        entered: number;
        exited: number;
        open: number;
        closedDwell?: { count: number; sumMs?: number; minMs?: number; maxMs?: number };
      }
    >;
  };
  export function generate(config: {
    seed: string;
    events: number;
    profile?: string;
    apps?: { appId: string; processes: string[] }[];
    distinctIds?: boolean;
  }): {
    records: { receivedAt: string; event: Record<string, unknown> }[];
    entities: { appId: string; kind: string; id: string; status: string; outcome: string | null }[];
    truth: {
      asOf: string;
      totals: Record<string, unknown>;
      apps: Record<string, FixtureAppTruth>;
    };
  };
}
