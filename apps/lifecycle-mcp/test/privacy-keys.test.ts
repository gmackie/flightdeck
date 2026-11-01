import { describe, expect, it } from "vitest";
import { projectCase, projectDefinition, projectTimeline, suppressDwell } from "../src/privacy";
import { inputs } from "../src/schemas";
import type { DwellGroup, TimelineEntry, WorkflowDefinition } from "../src/source";
import { SourceUnavailableError } from "../src/source";

const definition: WorkflowDefinition = {
  workflow_key: "delivery.deploy",
  version: 1,
  label: "Delivery",
  description: "",
  stages: ["build", "qa.review", "done"].map((key, order) => ({
    key,
    label: key,
    order,
    terminal: key === "done",
  })),
  outcomes: ["release.success"],
  dimensions: [{ key: "release.channel", label: "Channel", values: ["release.stable"] }],
  published_at: 1,
};
const dwell = (stage_key: string): DwellGroup => ({
  stage_key,
  group: null,
  n: 9,
  open_n: 0,
  p50_ms: 3000,
  p90_ms: 3000,
  mean_ms: 3000,
});
const entry = (stage_key: string): TimelineEntry => ({
  stage_key,
  attempt: 1,
  state: "completed",
  entered_at: 1000,
  exited_at: 4000,
});

describe("registered namespaced keys at the privacy boundary", () => {
  it("preserves dotted stages, outcomes and dimension codes without dropping their evidence", () => {
    const def = projectDefinition(definition);
    expect(def.stages.map((s) => s.key)).toEqual(["build", "qa.review", "done"]);
    expect(def.outcomes).toEqual(["release.success"]);
    expect(def.dimensions).toEqual(definition.dimensions);
    expect(suppressDwell([dwell("qa.review")], def, null, 5)).toEqual([
      { ...dwell("qa.review"), suppressed: false },
    ]);
    expect(projectTimeline([entry("qa.review")], def)).toEqual([entry("qa.review")]);
    expect(
      projectCase(
        {
          case_id: "deploy-1",
          workflow_key: def.workflow_key,
          version: 1,
          status: "closed",
          outcome: "release.success",
          current_stage: "qa.review",
          started_at: 0,
          ended_at: 5000,
          last_event_at: 5000,
          dimensions: { "release.channel": "release.stable" },
        },
        def,
      ),
    ).toMatchObject({
      outcome: "release.success",
      current_stage: "qa.review",
      dimensions: { "release.channel": "release.stable" },
    });
  });

  it.each([
    "../qa",
    "qa/review",
    "qa%2ereview",
    "qa?notes=secret",
    "qa@example.test",
    "qa\nreview",
    ".review",
  ])("rejects malformed definition keys: %s", (key) => {
    for (const def of [
      { ...definition, stages: [{ key, label: "Bad", order: 0, terminal: false }] },
      { ...definition, outcomes: [key] },
      { ...definition, dimensions: [{ key, label: "Channel", values: ["stable"] }] },
      { ...definition, dimensions: [{ key: "channel", label: "Channel", values: [key] }] },
    ])
      expect(() => projectDefinition(def)).toThrow(SourceUnavailableError);
  });

  it.each(["qa/untrusted", "qa.undeclared"])(
    "fails closed on unregistered stage evidence: %s",
    (key) => {
      const def = projectDefinition(definition);
      expect(() => projectTimeline([entry(key)], def)).toThrow(SourceUnavailableError);
      expect(() => suppressDwell([dwell(key)], def, null, 5)).toThrow(SourceUnavailableError);
    },
  );
  it("accepts only bounded namespaced query keys without widening app or case ids", () => {
    expect(
      inputs.get_funnel.safeParse({
        app_id: "app_deploy",
        workflow_key: "delivery.deploy",
        stages: ["build", "qa.review", "done"],
      }).success,
    ).toBe(true);
    expect(
      inputs.get_stage_dwell.safeParse({
        app_id: "app_deploy",
        workflow_key: "delivery.deploy",
        group_by: "release.channel",
        filters: [{ dimension: "release.channel", value: "release.stable" }],
      }).success,
    ).toBe(true);
    for (const key of ["qa/review", "../qa", "qa%2ereview", "qa?notes=secret", "qa@example.test"]) {
      expect(
        inputs.get_funnel.safeParse({
          app_id: "app_deploy",
          workflow_key: "delivery.deploy",
          stages: ["build", key],
        }).success,
      ).toBe(false);
      expect(
        inputs.get_stage_dwell.safeParse({
          app_id: "app_deploy",
          workflow_key: "delivery.deploy",
          group_by: key,
        }).success,
      ).toBe(false);
    }
    expect(inputs.list_workflow_definitions.safeParse({ app_id: "app.deploy" }).success).toBe(
      false,
    );
    expect(
      inputs.get_case_summary.safeParse({ app_id: "app_deploy", case_id: "case.deploy" }).success,
    ).toBe(false);
  });
});
