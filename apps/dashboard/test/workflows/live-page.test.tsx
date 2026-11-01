import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../../src/app";
import { LiveWorkflowsPage } from "../../src/pages/workflows-live";
import { APPS, mockApps } from "../helpers";
import {
  AS_OF,
  detail,
  envelope,
  HOUR,
  lifecycleFetcher,
  lifecycleRoute,
  summary,
} from "./lifecycle-api";

const app = APPS[0] as (typeof APPS)[number];

beforeEach(() => history.replaceState(null, "", "/workflows?app=app_alpha"));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Nothing from the synthetic demo may appear in live mode. */
function expectNoDemoContent() {
  expect(screen.queryByText("DEMO · SYNTHETIC")).not.toBeInTheDocument();
  expect(screen.queryByRole("complementary", { name: "Demo data notice" })).not.toBeInTheDocument();
  expect(screen.queryByText(/Invented examples/)).not.toBeInTheDocument();
  for (const fixture of [/Application 001/, /Interview loop/, /Example API/, /REQ-1\d\d/])
    expect(screen.queryByText(fixture)).not.toBeInTheDocument();
}

describe("live Workflows page", () => {
  it("shows a loader, not demo data, while loading", () => {
    render(<LiveWorkflowsPage app={app} fetcher={vi.fn(() => new Promise<Response>(() => {}))} />);
    expect(screen.getByLabelText("Loading workflows")).toBeInTheDocument();
    expectNoDemoContent();
  });

  it("renders an explicit access error on 403, with no demo or synthetic content", async () => {
    render(
      <LiveWorkflowsPage app={app} fetcher={lifecycleFetcher({ processes: { status: 403 } })} />,
    );
    expect(
      await screen.findByText("You don't have lifecycle read access to this app"),
    ).toBeInTheDocument();
    expectNoDemoContent();
    expect(screen.queryByRole("tree")).not.toBeInTheDocument();
  });

  it("explains signed-out, missing and unavailable read models", async () => {
    const { unmount } = render(
      <LiveWorkflowsPage app={app} fetcher={lifecycleFetcher({ processes: { status: 401 } })} />,
    );
    expect(await screen.findByText("You are signed out")).toBeInTheDocument();
    unmount();
    const missing = render(
      <LiveWorkflowsPage app={app} fetcher={lifecycleFetcher({ processes: { status: 404 } })} />,
    );
    expect(await screen.findByText(/Lifecycle data isn't available/)).toBeInTheDocument();
    missing.unmount();
    render(
      <LiveWorkflowsPage
        app={app}
        fetcher={lifecycleFetcher({ processes: { status: 503, body: { error: "x" } } })}
      />,
    );
    expect(await screen.findByText("Couldn't load workflows")).toBeInTheDocument();
    expect(screen.getByText(/HTTP 503/)).toBeInTheDocument();
    expectNoDemoContent();
  });

  it("says the read model has not been projected yet when freshness is unavailable", async () => {
    const unavailable = {
      status: "unavailable",
      projection: "empty",
      lag_ms: null,
      generation: null,
      source_watermark: null,
    };
    render(
      <LiveWorkflowsPage
        app={app}
        fetcher={lifecycleFetcher({
          processes: { body: envelope([], { as_of: null, data_freshness: unavailable }) },
        })}
      />,
    );
    expect(await screen.findByText(/has not been projected yet/)).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Data freshness" })).toHaveTextContent("Unavailable");
    expectNoDemoContent();
  });

  it("renders freshness, the stage bar with real dwell, per-case outcome and outcome summary", async () => {
    const user = userEvent.setup();
    render(<LiveWorkflowsPage app={app} fetcher={lifecycleFetcher()} />);
    const freshness = await screen.findByRole("region", { name: "Data freshness" });
    expect(freshness).toHaveTextContent("Fresh");
    expect(freshness).toHaveTextContent("2026-10-31 12:00 UTC");
    expect(freshness).toHaveTextContent("Lag42s");
    expect(freshness).toHaveTextContent("Pending cases2");
    expect(freshness).toHaveTextContent("Projectionready");

    const parent = screen.getByRole("toolbar", { name: "Hiring · …AAAA1111 lifecycle stages" });
    expect(within(parent).getAllByRole("button")).toHaveLength(4);
    expect(within(parent).getByRole("button", { name: "Applied: Completed, dwell 8h 0m" }));
    expect(within(parent).getByRole("button", { name: "Screen: Active, dwell 2h 0m" }));
    expect(within(parent).getByRole("button", { name: "Offer: Future, dwell —" }));

    const child = screen.getByRole("treeitem", { name: "Hiring · …BBBB2222, Hiring" });
    expect(child).toHaveAttribute("aria-level", "2");
    expect(child).toHaveTextContent("outcome rejected");
    expect(child).toHaveTextContent("Rejected");

    const outcomes = screen.getByRole("region", { name: "Outcome summary" });
    expect(within(outcomes).getByRole("rowheader", { name: "hired" })).toBeInTheDocument();
    expect(within(outcomes).getByRole("row", { name: /hired 7 2d 0h 3d 0h/ })).toBeInTheDocument();
    expect(within(outcomes).getByRole("rowheader", { name: "Open" })).toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: "Workflow timing diagnostics" })).toBeNull();
    expectNoDemoContent();

    await user.type(screen.getByRole("searchbox", { name: "Search cases" }), "rejected");
    expect(screen.getAllByRole("treeitem")).toHaveLength(2);
  });

  it("degrades only the outcome summary when aggregates are forbidden", async () => {
    render(
      <LiveWorkflowsPage app={app} fetcher={lifecycleFetcher({ outcomes: { status: 403 } })} />,
    );
    const outcomes = await screen.findByRole("region", { name: "Outcome summary" });
    expect(outcomes).toHaveTextContent("You don't have access to aggregate outcome summaries");
    expect(within(outcomes).queryByRole("table")).toBeNull();
    expect(
      screen.getByRole("toolbar", { name: "Hiring · …AAAA1111 lifecycle stages" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Data freshness" })).toHaveTextContent("Fresh");
    expect(screen.queryByText("You don't have lifecycle read access to this app")).toBeNull();
  });

  it("surfaces invalid live timings instead of clamping them", async () => {
    const bad = detail(summary({ case_id: "case_badtiming01" }), [
      { stage_key: "applied", entered_at: AS_OF - HOUR, exited_at: AS_OF - 2 * HOUR },
    ]);
    render(<LiveWorkflowsPage app={app} fetcher={lifecycleFetcher({}, [bad])} />);
    const notice = await screen.findByRole("complementary", {
      name: "Workflow timing diagnostics",
    });
    expect(notice).toHaveTextContent("1 invalid stage timing samples");
    expect(notice).toHaveTextContent("Exit is before entry");
    expect(screen.getByRole("button", { name: "Applied: Completed, dwell —" })).toBeInTheDocument();
  });
});

describe("Workflows routing", () => {
  it("defaults to live data for the selected app and reaches the demo only explicitly", async () => {
    const user = userEvent.setup();
    history.replaceState(null, "", "/workflows");
    mockApps(200, undefined, lifecycleRoute());
    render(<App />);
    await screen.findByRole("region", { name: "Data freshness" });
    expect(location.pathname + location.search).toBe("/workflows?app=app_alpha");
    expect(screen.getByRole("combobox", { name: "Select app" })).toBeInTheDocument();
    expectNoDemoContent();

    await user.click(screen.getByRole("link", { name: "View synthetic demo" }));
    expect(location.pathname + location.search).toBe("/workflows?view=demo&app=app_alpha");
    expect(screen.getByText("DEMO · SYNTHETIC")).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "Demo data notice" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Data freshness" })).toBeNull();

    await user.click(screen.getByRole("link", { name: "Back to live data" }));
    expect(location.pathname + location.search).toBe("/workflows?app=app_alpha");
    await screen.findByRole("region", { name: "Data freshness" });
    expectNoDemoContent();
  });

  it("shows the access error in the app shell on a lifecycle 403", async () => {
    mockApps(200, undefined, lifecycleRoute({ processes: { status: 403 } }));
    render(<App />);
    expect(
      await screen.findByText("You don't have lifecycle read access to this app"),
    ).toBeInTheDocument();
    expectNoDemoContent();
  });
});
