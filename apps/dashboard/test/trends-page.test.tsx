import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TrendsPage } from "../src/pages/trends";
import { APPS, emptyTrends, fetchedPaths, mockApps } from "./helpers";

vi.mock("../src/charts/timeseries", () => ({
  default: (props: { series: { name: string; label?: string }[] }) => (
    <div data-testid="chart" data-series={props.series.map((s) => s.label ?? s.name).join(",")} />
  ),
}));

const app = APPS[0] as (typeof APPS)[number];
const HOUR = 3_600_000;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const withData = (url: URL) => ({
  ...emptyTrends(url),
  buckets: [0, 1, 2].map((i) => Date.UTC(2026, 9, 30, 12) + i * HOUR),
  series: [
    { name: "page", total: 9, counts: [2, 3, 4] },
    { name: "click", total: 3, counts: [1, 1, 1] },
    { name: "$other", total: 1, counts: [0, 0, 1] },
  ],
  totals: { events: 13, sessions: 6 },
});

const trendsRoute = (body: (url: URL) => unknown) => (url: URL) =>
  url.pathname.endsWith("/trends") ? { body: body(url) } : undefined;

const trendsCalls = (fetcher: ReturnType<typeof mockApps>) =>
  fetchedPaths(fetcher).filter((p) => p.includes("/trends"));

describe("Trends page", () => {
  it("shows a loader until the first view arrives", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
    );
    render(<TrendsPage app={app} />);
    expect(screen.getByLabelText("Loading trends")).toBeInTheDocument();
  });

  it("renders totals and the series chart, labelling the rest as Other", async () => {
    mockApps(200, undefined, trendsRoute(withData));
    render(<TrendsPage app={app} />);
    expect(await screen.findByTestId("chart")).toHaveAttribute("data-series", "page,click,Other");
    const tile = (label: string) => screen.getByText(label).closest(".fd-stat") as HTMLElement;
    expect(within(tile("Events")).getByText("13")).toBeInTheDocument();
    expect(within(tile("Sessions")).getByText("6")).toBeInTheDocument();
    expect(within(tile("Top kind")).getByText("page")).toBeInTheDocument();
  });

  it("shows an empty state for a range with no events", async () => {
    mockApps(200);
    render(<TrendsPage app={app} />);
    expect(await screen.findByText("No events in this range")).toBeInTheDocument();
  });

  it("refetches when the range or breakdown changes", async () => {
    const fetcher = mockApps(200, undefined, trendsRoute(withData));
    render(<TrendsPage app={app} />);
    await screen.findByTestId("chart");
    expect(trendsCalls(fetcher)).toEqual(["/api/apps/app_alpha/trends?range=24h&breakdown=kind"]);

    const week = screen.getByRole("button", { name: "7d" });
    expect(week).toHaveAttribute("data-flightdeck", "trends.range");
    await userEvent.click(week);
    await waitFor(() =>
      expect(trendsCalls(fetcher).at(-1)).toBe(
        "/api/apps/app_alpha/trends?range=7d&breakdown=kind",
      ),
    );
    expect(week).toHaveAttribute("aria-pressed", "true");

    const page = screen.getByRole("button", { name: "Page" });
    expect(page).toHaveAttribute("data-flightdeck", "trends.breakdown");
    expect(page).toHaveAttribute("data-flightdeck-breakdown", "page");
    await userEvent.click(page);
    await waitFor(() =>
      expect(trendsCalls(fetcher).at(-1)).toBe(
        "/api/apps/app_alpha/trends?range=7d&breakdown=page",
      ),
    );
    // Re-selecting the active option does not refetch.
    await userEvent.click(page);
    expect(trendsCalls(fetcher)).toHaveLength(3);
  });

  it("explains errors", async () => {
    mockApps(200, undefined, (url) =>
      url.pathname.endsWith("/trends")
        ? { status: 404, body: { error: "Unknown app" } }
        : undefined,
    );
    render(<TrendsPage app={app} />);
    expect(await screen.findByText("Couldn't load trends")).toBeInTheDocument();
    expect(screen.getByText("This app is no longer registered.")).toBeInTheDocument();
  });
});
