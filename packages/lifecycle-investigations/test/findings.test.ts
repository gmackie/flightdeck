import { describe, expect, it } from "vitest";
import {
  type EvidencePack,
  executeInvestigation,
  type InvestigationRequest,
  RECIPE_IDS,
  type RecipeId,
  serializeEvidencePack,
} from "../src/index.js";
import {
  AS_OF,
  adapterFor,
  allow,
  catalogFor,
  DOMAINS,
  type DomainSpec,
  type FactOptions,
  instrument,
  NOW,
  RECORDED_AT,
  requestFor,
} from "./fixtures.js";

async function run(
  domain: DomainSpec,
  recipe: RecipeId,
  overrides: Partial<InvestigationRequest> = {},
  facts: FactOptions & { watermark?: string; transform?: (result: unknown) => unknown } = {},
) {
  const { adapter } = instrument(adapterFor(domain, facts), {
    transform: facts.transform ? (result) => facts.transform?.(result) : undefined,
  });
  return (
    await executeInvestigation(requestFor(domain, recipe, overrides), {
      catalog: catalogFor(domain),
      adapter,
      authorize: allow(domain.appId),
      now: NOW,
    })
  ).pack;
}
const find = (pack: EvidencePack, id: string) => {
  const finding = pack.findings.find((item) => item.id === id);
  if (!finding) throw new Error(`missing finding ${id}`);
  return finding;
};
const rowByRef = (pack: EvidencePack, ref: string) =>
  pack.evidence.flatMap((entry) => entry.rows).find((row) => row.ref === ref);

describe("grounding invariants across synthetic domains", () => {
  const cases = Object.values(DOMAINS).flatMap((domain) =>
    RECIPE_IDS.map((recipe) => [domain, recipe] as const),
  );
  it.each(cases.map(([domain, recipe]) => [domain.name, recipe, domain] as const))(
    "%s/%s: every finding is grounded in exact pack refs",
    async (_, recipe, domain) => {
      const pack = await run(domain, recipe);
      const rows = new Set(pack.evidence.flatMap((entry) => entry.rows.map((row) => row.ref)));
      const entries = new Set(pack.evidence.map((entry) => entry.ref));
      expect(pack.findings.length).toBeGreaterThan(0);
      expect(new Set(pack.findings.map((finding) => finding.id)).size).toBe(pack.findings.length);
      for (const finding of pack.findings) {
        for (const ref of finding.evidenceRefs) expect(rows.has(ref)).toBe(true);
        for (const ref of finding.metadataRefs) expect(entries.has(ref)).toBe(true);
        expect(finding.metadataRefs.length).toBeGreaterThan(0);
        if (finding.status === "cannot_determine") {
          expect(finding.measure).toBeNull();
          expect(finding.reasons.length).toBeGreaterThan(0);
        } else {
          expect(finding.evidenceRefs.length).toBeGreaterThan(0);
          expect(finding.reasons).toEqual([]);
          if (finding.hypothesisId !== "context") expect(finding.measure).not.toBeNull();
        }
        expect(finding.statement).not.toMatch(/\b(caused|because of|due to|led to|resulted in)\b/i);
      }
      // Every query in the plan used the same knowledge cut-off.
      for (const entry of pack.evidence)
        if (entry.metadata) expect(entry.metadata.asOf).toBe(AS_OF);
      // Aggregates only: no synthetic case identifiers are present.
      expect(serializeEvidencePack(pack)).not.toMatch(
        new RegExp(`${domain.name}-(current|baseline|rare)-`),
      );
    },
  );
});

describe("bottleneck triage (synthetic hiring pipeline with parallel lanes)", () => {
  const hiring = DOMAINS.hiring;
  it("ranks per-stage medians without ever summing parallel stage dwell", async () => {
    const pack = await run(hiring, "bottleneck-triage");
    const rank = find(pack, "f:stage-median-rank:H1:caseMix=standard");
    expect(rank.status).toBe("observed");
    expect(rank.measure?.name).toBe("p50Ms:interview");
    expect(rank.uncertainty.notes.join(" ")).toMatch(/never summed/);
    expect(pack.warnings).toContain("parallel-lanes");
    const medians = pack.evidence
      .filter((entry) => entry.purpose === "stage-dwell")
      .flatMap((entry) => entry.rows.filter((row) => row.group.caseMix === "standard"))
      .map((row) => row.sample?.p50Ms ?? 0);
    // The rank equals an actual source median, including when two other stage
    // medians happen to sum to that value. Numeric coincidences are not evidence of summation.
    expect(medians).toContain(rank.measure?.value);
    expect(rank.measure?.value).toBe(Math.max(...medians));
  });

  it("locates open (right-censored) work separately from observed dwell", async () => {
    const pack = await run(hiring, "bottleneck-triage");
    const open = find(pack, "f:stage-open-work-rank:H2:caseMix=priority");
    expect(open.status).toBe("observed");
    expect(open.measure).toEqual({ name: "censoredCases:offer", value: 3, unit: "cases" });
  });
});

describe("dwell regression (synthetic deploy pipeline)", () => {
  const deploy = DOMAINS.deploy;
  it("detects the slowed stage within matched strata and reports maturity", async () => {
    const pack = await run(deploy, "dwell-regression");
    for (const caseMix of deploy.caseMix) {
      const review = find(pack, `f:dwell-change:H1:caseMix=${caseMix}:review`);
      expect(review.status).toBe("observed");
      expect(review.statement).toMatch(/\+60\.0%/);
      const [current, baseline] = review.evidenceRefs.map((ref) => rowByRef(pack, ref));
      expect(current && baseline).toBeTruthy();
      expect(find(pack, `f:dwell-change:H1:caseMix=${caseMix}:build`).status).toBe("not_observed");
    }
    expect(pack.hypotheses.find((item) => item.id === "H1")?.status).toBe("supported");
    expect(pack.hypotheses.find((item) => item.id === "H2")?.status).toBe("not_supported");
    expect(pack.knowledge.maturity.map((item) => item.arm)).toEqual(["current", "baseline"]);
    expect(pack.knowledge.maturity[1]?.maturityMs).toBeGreaterThan(
      pack.knowledge.maturity[0]?.maturityMs ?? 0,
    );
  });

  it("refuses to compare when one window is mostly right-censored", async () => {
    const pack = await run(deploy, "dwell-regression", {}, { currentOpenCases: 4 });
    const rollout = find(pack, "f:dwell-change:H1:caseMix=minor:rollout");
    expect(rollout.status).toBe("cannot_determine");
    expect(rollout.reasons).toContain("right-censoring");
    expect(rollout.measure).toBeNull();
  });

  it("refuses to compare when censoring differs between windows", async () => {
    const pack = await run(deploy, "dwell-regression", {}, { currentOpenCases: 0 });
    const rollout = find(pack, "f:dwell-change:H1:caseMix=major:rollout");
    expect(rollout.status).toBe("cannot_determine");
    expect(rollout.reasons).toEqual(["censoring-imbalance"]);
  });

  it("treats inconsistent watermarks across compared queries as undeterminable", async () => {
    const pack = await run(
      deploy,
      "dwell-regression",
      {},
      {
        transform: (result) => {
          const value = structuredClone(result) as {
            metadata: { watermark: string; definitionVersions: string[] };
            metric: { kind: string };
          };
          if (value.metric.kind === "stage-dwell" && value.metadata.watermark === AS_OF)
            value.metadata.watermark = "2026-02-04T23:00:00.000Z";
          return value;
        },
      },
    );
    expect(pack.warnings).toContain("inconsistent-watermark");
    // The two case-count queries share a snapshot; unrelated stage watermarks do
    // not invalidate their comparison. Mixed-stage comparisons are tested separately.
    expect(find(pack, "f:case-mix-shift:H2:caseMix=minor").reasons).toEqual([]);
  });
});

describe("variant comparison (synthetic deploy pipeline)", () => {
  it("compares variants only within a case-mix stratum against the largest variant", async () => {
    const pack = await run(DOMAINS.deploy, "variant-comparison");
    const review = find(
      pack,
      "f:variant-dwell-difference:H1:caseMix=minor,variantId=manual:review:manual",
    );
    expect(review.status).toBe("observed");
    expect(review.inference).toBe("observational-association");
    const rows = review.evidenceRefs.map((ref) => rowByRef(pack, ref));
    expect(new Set(rows.map((row) => row?.group.caseMix))).toEqual(new Set(["minor"]));
    // The last stage holds all open cases for one variant only: censoring differs, no claim.
    const rollout = find(
      pack,
      "f:variant-dwell-difference:H1:caseMix=minor,variantId=manual:rollout:manual",
    );
    expect(rollout.status).toBe("cannot_determine");
    expect(rollout.reasons).toContain("censoring-imbalance");
  });
});

describe("intervention review (synthetic hiring pipeline)", () => {
  it("reports dwell association and surfaces worsened independent outcomes as counterevidence", async () => {
    const pack = await run(DOMAINS.hiring, "intervention-review");
    const interview = find(pack, "f:cohort-dwell-difference:H1:caseMix=standard:interview");
    expect(interview.status).toBe("observed");
    expect(interview.measure?.value).toBeLessThan(0);
    expect(interview.inference).toBe("observational-association");
    const outcomes = find(pack, "f:outcome-share-difference:H2:caseMix=standard");
    expect(outcomes.status).toBe("observed");
    expect(outcomes.statement).toMatch(/failed share 0\.250 vs 0\.000/);
    expect(pack.hypotheses.find((item) => item.id === "H2")?.status).toBe("supported");
    expect(pack.safeguards.join(" ")).toMatch(/non-worsening independent outcomes/);
  });

  it("does not see counterevidence where outcomes held (deploy)", async () => {
    const pack = await run(DOMAINS.deploy, "intervention-review");
    expect(find(pack, "f:outcome-share-difference:H2:caseMix=minor").status).toBe("not_observed");
    expect(find(pack, "f:cohort-dwell-difference:H1:caseMix=minor:review").status).toBe("observed");
  });
});

describe("capacity risk and suppression (synthetic incident response)", () => {
  const incident = DOMAINS.incident;
  it("detects arrival growth against an equal-length baseline", async () => {
    const pack = await run(incident, "capacity-risk");
    const sev2 = find(pack, "f:arrival-change:H1:caseMix=sev2");
    expect(sev2.status).toBe("observed");
    expect(sev2.measure).toEqual({ name: "relativeChange", value: 1, unit: "ratio" });
  });

  it("never fabricates values for a suppressed small stratum", async () => {
    const pack = await run(incident, "bottleneck-triage", {
      cohort: { id: "control", caseMix: ["sev1", "sev2", "sev3"] },
    });
    const sev1 = pack.findings.filter((finding) => finding.stratum.caseMix === "sev1");
    expect(sev1.length).toBeGreaterThan(0);
    for (const finding of sev1) {
      expect(finding.status).toBe("cannot_determine");
      expect(finding.measure).toBeNull();
    }
    const suppressedRows = pack.evidence
      .flatMap((entry) => entry.rows)
      .filter((row) => row.group.caseMix === "sev1");
    for (const row of suppressedRows) {
      expect(row.sample?.sampleSize).toBeNull();
      expect(row.sample?.p50Ms).toBeNull();
    }
    expect(
      pack.missing.some((item) => item.reason === "suppressed" && item.stratum?.caseMix === "sev1"),
    ).toBe(true);
    // The determinable strata are still reported.
    expect(find(pack, "f:stage-median-rank:H1:caseMix=sev2").status).not.toBe("cannot_determine");
  });

  it("returns cannot_determine for every finding when the watermark is stale", async () => {
    const pack = await run(incident, "capacity-risk", {}, { watermark: RECORDED_AT });
    expect(pack.knowledge.stale).toBe(true);
    expect(pack.knowledge.lagMs).toBe(4 * 86_400_000);
    expect(pack.status).toBe("cannot_determine");
    for (const finding of pack.findings) {
      expect(finding.status).toBe("cannot_determine");
      expect(finding.reasons).toContain("stale-watermark");
      expect(finding.measure).toBeNull();
    }
    expect(
      pack.hypotheses
        .filter((item) => item.id !== "context")
        .every((item) => item.status === "cannot_determine"),
    ).toBe(true);
  });

  it("treats null/unknown aggregates and low coverage as missing, not zero", async () => {
    const pack = await run(
      incident,
      "process-health",
      {},
      {
        transform: (result) => {
          const value = structuredClone(result) as {
            metric: { kind: string };
            rows: {
              censoredCases: number | null;
              observedCases: number | null;
              p90Ms: number | null;
            }[];
            metadata: { coverage: { ratio: number | null } };
          };
          if (value.metric.kind === "case-counts")
            for (const row of value.rows) {
              row.censoredCases = null;
              row.observedCases = null;
            }
          if (value.metric.kind === "current-open-age")
            for (const row of value.rows) row.p90Ms = null;
          if (value.metric.kind === "outcomes")
            value.metadata.coverage = {
              ...value.metadata.coverage,
              eligibleCases: 96,
              coveredCases: 48,
              ratio: 0.5,
            } as never;
          return value;
        },
      },
    );
    for (const finding of pack.findings.filter((item) => item.kind === "open-share"))
      expect(finding.status).toBe("cannot_determine");
    for (const finding of pack.findings.filter((item) => item.kind === "open-age"))
      expect(finding.measure).toBeNull();
    for (const finding of pack.findings.filter((item) => item.kind === "terminal-outcome-share"))
      expect(finding.reasons).toContain("low-coverage");
  });
});
