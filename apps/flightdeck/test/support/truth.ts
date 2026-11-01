import { PROCESSES } from "../../../../examples/lifecycle-fixtures/lib/processes.mjs";
import { processIdOf } from "./fixture-adapter";
import { attempts, type Json, servedModel } from "./harness";

/**
 * Compares an app's served D1 read model with the fixtures' ground truth (`apps.<appId>` of an
 * expected.json or a scenario's `expected`), checking only what the truth states. Returns
 * mismatch descriptions; empty means the projection agrees with the oracle.
 */
export async function diffAgainstTruth(appId: string, truth: Json): Promise<string[]> {
  const model = await servedModel(appId);
  const kindProcess = new Map(
    Object.entries(PROCESSES).flatMap(([process, p]) =>
      Object.keys(p.kinds).map((kind) => [kind, processIdOf(process, kind)] as const),
    ),
  );
  const problems: string[] = [];
  const expect = (what: string, actual: unknown, expected: unknown) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      problems.push(`${what}: served ${JSON.stringify(actual)}, truth ${JSON.stringify(expected)}`);
    }
  };
  for (const [kind, want] of Object.entries<Json>(truth.entities ?? {})) {
    const cases = model.cases.filter((c: Json) => c.process_key === kindProcess.get(kind));
    if (want.total !== undefined) expect(`${kind} total`, cases.length, want.total);
    if (want.outcomes) {
      const tally: Record<string, number> = {};
      for (const c of cases as Json[])
        if (c.outcome) tally[c.outcome] = (tally[c.outcome] ?? 0) + 1;
      expect(`${kind} outcomes`, sorted(tally), sorted(want.outcomes));
    }
    if (want.status) {
      const closed = cases.filter((c: Json) => c.status === "closed").length;
      // The read model has no paused case status: paused cases are open.
      expect(
        `${kind} status`,
        { open: cases.length - closed, closed },
        {
          open: (want.status.open ?? 0) + (want.status.paused ?? 0),
          closed: want.status.closed ?? 0,
        },
      );
    }
  }
  const byCase = attempts(model.intervals);
  const processOf = new Map(model.cases.map((c: Json) => [c.case_id, c.process_key]));
  for (const [key, want] of Object.entries<Json>(truth.stages ?? {})) {
    const [kind, stage] = key.split("/") as [string, string];
    const all = [...byCase].flatMap(([caseId, list]) =>
      processOf.get(caseId) === kindProcess.get(kind) ? list.filter((a) => a.stage === stage) : [],
    );
    const closed = all
      .filter((a) => a.exited !== null)
      .map((a) => (a.exited as number) - a.entered);
    if (want.entered !== undefined) expect(`${key} entered`, all.length, want.entered);
    if (want.exited !== undefined) expect(`${key} exited`, closed.length, want.exited);
    if (want.open !== undefined) expect(`${key} open`, all.length - closed.length, want.open);
    const dwell = want.closedDwell;
    if (dwell) {
      expect(`${key} closed count`, closed.length, dwell.count);
      if (dwell.sumMs !== undefined) {
        expect(
          `${key} closed sum`,
          closed.reduce((n, v) => n + v, 0),
          dwell.sumMs,
        );
      }
      if (dwell.minMs !== undefined) expect(`${key} closed min`, Math.min(...closed), dwell.minMs);
      if (dwell.maxMs !== undefined) expect(`${key} closed max`, Math.max(...closed), dwell.maxMs);
    }
  }
  return problems;
}

const sorted = (o: Record<string, number>) =>
  Object.fromEntries(
    Object.entries(o)
      .filter(([, n]) => n > 0)
      .sort(([a], [b]) => (a < b ? -1 : 1)),
  );

/** Served case status/outcome for a scenario's per-entity expectations. */
export async function diffEntities(appId: string, entities: readonly Json[]): Promise<string[]> {
  const model = await servedModel(appId);
  const byId = new Map(model.cases.map((c: Json) => [c.case_id, c]));
  return entities.flatMap((e) => {
    const c: Json = byId.get(e.id);
    if (!c) return [`entity ${e.id} not served`];
    const status = e.status === "paused" ? "open" : e.status;
    const problems: string[] = [];
    if (c.status !== status) problems.push(`entity ${e.id} status ${c.status}, truth ${e.status}`);
    if (e.outcome !== undefined && (c.outcome ?? null) !== (e.outcome ?? null)) {
      problems.push(`entity ${e.id} outcome ${c.outcome}, truth ${e.outcome}`);
    }
    return problems;
  });
}
