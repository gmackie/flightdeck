import {
  McpServer,
  ProtocolError,
  ProtocolErrorCode,
  ResourceNotFoundError,
  ResourceTemplate,
  type ToolAnnotations,
} from "@modelcontextprotocol/server";
import { LIMITS } from "./bounds";
import { METRICS, WORKFLOW_DEFINITION_SPEC } from "./glossary";
import { projectDefinition } from "./privacy";
import { inputs, outputs, type ToolName } from "./schemas";
import { SourceUnavailableError } from "./source";
import { definitionUri, runTool, SERVER_VERSION, type ToolContext } from "./tools";

/** Every tool only reads: no side effects, same answer for the same data, no outside world. */
export const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const INSTRUCTIONS = `Read-only lifecycle and workflow intelligence for Flightdeck apps you hold a grant for.
Results are observed process patterns over bounded cohorts, not causal conclusions: say "observed" and do not claim a stage or version caused an outcome.
Groups smaller than the minimum cohort are withheld; do not try to infer them. Check provenance.freshness and provenance.synthetic before relying on numbers.
There are no write, export, SQL or raw-event tools.`;

const DESCRIPTIONS: Record<ToolName, { title: string; description: string }> = {
  list_workflow_definitions: {
    title: "List workflow definitions",
    description:
      "List versioned workflow definitions (stages, outcomes, declared dimensions) for an app. Paginated.",
  },
  get_case_summary: {
    title: "Get case summary",
    description:
      "Status, current stage, outcome, timestamps and declared dimensions of one case by opaque id. No notes, people or free text.",
  },
  get_case_timeline: {
    title: "Get case timeline",
    description:
      "Stage intervals (stage, attempt, state, entered/exited, dwell) of one case in order. Paginated; no actors or notes.",
  },
  get_stage_dwell: {
    title: "Get stage dwell",
    description:
      "Observed time in each stage (p50, p90, mean) and open cases for a cohort, optionally by a declared dimension. Small groups are withheld.",
  },
  get_funnel: {
    title: "Get funnel",
    description:
      "Share of a cohort that reached each stage, and step-to-step conversion. Observational; small groups are withheld.",
  },
  compare_workflow_variants: {
    title: "Compare workflow variants",
    description:
      "Path variants of a workflow version with share and median cycle time; with candidate_version, compares two versions end to end. Observational, not causal.",
  },
  list_bottlenecks: {
    title: "List bottlenecks",
    description:
      "Stages ranked by an observed waiting signal (share of median path time, p90/p50 spread, open work). Where to look, not a diagnosis.",
  },
  describe_metric: {
    title: "Describe metric",
    description: "Definition, computation and caveats of a lifecycle metric.",
  },
  get_data_freshness: {
    title: "Get data freshness",
    description: "Watermark, lag and status of the lifecycle read model for an app, per workflow.",
  },
};

/** A fresh server per request (stateless), bound to one verified principal. */
export function createLifecycleServer(ctx: ToolContext): McpServer {
  const server = new McpServer(
    { name: "flightdeck-lifecycle", version: SERVER_VERSION },
    {
      // Static surface: no list-changed notifications, no subscriptions, no prompts, no tasks.
      capabilities: { tools: { listChanged: false }, resources: { listChanged: false } },
      instructions: INSTRUCTIONS,
      maxToolInputElements: LIMITS.maxToolInputElements,
    },
  );

  for (const name of Object.keys(DESCRIPTIONS) as ToolName[]) {
    server.registerTool(
      name,
      {
        ...DESCRIPTIONS[name],
        inputSchema: inputs[name],
        outputSchema: outputs[name],
        annotations: READ_ONLY,
      },
      // biome-ignore lint/suspicious/noExplicitAny: each schema/handler pair is typed in tools.ts.
      (args: any) => runTool(name, ctx, args),
    );
  }

  server.registerResource(
    "metric-glossary",
    "lifecycle://glossary/metrics",
    {
      title: "Lifecycle metric glossary",
      description: "Definitions, computations and caveats of every metric the tools return.",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(METRICS) }],
    }),
  );

  server.registerResource(
    "workflow-definition-spec",
    "lifecycle://spec/workflow-definition",
    {
      title: "Workflow definition spec and read contract",
      description:
        "The workflow definition format, case model, bounds, suppression and provenance.",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(WORKFLOW_DEFINITION_SPEC),
        },
      ],
    }),
  );

  server.registerResource(
    "workflow-definition",
    new ResourceTemplate("lifecycle://apps/{app_id}/workflows/{workflow_key}/definition", {
      list: async () => ({ resources: await listDefinitions(ctx) }),
    }),
    {
      title: "Workflow definition",
      description: "The latest version of one workflow definition of an app you hold a grant for.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const appId = String(variables.app_id ?? "");
      const workflowKey = String(variables.workflow_key ?? "");
      // Unknown apps, missing grants and unknown workflows look the same.
      const scope = await ctx.authorizer.authorize(appId, "lifecycle:read");
      if ("code" in scope) {
        if (scope.code === "source_unavailable") throw unavailable();
        throw new ResourceNotFoundError(uri.href, "Resource not found");
      }
      const res = await ctx.source
        .getWorkflowDefinition(scope, workflowKey, null)
        .catch((error) => {
          throw error instanceof SourceUnavailableError ? unavailable() : internal();
        });
      if (!res.data || res.data.workflow_key !== workflowKey) {
        throw new ResourceNotFoundError(uri.href, "Resource not found");
      }
      const def = projectDefinition(res.data);
      const body = {
        app_id: appId,
        definition: { ...def, published_at: new Date(def.published_at).toISOString() },
        synthetic: ctx.source.kind === "synthetic",
        as_of: new Date(res.meta.as_of).toISOString(),
      };
      return {
        contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(body) }],
      };
    },
  );

  return server;
}

const unavailable = () =>
  new ProtocolError(ProtocolErrorCode.InternalError, "The lifecycle read source is unavailable");
const internal = () => new ProtocolError(ProtocolErrorCode.InternalError, "Internal error");

/** One resource per workflow (latest version) of every app the caller may read. */
async function listDefinitions(ctx: ToolContext) {
  const resources = [];
  for (const appId of (await ctx.authorizer.appsWith("lifecycle:read")).slice(0, 20)) {
    const scope = await ctx.authorizer.authorize(appId, "lifecycle:read");
    if ("code" in scope) continue;
    const res = await ctx.source
      .listWorkflowDefinitions(scope, {
        workflowKey: null,
        page: { limit: LIMITS.maxPageSize, cursor: null },
      })
      .catch(() => null);
    const seen = new Set<string>();
    for (const def of res?.data.items ?? []) {
      if (seen.has(def.workflow_key) || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(def.workflow_key)) {
        continue;
      }
      seen.add(def.workflow_key);
      resources.push({
        uri: definitionUri(appId, def.workflow_key),
        name: `${appId}/${def.workflow_key}`,
        mimeType: "application/json",
      });
    }
  }
  return resources;
}
