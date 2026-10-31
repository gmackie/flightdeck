import { Banner } from "@cloudflare/kumo/components/banner";
import { Button, LinkButton } from "@cloudflare/kumo/components/button";
import { Empty } from "@cloudflare/kumo/components/empty";
import { Loader } from "@cloudflare/kumo/components/loader";
import { Surface } from "@cloudflare/kumo/components/surface";
import {
  DatabaseIcon,
  LockKeyIcon,
  PathIcon,
  SignInIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import { type ReactNode, useState } from "react";
import type { App } from "../api";
import { workflowsDemoHref } from "../router";
import { diagnoseWorkflowSnapshot } from "../workflows/adapter";
import { TimingDiagnostics } from "../workflows/diagnostics";
import { StateBadge } from "../workflows/lifecycle-bar";
import { LifecycleTree } from "../workflows/lifecycle-tree";
import type { DataFreshness } from "../workflows/live-adapter";
import {
  duration,
  filterHierarchy,
  flattenNodes,
  LIFECYCLE_STATES,
  type WorkflowSnapshot,
} from "../workflows/model";
import { PortfolioSummary } from "../workflows/portfolio";
import {
  type LiveProcess,
  type LiveWorkflows,
  useLiveWorkflows,
} from "../workflows/use-live-workflows";
import "../workflows/workflows.css";
import { PageHeader } from "./page-header";

const utc = (ms: number) => `${new Date(ms).toISOString().replace("T", " ").slice(0, 16)} UTC`;

/** Lag below a minute matters for a live view, so show seconds there. */
function lag(ms: number | null): string {
  if (ms === null) return "—";
  return ms < 60_000 ? `${Math.round(ms / 1000)}s` : duration(ms);
}

const FRESHNESS_LABELS: Record<DataFreshness["status"], string> = {
  fresh: "Fresh",
  stale: "Stale",
  unavailable: "Unavailable",
};

export function FreshnessPanel({
  freshness,
  asOf,
}: {
  freshness: DataFreshness;
  asOf: number | null;
}) {
  return (
    <section
      className="wf-freshness"
      data-status={freshness.status}
      aria-label="Data freshness"
      data-flightdeck="workflows.freshness"
    >
      <strong>{FRESHNESS_LABELS[freshness.status]}</strong>
      <dl>
        <div>
          <dt>As of</dt>
          <dd>{asOf === null ? "—" : utc(asOf)}</dd>
        </div>
        <div>
          <dt>Lag</dt>
          <dd>{lag(freshness.lag_ms)}</dd>
        </div>
        {freshness.pending_cases !== undefined ? (
          <div>
            <dt>Pending cases</dt>
            <dd>{freshness.pending_cases}</dd>
          </div>
        ) : null}
        <div>
          <dt>Projection</dt>
          <dd>{freshness.projection}</dd>
        </div>
        <div>
          <dt>Generation</dt>
          <dd>{freshness.generation ?? "—"}</dd>
        </div>
      </dl>
    </section>
  );
}

/** Aggregates need their own capability; a denial degrades this panel only. */
export function OutcomeSummary({ outcomes }: { outcomes: LiveProcess["outcomes"] }) {
  let body: ReactNode;
  if (outcomes.status === "forbidden") {
    body = (
      <p className="wf-muted" role="status">
        You don't have access to aggregate outcome summaries for this app. Case lifecycles below are
        unaffected.
      </p>
    );
  } else if (outcomes.status !== "ok") {
    body = (
      <p className="wf-muted" role="status">
        Outcome summary unavailable:{" "}
        {outcomes.status === "error"
          ? outcomes.message
          : outcomes.status === "signed-out"
            ? "your session has ended."
            : "not found."}
      </p>
    );
  } else {
    const { data: groups, suppressed } = outcomes.data;
    body = (
      <>
        {groups.length ? (
          <table className="wf-outcome-table">
            <thead>
              <tr>
                <th scope="col">Outcome</th>
                <th scope="col">Cases</th>
                <th scope="col">p50 duration</th>
                <th scope="col">p90 duration</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((group) => (
                <tr key={`${group.status}:${group.outcome}`}>
                  <th scope="row">
                    {group.status === "open" ? "Open" : (group.outcome ?? "No outcome")}
                  </th>
                  <td>{group.case_count}</td>
                  <td>{duration(group.duration_ms.p50 ?? undefined)}</td>
                  <td>{duration(group.duration_ms.p90 ?? undefined)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="wf-muted">No outcome groups large enough to report.</p>
        )}
        <p className="wf-summary-note">
          Cases started in the last 30 days.
          {suppressed ? " Groups below the minimum cohort size are withheld." : ""}
        </p>
      </>
    );
  }
  return (
    <section className="wf-outcome-summary" aria-label="Outcome summary">
      <h3>Outcome summary</h3>
      {body}
    </section>
  );
}

function ProcessCard({
  process,
  snapshot,
  query,
}: {
  process: LiveProcess;
  snapshot: WorkflowSnapshot;
  query: string;
}) {
  const portfolio = snapshot.portfolios.find((item) => item.id === process.id);
  const nodes = filterHierarchy(portfolio?.roots ?? [], query);
  const label = portfolio?.label ?? process.process.label;
  return (
    <Surface className="fd-card wf-card">
      <div className="wf-section-header">
        <div>
          <h2>{label}</h2>
          <p>
            {portfolio?.description}
            {process.truncated ? " · older cases not shown" : ""}
          </p>
        </div>
      </div>
      {process.unavailableCases ? (
        <p className="wf-muted wf-inset" role="status">
          {process.unavailableCases} listed cases could not be loaded and are not shown.
        </p>
      ) : null}
      <PortfolioSummary nodes={nodes} asOf={snapshot.asOf} />
      <OutcomeSummary outcomes={process.outcomes} />
      <section className="wf-legend" aria-label="Lifecycle state legend">
        {LIFECYCLE_STATES.map((state) => (
          <StateBadge key={state} state={state} />
        ))}
      </section>
      <LifecycleTree
        key={`${process.id}:${query}`}
        nodes={nodes}
        asOf={snapshot.asOf}
        label={label}
        initialExpanded={flattenNodes(nodes).map((node) => node.id)}
      />
      <p className="wf-footnote">
        Each row is one case; nested rows are child cases. Equal-width segments show stage order;
        labels show dwell from recorded timestamps. Ongoing dwell is measured up to the read model's
        as-of time. Owners are not recorded.
      </p>
    </Surface>
  );
}

function LiveWorkflowsView({ data }: { data: LiveWorkflows }) {
  const { snapshot, processes } = data;
  const [selected, setSelected] = useState(processes[0]?.id ?? "");
  const [query, setQuery] = useState("");
  const process = processes.find((item) => item.id === selected) ?? processes[0];
  let body: ReactNode;
  if (snapshot === null) {
    body = (
      <Surface className="fd-card fd-centered">
        <Empty
          icon={<DatabaseIcon size={40} />}
          title="The lifecycle read model has not been projected yet"
          description="Case lifecycles appear here once lifecycle events for this app have been projected."
        />
      </Surface>
    );
  } else if (!process) {
    body = (
      <Surface className="fd-card fd-centered">
        <Empty
          icon={<PathIcon size={40} />}
          title="No lifecycle processes yet"
          description="This app has not defined any lifecycle processes."
        />
      </Surface>
    );
  } else {
    body = (
      <>
        <TimingDiagnostics diagnostics={diagnoseWorkflowSnapshot(snapshot)} />
        <div className="wf-controls">
          <fieldset className="fd-segmented" aria-label="Lifecycle process">
            {processes.map((item) => (
              <Button
                key={item.id}
                size="sm"
                variant={item.id === process.id ? "primary" : "ghost"}
                aria-pressed={item.id === process.id}
                onClick={() => {
                  setSelected(item.id);
                  setQuery("");
                }}
              >
                {item.process.label} · v{item.process.version}
              </Button>
            ))}
          </fieldset>
          <label className="wf-search">
            Search cases
            <input
              type="search"
              value={query}
              placeholder="Id, state, outcome…"
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
        </div>
        <ProcessCard process={process} snapshot={snapshot} query={query} />
      </>
    );
  }
  return (
    <>
      <FreshnessPanel freshness={data.freshness} asOf={data.asOf} />
      {body}
    </>
  );
}

/** The default Workflows view: the selected app's lifecycle read model, never demo data. */
export function LiveWorkflowsPage({ app, fetcher }: { app: App; fetcher?: typeof fetch }) {
  const [state, reload] = useLiveWorkflows(app.id, fetcher);
  let body: ReactNode;
  if (state.status === "loading") {
    body = (
      <Surface className="fd-card fd-centered">
        <Loader size="lg" aria-label="Loading workflows" />
      </Surface>
    );
  } else if (state.status === "ok") {
    body = <LiveWorkflowsView key={app.id} data={state.data} />;
  } else if (state.status === "forbidden") {
    body = (
      <Surface className="fd-card fd-centered">
        <Empty
          icon={<LockKeyIcon size={40} />}
          title="You don't have lifecycle read access to this app"
          description="You are signed in, but your account can't read this app's workflows. Ask an administrator for access."
        />
      </Surface>
    );
  } else if (state.status === "signed-out") {
    body = (
      <Surface className="fd-card fd-centered">
        <Empty
          icon={<SignInIcon size={40} />}
          title="You are signed out"
          description="Your Cloudflare Access session has ended. Sign in again to see workflows."
          contents={
            <Button variant="primary" onClick={() => location.reload()}>
              Sign in
            </Button>
          }
        />
      </Surface>
    );
  } else {
    body = (
      <Banner
        variant="error"
        icon={<WarningCircleIcon weight="fill" />}
        title="Couldn't load workflows"
        description={
          state.status === "not-found"
            ? "Lifecycle data isn't available for this app. It may no longer be registered."
            : state.message
        }
        action={
          <Button size="sm" data-flightdeck="workflows.retry" onClick={reload}>
            Try again
          </Button>
        }
      />
    );
  }
  return (
    <div className="wf-page">
      <PageHeader
        title="Workflows"
        subtitle={`Case lifecycles for ${app.name}`}
        actions={
          <>
            <Button
              size="sm"
              variant="secondary"
              data-flightdeck="workflows.refresh"
              disabled={state.status === "loading"}
              onClick={reload}
            >
              Refresh
            </Button>
            <LinkButton
              size="sm"
              variant="ghost"
              href={workflowsDemoHref(app.id)}
              data-flightdeck="workflows.demo"
            >
              View synthetic demo
            </LinkButton>
          </>
        }
      />
      {body}
    </div>
  );
}
