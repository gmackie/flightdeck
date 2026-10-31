import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveView } from "../src/live/model";
import { POLL_MS } from "../src/live/use-live";
import { LivePage } from "../src/pages/live";
import { APPS, emptyLive, FakeWebSocket, fetchedPaths, mockApps } from "./helpers";

vi.mock("../src/charts/timeseries", () => ({
  default: (props: { series: { name: string; points: [number, number][] }[] }) => (
    <div
      data-testid="chart"
      data-points={props.series.map((s) => s.points.reduce((n, [, v]) => n + v, 0)).join(",")}
    />
  ),
}));

const app = APPS[0] as (typeof APPS)[number];
const MIN = 60_000;

beforeEach(() => history.replaceState(null, "", "/live?app=app_alpha"));
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function withEvents(): LiveView {
  const view = emptyLive(app.id) as LiveView;
  const minute = Math.floor(Date.now() / MIN) * MIN;
  const [current] = view.hours;
  if (!current) throw new Error("no hour");
  current.totals = [
    { kind: "page", count: 12 },
    { kind: "click", count: 4 },
  ];
  current.counters = [
    { kind: "page", name: "/pricing", count: 8 },
    { kind: "click", name: "signup.cta", count: 4 },
    { kind: "page", name: "/", count: 4 },
  ];
  current.minutes = [{ minute: minute - 2 * MIN, count: 16 }];
  current.sessions = 5;
  return { ...view, active_sessions: 3 };
}

const liveRoute = (view: () => unknown) => (url: URL) =>
  url.pathname.endsWith("/live") ? { body: view() } : undefined;

describe("Live page", () => {
  it("shows a loader until the snapshot arrives", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
    );
    render(<LivePage app={app} />);
    expect(screen.getByLabelText("Loading live data")).toBeInTheDocument();
  });

  it("renders tiles, the minute chart and the top tables", async () => {
    mockApps(200, undefined, liveRoute(withEvents));
    render(<LivePage app={app} />);
    expect(await screen.findByText("/pricing")).toBeInTheDocument();
    expect(screen.getByText("signup.cta")).toBeInTheDocument();
    const tile = (label: string) => screen.getByText(label).closest(".fd-stat") as HTMLElement;
    expect(within(tile("Active sessions")).getByText("3")).toBeInTheDocument();
    expect(within(tile("Page views this hour")).getByText("12")).toBeInTheDocument();
    expect(within(tile("Events per minute")).getByText("3.2")).toBeInTheDocument();
    expect(await screen.findByTestId("chart")).toHaveAttribute("data-points", "16");
    expect(screen.queryByText("Waiting for the first event")).not.toBeInTheDocument();
  });

  it("waits for the first event, then lights up when it arrives over the socket", async () => {
    mockApps(200);
    render(<LivePage app={app} />);
    expect(await screen.findByText("Waiting for the first event")).toBeInTheDocument();
    const ws = FakeWebSocket.latest();
    expect(ws.url).toMatch(/^ws:\/\/[^/]+\/api\/apps\/app_alpha\/live\/ws$/);
    act(() => ws.open());
    expect(screen.getByRole("status")).toHaveTextContent("Live");
    act(() =>
      ws.receive({
        type: "delta",
        hour: new Date().toISOString().slice(0, 13),
        events: 1,
        counters: [{ kind: "page", name: "/welcome", count: 1 }],
        minutes: [{ minute: Math.floor(Date.now() / MIN) * MIN, count: 1 }],
        truncated: false,
        since: 0,
        seq: 1,
        sessions: 1,
        active: 1,
        at: Date.now(),
      }),
    );
    expect(await screen.findByText("/welcome")).toBeInTheDocument();
    expect(screen.queryByText("Waiting for the first event")).not.toBeInTheDocument();
  });

  it("refetches instead of double-counting a delta that overlaps the snapshot", async () => {
    let seq = 3;
    const fetcher = mockApps(
      200,
      undefined,
      liveRoute(() => {
        const view = withEvents();
        if (view.hours[0]) view.hours[0].seq = seq;
        return view;
      }),
    );
    render(<LivePage app={app} />);
    await screen.findByText("/pricing");
    const liveCalls = () => fetchedPaths(fetcher).filter((p) => p.endsWith("/live")).length;
    expect(liveCalls()).toBe(1);
    const ws = FakeWebSocket.latest();
    act(() => ws.open());
    const hour = new Date().toISOString().slice(0, 13);
    const overlap = {
      type: "delta",
      hour,
      events: 2,
      counters: [{ kind: "page", name: "/pricing", count: 2 }],
      minutes: [],
      truncated: false,
      since: 2,
      seq: 4,
      sessions: 5,
      active: 3,
      at: Date.now(),
    };
    seq = 4;
    act(() => ws.receive(overlap));
    await waitFor(() => expect(liveCalls()).toBe(2));
    // The refetched snapshot (seq 4) already has the delta; replaying it changes nothing.
    act(() => ws.receive(overlap));
    const row = (await screen.findByText("/pricing")).closest("tr") as HTMLElement;
    expect(within(row).getByText("8")).toBeInTheDocument();
    expect(liveCalls()).toBe(2);
  });

  it("shows the connection status and reconnects on demand", async () => {
    mockApps(200);
    render(<LivePage app={app} />);
    await screen.findByText("Waiting for the first event");
    act(() => FakeWebSocket.latest().serverClose(1006));
    expect(screen.getByRole("status")).toHaveTextContent("Reconnecting…");
    const button = screen.getByRole("button", { name: "Reconnect" });
    expect(button).toHaveAttribute("data-flightdeck", "live.reconnect");
    await userEvent.click(button);
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(screen.getByRole("status")).toHaveTextContent("Connecting…");
    act(() => FakeWebSocket.latest().open());
    expect(screen.queryByRole("button", { name: "Reconnect" })).not.toBeInTheDocument();
  });

  it("polls the snapshot while the socket is down", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetcher = mockApps(200);
    render(<LivePage app={app} />);
    await screen.findByText("Waiting for the first event");
    const liveCalls = () => fetchedPaths(fetcher).filter((p) => p.endsWith("/live")).length;
    expect(liveCalls()).toBe(1);
    act(() => FakeWebSocket.latest().serverClose(1006));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS);
    });
    await waitFor(() => expect(liveCalls()).toBeGreaterThanOrEqual(2));
  });

  it("explains errors", async () => {
    mockApps(200, undefined, (url) =>
      url.pathname.endsWith("/live") ? { status: 500, body: { error: "boom" } } : undefined,
    );
    render(<LivePage app={app} />);
    expect(await screen.findByText("Couldn't load live data")).toBeInTheDocument();
    expect(screen.getByText(/HTTP 500/)).toBeInTheDocument();
  });
});
