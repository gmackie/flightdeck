import {
  type LifecycleReadRequest,
  type LifecycleReadRpc,
  ReadCase,
  ReadDefinition,
  ReadDwell,
  ReadFreshness,
  ReadGrants,
  ReadTimeline,
  readPage,
  readSourced,
} from "@flightdeckhq/schema";
import * as v from "valibot";
import {
  type AggregateQuery,
  type AppScope,
  type LifecycleReadSource,
  type PageRequest,
  type Principal,
  SourceForbiddenError,
  SourceUnavailableError,
} from "../source";

/** Implemented private RPC methods; retained name for source-method discovery. No HTTP fallback. */
export const PLANNED_ROUTES = {
  grantsFor: "RPC authenticated grantsFor",
  listWorkflowDefinitions: "RPC listWorkflowDefinitions",
  getWorkflowDefinition: "RPC getWorkflowDefinition",
  getCaseSummary: "RPC getCaseSummary",
  getCaseTimeline: "RPC getCaseTimeline (all-active histories only)",
  getStageDwell: "RPC getStageDwell (all-active, ungrouped cohorts only)",
  getFunnel: "unsupported",
  getVariantStats: "unsupported",
  getFreshness: "RPC getFreshness (projection time; event-time watermark unknown)",
} as const satisfies Record<Exclude<keyof LifecycleReadSource, "kind">, string>;

export class ReadApiLifecycleSource implements LifecycleReadSource {
  readonly kind = "lifecycle-read-api" as const;
  constructor(readonly binding: LifecycleReadRpc | undefined) {}

  private async request<S extends v.GenericSchema>(
    principal: Principal,
    appId: string | null,
    request: LifecycleReadRequest,
    schema: S,
  ): Promise<v.InferOutput<S>> {
    if (!principal.assertion || !this.binding || typeof this.binding.read !== "function")
      throw new SourceUnavailableError();
    try {
      // The assertion is forwarded UNCHANGED. No principal/role/capability is sent.
      const result = await this.binding.read(principal.assertion, appId, request);
      if (!result?.ok) {
        if (result?.code === "forbidden") throw new SourceForbiddenError();
        throw new SourceUnavailableError();
      }
      if (result.appId !== appId) throw new SourceUnavailableError();
      const parsed = v.safeParse(schema, result.value);
      if (!parsed.success) throw new SourceUnavailableError();
      return parsed.output;
    } catch (error) {
      if (error instanceof SourceForbiddenError) throw error;
      // Never surface backend messages, token contents, or binding exceptions.
      throw new SourceUnavailableError();
    }
  }

  grantsFor(principal: Principal) {
    return this.request(principal, null, { method: "grantsFor" }, ReadGrants);
  }
  listWorkflowDefinitions(scope: AppScope, q: { workflowKey: string | null; page: PageRequest }) {
    return this.request(
      scope.principal,
      scope.appId,
      { method: "listWorkflowDefinitions", workflowKey: q.workflowKey, ...q.page },
      readSourced(readPage(ReadDefinition)),
    );
  }
  getWorkflowDefinition(scope: AppScope, workflowKey: string, version: number | null) {
    return this.request(
      scope.principal,
      scope.appId,
      { method: "getWorkflowDefinition", workflowKey, version },
      readSourced(v.nullable(ReadDefinition)),
    );
  }
  getCaseSummary(scope: AppScope, caseId: string) {
    return this.request(
      scope.principal,
      scope.appId,
      { method: "getCaseSummary", caseId },
      readSourced(v.nullable(ReadCase)),
    );
  }
  getCaseTimeline(scope: AppScope, caseId: string, page: PageRequest) {
    return this.request(
      scope.principal,
      scope.appId,
      { method: "getCaseTimeline", caseId, ...page },
      readSourced(v.nullable(readPage(ReadTimeline))),
    );
  }
  getStageDwell(scope: AppScope, q: AggregateQuery) {
    return this.request(
      scope.principal,
      scope.appId,
      { method: "getStageDwell", ...q },
      readSourced(v.pipe(v.array(ReadDwell), v.maxLength(64))),
    );
  }
  async getFunnel(_scope: AppScope, _q: AggregateQuery & { stages: string[] }): Promise<never> {
    throw new SourceUnavailableError("Unsupported funnel source");
  }
  async getVariantStats(_scope: AppScope, _q: AggregateQuery & { limit: number }): Promise<never> {
    throw new SourceUnavailableError("Unsupported path variant source");
  }
  getFreshness(scope: AppScope) {
    return this.request(
      scope.principal,
      scope.appId,
      { method: "getFreshness" },
      readSourced(ReadFreshness),
    );
  }
}
