import {
  type AppFreshness,
  type AppScope,
  type CaseSummary,
  type DwellGroup,
  type FunnelGroup,
  type Grant,
  type LifecycleReadSource,
  type Page,
  type Principal,
  type Sourced,
  SourceUnavailableError,
  type TimelineEntry,
  type VariantStats,
  type WorkflowDefinition,
} from "../source";

/**
 * Integration placeholder for the Workstream H lifecycle read API (FLIG-21, PR #36), reached over
 * a service binding. It FAILS CLOSED: until that API is on main and this adapter is implemented
 * and reviewed, every method rejects without making a request, so `read-api` mode serves nothing.
 *
 * Planned mapping, all GET with the caller's verified `Cf-Access-Jwt-Assertion` forwarded so the
 * read API re-checks the FLIG-18 grant itself. Responses use H's envelope
 * `{ app_id, as_of, data_freshness, cohort, sample_count, suppressed, data, page? }`; the adapter
 * must check `app_id` equals `scope.appId` and validate every field before returning it.
 */
export const PLANNED_ROUTES = {
  grantsFor: "GET /api/lifecycle/grants (not yet specified; FLIG-18 needs a caller-grants read)",
  listWorkflowDefinitions: "GET /api/apps/:app/lifecycle/processes",
  getWorkflowDefinition: "GET /api/apps/:app/lifecycle/processes?process=:key",
  getCaseSummary: "GET /api/apps/:app/lifecycle/cases/:id",
  getCaseTimeline: "GET /api/apps/:app/lifecycle/cases/:id (intervals)",
  getStageDwell: "GET /api/apps/:app/lifecycle/summaries/stages",
  getFunnel: "not in PR #36 yet: needs a stage-reach summary",
  getVariantStats: "not in PR #36 yet: needs a path-variant summary",
  getFreshness: "data_freshness of any envelope",
} as const satisfies Record<Exclude<keyof LifecycleReadSource, "kind">, string>;

export class ReadApiLifecycleSource implements LifecycleReadSource {
  readonly kind = "lifecycle-read-api" as const;

  /** `binding` is the service binding to the Flightdeck Worker; it is unused until integration. */
  constructor(readonly binding: Fetcher | undefined) {}

  private unavailable(): never {
    throw new SourceUnavailableError("The lifecycle read API adapter is not integrated yet");
  }

  async grantsFor(_principal: Principal): Promise<Grant[]> {
    this.unavailable();
  }
  async listWorkflowDefinitions(_scope: AppScope): Promise<Sourced<Page<WorkflowDefinition>>> {
    this.unavailable();
  }
  async getWorkflowDefinition(_scope: AppScope): Promise<Sourced<WorkflowDefinition | null>> {
    this.unavailable();
  }
  async getCaseSummary(_scope: AppScope): Promise<Sourced<CaseSummary | null>> {
    this.unavailable();
  }
  async getCaseTimeline(_scope: AppScope): Promise<Sourced<Page<TimelineEntry> | null>> {
    this.unavailable();
  }
  async getStageDwell(_scope: AppScope): Promise<Sourced<DwellGroup[]>> {
    this.unavailable();
  }
  async getFunnel(_scope: AppScope): Promise<Sourced<FunnelGroup[]>> {
    this.unavailable();
  }
  async getVariantStats(_scope: AppScope): Promise<Sourced<VariantStats>> {
    this.unavailable();
  }
  async getFreshness(_scope: AppScope): Promise<Sourced<AppFreshness>> {
    this.unavailable();
  }
}
