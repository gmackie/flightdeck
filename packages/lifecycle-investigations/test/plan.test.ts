import { validateQuery } from "@flightdeckhq/lifecycle-queries";
import { describe, expect, it } from "vitest";
import {
  describeRecipes,
  HARD_LIMITS,
  InvestigationError,
  type InvestigationRequest,
  planInvestigation,
  RECIPE_IDS,
} from "../src/index.js";
import { AS_OF, BASELINE, CURRENT, catalogFor, DOMAINS, NOW, requestFor } from "./fixtures.js";

const deploy = DOMAINS.deploy;
const catalog = catalogFor(deploy);
const plan = (request: InvestigationRequest, cat = catalog) =>
  planInvestigation(request, cat, { now: NOW });
function rejects(request: InvestigationRequest, code: string, cat = catalog) {
  try {
    plan(request, cat);
  } catch (error) {
    expect(error).toBeInstanceOf(InvestigationError);
    expect((error as InvestigationError).code).toBe(code);
    return error as InvestigationError;
  }
  throw new Error("expected rejection");
}

describe("plan compiler", () => {
  it.each(
    Object.values(DOMAINS).flatMap((domain) =>
      RECIPE_IDS.map((recipe) => [domain.name, recipe] as const),
    ),
  )("%s/%s compiles to bounded, registry-valid queries under one asOf", (name, recipe) => {
    const domain = DOMAINS[name];
    const result = plan(requestFor(domain, recipe), catalogFor(domain));
    expect(result.queries.length).toBeGreaterThan(0);
    expect(result.queries.length).toBeLessThanOrEqual(result.budget.maxQueries);
    expect(new Set(result.queries.map((query) => query.id)).size).toBe(result.queries.length);
    for (const query of result.queries) {
      expect(() => validateQuery(query.query, catalogFor(domain).registry)).not.toThrow();
      expect(query.query.appId).toBe(domain.appId);
      expect(query.query.asOf).toBe(AS_OF);
      expect(query.query.topN).toBeLessThanOrEqual(result.budget.maxRowsPerQuery);
      expect(query.query.groupBy.length).toBeLessThanOrEqual(2);
      expect(query.query.filters).toEqual([]);
    }
    expect(result.id).toBe(`ip_${result.digest.slice(0, 32)}`);
  });

  it("is deterministic regardless of input ordering", () => {
    const a = plan(requestFor(deploy, "dwell-regression"));
    const reordered = requestFor(deploy, "dwell-regression", {
      cohort: { caseMix: ["major", "minor"], id: "control" },
      stages: ["rollout", "build", "review", "canary"],
    });
    expect(plan(reordered).digest).toBe(a.digest);
  });

  it("uses equal-length windows and records immaturity of the current window", () => {
    const result = plan(requestFor(deploy, "dwell-regression"));
    const baseline = result.queries.find((query) => query.arm === "baseline");
    expect(baseline?.query.from).toBe(BASELINE.from);
    expect(baseline?.query.asOf).toBe(AS_OF);
    expect(result.warnings).toContain("immature-current-window");
  });

  it("rejects unknown recipes and versions", () => {
    rejects(
      { ...requestFor(deploy, "process-health"), recipe: "sql" as never },
      "unsupported_recipe",
    );
    rejects({ ...requestFor(deploy, "process-health"), recipeVersion: 9 }, "unsupported_recipe");
  });

  it("enforces one registered app and definition for the whole plan", () => {
    rejects(requestFor(deploy, "process-health", { appId: "talent-demo" }), "forbidden");
    rejects(requestFor(deploy, "process-health", { definitionId: "other" }), "forbidden");
  });

  it("requires registered stages and allowlisted grouping", () => {
    rejects(requestFor(deploy, "bottleneck-triage", { stages: ["approval"] }), "unregistered");
    rejects(
      requestFor(deploy, "bottleneck-triage", { stages: ["build", "build"] }),
      "invalid_request",
    );
    rejects(requestFor(deploy, "bottleneck-triage", { groupBy: ["variantId"] }), "unregistered");
    rejects(requestFor(deploy, "process-health", { groupBy: ["outcome"] }), "unregistered");
    rejects(
      requestFor(deploy, "process-health", { groupBy: ["variantId", "definitionVersion"] }),
      "unregistered",
    );
    expect(
      plan(requestFor(deploy, "process-health", { groupBy: ["variantId"] })).queries[0]?.query
        .groupBy,
    ).toEqual(["caseMix", "variantId"]);
  });

  it("requires comparable definition versions across current and baseline", () => {
    rejects(
      requestFor(deploy, "process-health", { definitionVersions: ["v1", "v3"] }),
      "not_comparable",
    );
    rejects(requestFor(deploy, "process-health", { definitionVersions: ["v9"] }), "unregistered");
    rejects(
      requestFor(deploy, "dwell-regression", {
        baseline: { window: { ...BASELINE }, definitionVersions: ["v3"] },
      }),
      "not_comparable",
    );
    const pooled = plan(requestFor(deploy, "process-health", { definitionVersions: ["v2", "v1"] }));
    expect(pooled.warnings).toContain("pooled-definition-versions");
    expect(pooled.scope.definitionVersions).toEqual(["v1", "v2"]);
  });

  it("requires explicitly matched case mix for baselines and reference cohorts", () => {
    rejects(
      requestFor(deploy, "intervention-review", {
        baseline: { cohort: { id: "control", caseMix: ["minor"] } },
      }),
      "not_comparable",
    );
    rejects(
      requestFor(deploy, "intervention-review", {
        baseline: { cohort: { id: "pilot", caseMix: ["minor", "major"] } },
      }),
      "not_comparable",
    );
    rejects(
      requestFor(deploy, "dwell-regression", {
        baseline: { window: { ...BASELINE }, cohort: { id: "pilot", caseMix: ["major"] } },
      }),
      "not_comparable",
    );
    rejects(
      requestFor(deploy, "process-health", { cohort: { id: "control", caseMix: ["unknown-mix"] } }),
      "invalid_request",
    );
  });

  it("rejects incorrect time comparisons", () => {
    const regression = (window: { from: string; to: string }) =>
      requestFor(deploy, "dwell-regression", { baseline: { window } });
    // Overlapping, after, and unequal-length baselines.
    rejects(
      regression({ from: "2026-01-08T00:00:00.000Z", to: "2026-01-22T00:00:00.000Z" }),
      "invalid_window",
    );
    rejects(regression({ from: CURRENT.to, to: "2026-02-05T00:00:00.000Z" }), "invalid_window");
    rejects(
      regression({ from: "2026-01-05T00:00:00.000Z", to: "2026-01-15T00:00:00.000Z" }),
      "invalid_window",
    );
    // Window after asOf, asOf in the future, too long, before retention, non-canonical.
    rejects(
      requestFor(deploy, "process-health", { asOf: "2026-01-20T00:00:00.000Z" }),
      "invalid_window",
    );
    rejects(
      requestFor(deploy, "process-health", { asOf: "2026-03-01T00:00:00.000Z" }),
      "invalid_window",
    );
    rejects(
      requestFor(deploy, "process-health", {
        window: { from: "2026-01-01T00:00:00.000Z", to: "2026-02-04T00:00:00.000Z" },
      }),
      "invalid_window",
    );
    rejects(
      requestFor(deploy, "process-health", {
        window: { from: "2025-12-25T00:00:00.000Z", to: "2026-01-10T00:00:00.000Z" },
      }),
      "invalid_window",
    );
    rejects(
      requestFor(deploy, "process-health", { asOf: "2026-02-05T00:00:00Z" }),
      "invalid_window",
    );
    rejects(
      requestFor(deploy, "process-health", { window: { from: CURRENT.to, to: CURRENT.from } }),
      "invalid_window",
    );
  });

  it("enforces recipe parameter contracts", () => {
    rejects(requestFor(deploy, "dwell-regression", { baseline: undefined }), "invalid_request");
    rejects(
      requestFor(deploy, "bottleneck-triage", { baseline: { window: { ...BASELINE } } }),
      "invalid_request",
    );
    rejects(requestFor(deploy, "intervention-review", { baseline: undefined }), "invalid_request");
    rejects(
      requestFor(deploy, "variant-comparison", {
        baseline: { cohort: { id: "pilot", caseMix: ["minor", "major"] } },
      }),
      "invalid_request",
    );
  });

  it("only lets callers tighten budgets", () => {
    rejects(
      requestFor(deploy, "dwell-regression", { budget: { maxQueries: 3 } }),
      "budget_exceeded",
    );
    rejects(
      requestFor(deploy, "bottleneck-triage", { budget: { maxStages: 2 } }),
      "budget_exceeded",
    );
    rejects(
      requestFor(deploy, "dwell-regression", { budget: { maxCostUnits: 10 } }),
      "budget_exceeded",
    );
    rejects(
      requestFor(deploy, "process-health", { budget: { unknown: 1 } as never }),
      "invalid_request",
    );
    rejects(requestFor(deploy, "process-health", { budget: { maxQueries: 0 } }), "invalid_request");
    const loose = plan(
      requestFor(deploy, "process-health", { budget: { maxQueries: 1_000, maxConcurrency: 99 } }),
    );
    expect(loose.budget.maxQueries).toBe(12);
    expect(loose.budget.maxConcurrency).toBe(3);
    rejects(requestFor(deploy, "process-health", { topN: 1_000 }), "invalid_request");
    for (const recipe of describeRecipes())
      for (const [key, value] of Object.entries(recipe.budget))
        expect(value).toBeLessThanOrEqual(HARD_LIMITS[key as keyof typeof HARD_LIMITS]);
  });

  it("validates the trusted catalog", () => {
    rejects(requestFor(deploy, "process-health"), "invalid_catalog", {
      ...catalog,
      stages: [...catalog.stages, { id: "ghost", lane: "main" }],
    });
    rejects(requestFor(deploy, "process-health"), "invalid_catalog", {
      ...catalog,
      stages: [...catalog.stages, { id: "build", lane: "main" }],
    });
    rejects(requestFor(deploy, "process-health"), "invalid_catalog", {
      ...catalog,
      policy: { minEffectRatio: -1 },
    });
    rejects(requestFor(deploy, "process-health"), "invalid_catalog", {
      ...catalog,
      revision: "bad revision",
    });
    rejects(requestFor(deploy, "process-health"), "invalid_catalog", {
      ...catalog,
      allowedGroupBy: ["email" as never],
    });
  });

  it("never echoes request values in error messages", () => {
    const payload = "x'; DROP TABLE facts; --<script>";
    for (const request of [
      requestFor(deploy, "process-health", { appId: payload }),
      requestFor(deploy, "process-health", { stages: [payload] }),
      requestFor(deploy, "process-health", { cohort: { id: payload, caseMix: ["minor"] } }),
      requestFor(deploy, "process-health", { asOf: payload }),
    ]) {
      expect(() => plan(request)).toThrow(InvestigationError);
      try {
        plan(request);
      } catch (error) {
        expect(String((error as Error).message)).not.toContain("DROP");
        expect(String((error as Error).message)).not.toContain("script");
      }
    }
  });
});
