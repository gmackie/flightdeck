import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { caseDetail } from "../src/lifecycle-serving/read";
import { openSnap, prov, repo, seed, snap } from "./lifecycle-fixtures";

/** Minimal D1-compatible transaction harness over a real, private in-memory SQLite database. */
function sqlite() {
  const sql = new DatabaseSync(":memory:");
  const migration = (name) =>
    sql.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
  migration("0020_lifecycle_serving.sql");
  const prepare = (query, values = []) => ({
    bind: (...bound) => prepare(query, bound),
    async first() {
      return sql.prepare(query).get(...values) ?? null;
    },
    async all() {
      return { results: sql.prepare(query).all(...values) };
    },
    async run() {
      const statement = sql.prepare(query);
      return statement.columns().length
        ? { results: statement.all(...values), meta: { changes: 0 } }
        : { results: [], meta: { changes: Number(statement.run(...values).changes) } };
    },
  });
  const db = {
    prepare,
    async batch(statements) {
      sql.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        sql.exec("COMMIT");
        return results;
      } catch (error) {
        sql.exec("ROLLBACK");
        throw error;
      }
    },
  };
  return { db, sql, migration };
}

it("SQLite: staged publication rolls back all tables and state on failure", async () => {
  const { db, sql, migration } = sqlite();
  try {
    migration("0031_lifecycle_rebuild_staging.sql");
    const { repo: r } = repo(db);
    const app = "app_sqlite_atomic";
    await seed(r, app, [
      snap("keep", { relations: [{ relation: "blocks", to_case_id: "target" }] }),
      snap("target"),
    ]);
    const before = await caseDetail(db, app, "keep");
    expect(before?.intervals).toHaveLength(2);
    expect(before?.relations.outgoing).toHaveLength(1);
    const generation = await r.beginRebuild(app);
    await r.upsertCase(app, openSnap("keep"), prov(generation, 200));
    expect(await caseDetail(db, app, "keep")).toEqual(before);
    // Fail after earlier publication statements have run, proving batch rollback, not just a guard.
    sql.exec(`CREATE TRIGGER fail_publication BEFORE INSERT ON lifecycle_case_snapshots
      WHEN NEW.generation = 2 BEGIN SELECT RAISE(ABORT, 'synthetic publication failure'); END`);
    await expect(r.commitRebuild(app, prov(generation, 200))).rejects.toThrow(
      "synthetic publication failure",
    );
    expect(await caseDetail(db, app, "keep")).toEqual(before);
    expect(await caseDetail(db, app, "target")).not.toBeNull();
    expect(await r.state(app)).toMatchObject({
      active_generation: 1,
      building_generation: 2,
      source_watermark: 100,
    });
    await r.failRebuild(app, generation, "synthetic_failure");
    expect(await caseDetail(db, app, "keep")).toEqual(before);
    sql.exec("DROP TRIGGER fail_publication");
    const retry = await r.beginRebuild(app);
    await r.upsertCase(app, openSnap("keep"), prov(retry, 201));
    await r.commitRebuild(app, prov(retry, 201));
    const committed = await caseDetail(db, app, "keep");
    expect(committed).toMatchObject({
      status: "open",
      provenance: { generation: 3 },
      relations: { outgoing: [] },
    });
    expect(await caseDetail(db, app, "target")).toBeNull();
    await expect(r.commitRebuild(app, prov(retry, 201))).rejects.toThrow();
    expect(await caseDetail(db, app, "keep")).toEqual(committed);
  } finally {
    sql.close();
  }
});
