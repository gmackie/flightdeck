import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "../../src/app";
import { WorkflowsPage } from "../../src/pages/workflows";
import { navigate } from "../../src/router";
import { FakeWebSocket, mockApps } from "../helpers";

beforeEach(() => history.replaceState(null, "", "/workflows"));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("renders the marked DEMO route with no API requests or sockets", async () => {
  const fetcher = vi.fn(() => Promise.reject(new Error("No backend available")));
  vi.stubGlobal("fetch", fetcher);
  render(<App />);
  expect(screen.getByRole("heading", { name: "Workflows", level: 1 })).toBeInTheDocument();
  expect(screen.getByText("DEMO · SYNTHETIC")).toBeInTheDocument();
  expect(screen.getByRole("complementary", { name: "Demo data notice" })).toHaveTextContent(
    "does not show actual Cloudflare",
  );
  expect(screen.getByRole("link", { name: /^Workflows/ })).toHaveAttribute("aria-current", "page");
  expect(document.title).toBe("Workflows · Flightdeck");
  expect(fetcher).not.toHaveBeenCalled();
  expect(FakeWebSocket.instances).toHaveLength(0);
});

it("returns from the demo to live app loading and back", async () => {
  const user = userEvent.setup();
  const fetcher = mockApps(200);
  render(<App />);
  expect(fetcher).not.toHaveBeenCalled();
  await user.click(screen.getByRole("link", { name: /^Live/ }));
  await screen.findByText("What is happening in Alpha now");
  expect(fetcher).toHaveBeenCalled();
  await user.click(screen.getByRole("link", { name: /^Workflows/ }));
  expect(screen.getByRole("heading", { name: "Workflows" })).toBeInTheDocument();
});

it("renders a distinct loop and nested concurrent assessments without confusing application stages", async () => {
  render(<WorkflowsPage />);
  const application = screen.getByRole("toolbar", { name: "Application 001 lifecycle stages" });
  expect(within(application).getAllByRole("button")).toHaveLength(5);
  const loop = screen.getByRole("toolbar", { name: "Interview loop 001 lifecycle stages" });
  expect(within(loop).getAllByRole("button")).toHaveLength(7);
  for (const label of [
    "Defined",
    "Interviewers assigned",
    "Scheduled",
    "Conducted",
    "Feedback",
    "Debrief",
    "Decision",
  ]) {
    expect(
      within(loop).getByRole("button", { name: new RegExp(`^${label}:`) }),
    ).toBeInTheDocument();
  }
  for (const label of ["Systems exercise", "Collaboration exercise", "Craft exercise"]) {
    const row = screen.getByRole("treeitem", { name: `${label}, Assessment` });
    expect(row).toHaveAttribute("aria-level", "5");
    expect(within(row).getAllByRole("button")).toHaveLength(5);
    expect(within(row).getByText(/Parallel · panel/)).toBeInTheDocument();
  }
  expect(screen.getByRole("treeitem", { name: /Growth capacity · pending/ })).toHaveTextContent(
    "Waiting",
  );
  expect(screen.getByRole("treeitem", { name: /Next-cycle expansion/ })).toHaveTextContent(
    "Deferred",
  );
  expect(screen.getByRole("treeitem", { name: /Regional expansion/ })).toHaveTextContent(
    "Rejected",
  );
});

it("shows twelve compact jobs with dwell and outcomes, filters them, and handles no matches", async () => {
  const user = userEvent.setup();
  render(<WorkflowsPage />);
  await user.click(screen.getByRole("button", { name: "Many jobs" }));
  const list = screen.getByRole("list", { name: "Many jobs" });
  expect(within(list).getAllByRole("listitem")).toHaveLength(12);
  expect(within(list).getAllByText(/Completed dwell p50 .* p90/)).toHaveLength(12);
  expect(within(list).getAllByText(/Open-stage age p50 .* p90/)).toHaveLength(12);
  expect(screen.getByRole("region", { name: "Portfolio summary" })).toHaveTextContent(
    "p90 completed dwell",
  );
  expect(screen.getByRole("region", { name: "Portfolio summary" })).toHaveTextContent(
    "p90 open-stage age",
  );
  expect(screen.getByRole("region", { name: "Portfolio summary" })).toHaveTextContent(
    "right-censored ages",
  );
  expect(
    screen.getByRole("region", { name: "Workflow state and outcome counts" }),
  ).toHaveTextContent("Withdrawn");
  await user.type(screen.getByRole("searchbox", { name: "Search workflows" }), "Security");
  expect(within(list).getAllByRole("listitem")).toHaveLength(1);
  expect(within(list).getByText("REQ-108 · Security")).toBeInTheDocument();
  await user.clear(screen.getByRole("searchbox"));
  await user.type(screen.getByRole("searchbox"), "nonexistent");
  expect(screen.getByRole("status")).toHaveTextContent("No workflows match");
});

it("searches nested workflows while preserving and expanding ancestor context", async () => {
  const user = userEvent.setup();
  render(<WorkflowsPage />);
  await user.type(screen.getByRole("searchbox"), "Systems exercise");
  expect(screen.getAllByRole("treeitem")).toHaveLength(5);
  expect(
    screen.getByRole("treeitem", { name: "Interview loop 001, Interview loop" }),
  ).toHaveAttribute("aria-expanded", "true");
});

it("switches between all three domains without a backend and labels example services", async () => {
  const user = userEvent.setup();
  render(<WorkflowsPage />);
  await user.click(screen.getByRole("button", { name: "Service deploys" }));
  expect(screen.getByRole("button", { name: "Service deploys" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(screen.getByRole("tree", { name: "Service deploys" })).toHaveTextContent(
    "Example API · release 42",
  );
  expect(screen.getByRole("treeitem", { name: /Example region B/ })).toHaveTextContent("Paused");
  await user.click(screen.getByRole("button", { name: "Incidents" }));
  expect(screen.getByRole("tree", { name: "Incidents" })).toHaveTextContent(
    "Example latency regression",
  );
  expect(screen.getByRole("treeitem", { name: /Example duplicate alert/ })).toHaveTextContent(
    "Withdrawn",
  );
});

it("accepts an independent adapter instead of coupling generic UI to fixture domains", () => {
  const read = vi.fn(() => ({
    asOf: 0,
    source: { label: "Test fixture", synthetic: true },
    portfolios: [],
  }));
  render(<WorkflowsPage adapter={{ read }} />);
  expect(read).toHaveBeenCalled();
  expect(screen.getByRole("status")).toHaveTextContent("No workflows match");
  act(() => navigate("/workflows"));
});

it("surfaces invalid adapter timestamps and leaves durations unavailable", async () => {
  const user = userEvent.setup();
  render(
    <WorkflowsPage
      adapter={{
        read: () => ({
          asOf: 1000,
          source: { label: "Invalid timing fixture", synthetic: true },
          portfolios: [
            {
              id: "test",
              label: "Test",
              description: "Test",
              roots: [
                {
                  id: "test",
                  label: "Invalid record",
                  kind: "Test",
                  owner: "Test team",
                  state: "active",
                  createdAt: 0,
                  stages: [
                    {
                      id: "review",
                      label: "Review",
                      state: "active",
                      owner: "Test team",
                      enteredAt: 2000,
                    },
                  ],
                },
              ],
            },
          ],
        }),
      }}
    />,
  );
  const notice = screen.getByRole("complementary", { name: "Workflow timing diagnostics" });
  expect(notice).toHaveTextContent("1 invalid stage timing samples");
  await user.click(within(notice).getByText("Review timestamp problems"));
  expect(notice).toHaveTextContent("Entry is after the snapshot");
  const trigger = screen.getByRole("button", { name: "Review: Active, dwell —" });
  await user.click(trigger);
  expect(await screen.findByRole("tooltip")).toHaveTextContent("duration unavailable");
  expect(screen.getByRole("region", { name: "Portfolio summary" })).toHaveTextContent(
    "0 open stages",
  );
});
