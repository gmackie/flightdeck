import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { generate } from "../../../examples/lifecycle-fixtures/lib/generate.mjs";
import { adaptFixtures, type DeliveryRecord } from "./support/fixture-adapter";
import { deliver, type Json, producerApp, project } from "./support/harness";
import { diffAgainstTruth, diffEntities } from "./support/truth";

/**
 * Cross-domain end to end: synthetic hiring, deployment and incident histories (FLIG-20 fixtures)
 * adapted to LifecycleEventV1, sent through the real ingest endpoint with scoped keys against
 * registered process definitions, projected through the engine into D1, and compared with the
 * fixtures' independent ground truth.
 */

type Scenario = { name: string; records: DeliveryRecord[]; expected: Json };
const scenarios = Object.values(
  import.meta.glob("../../../examples/lifecycle-fixtures/fixtures/scenarios/*.json", {
    eager: true,
    import: "default",
  }),
) as Scenario[];

/** Each fixture app gets its own Flightdeck app per test, so scenarios never share ids. */
let apps = 0;
async function run(records: readonly DeliveryRecord[]) {
  const adapted = await adaptFixtures(records);
  const mapping = new Map<string, string>();
  for (const [fixtureApp, events] of adapted.byApp) {
    const appId = `app_e2e_${++apps}`;
    mapping.set(fixtureApp, appId);
    const key = await producerApp(appId);
    await deliver(key, events);
    await project(appId);
  }
  return { ...adapted, apps: mapping };
}

const COMPARED = scenarios.filter(
  (s) => s.expected.apps && !["broken-state-machine", "duplicate-id-conflict"].includes(s.name),
);

describe("fixture scenarios through ingest, replay and the D1 read model", () => {
  it("covers the committed scenarios", () => {
    expect(COMPARED.map((s) => s.name).sort()).toMatchSnapshot();
  });

  it.each(COMPARED.map((s) => [s.name, s] as const))("%s matches the oracle", async (_, s) => {
    const result = await run(s.records);
    const problems: string[] = [];
    for (const [fixtureApp, truth] of Object.entries<Json>(s.expected.apps)) {
      const appId = result.apps.get(fixtureApp);
      if (!appId) {
        problems.push(`no events for ${fixtureApp}`);
        continue;
      }
      problems.push(...(await diffAgainstTruth(appId, truth)));
    }
    const onlyApp = [...result.apps.values()];
    if (s.expected.entities && onlyApp.length === 1) {
      problems.push(...(await diffEntities(onlyApp[0] as string, s.expected.entities)));
    }
    expect(problems).toEqual([]);
  });
});

describe("generated 1k dataset (seed 7, default noise profile)", () => {
  it("projects every app to the generator's ground truth", async () => {
    const { records, truth } = generate({ seed: "7", events: 1000 });
    const result = await run(records);
    const problems: string[] = [];
    for (const [fixtureApp, appTruth] of Object.entries<Json>(truth.apps)) {
      const appId = result.apps.get(fixtureApp) as string;
      problems.push(...(await diffAgainstTruth(appId, appTruth)).map((p) => `${fixtureApp} ${p}`));
    }
    expect(problems).toEqual([]);
    // Per-event invalid fixtures never reach the producer contract. Orphan stage exits are only
    // detectable over a whole history: ingest accepts them and the engine reports each one.
    const invalid = truth.totals.invalid as { count: number; byReason: Record<string, number> };
    const orphans = invalid.byReason.orphan_stage_exit ?? 0;
    const rejected = [...result.rejected.values()].reduce((n, c) => n + c, 0);
    expect(rejected + orphans).toBe(invalid.count);
    const { results } = await env.DB.prepare(
      `SELECT sum(count) AS n FROM lifecycle_projection_diagnostics
       WHERE code = 'missing_boundary' AND app_id IN (SELECT value FROM json_each(?))`,
    )
      .bind(JSON.stringify([...result.apps.values()]))
      .all<{ n: number }>();
    expect(results[0]?.n ?? 0).toBeGreaterThanOrEqual(orphans);
    const { n } = (await env.DB.prepare(
      "SELECT count(*) AS n FROM lifecycle_projection_queue",
    ).first<{ n: number }>()) ?? { n: -1 };
    expect(n).toBe(0);
  }, 120_000);
});
