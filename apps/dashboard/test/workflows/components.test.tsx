import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { LifecycleBar } from "../../src/workflows/lifecycle-bar";
import { LifecycleTree } from "../../src/workflows/lifecycle-tree";
import type { LifecycleNode, LifecycleStage } from "../../src/workflows/model";

const stages: LifecycleStage[] = [
  {
    id: "defined",
    label: "Defined",
    state: "completed",
    owner: "Planning",
    enteredAt: 0,
    exitedAt: 60_000,
  },
  {
    id: "review",
    label: "Review",
    state: "waiting",
    owner: "Review panel",
    enteredAt: 60_000,
    reason: "Awaiting budget",
  },
  { id: "finish", label: "Finish", state: "future", owner: "Delivery" },
];
const parent: LifecycleNode = {
  id: "parent",
  label: "Parent demand",
  kind: "Demand",
  state: "active",
  owner: "Planning",
  createdAt: 0,
  stages,
  children: [
    {
      id: "child",
      label: "Independent work",
      kind: "Task",
      state: "rejected",
      owner: "Delivery",
      createdAt: 0,
      stages: [
        {
          id: "closed",
          label: "Defined",
          state: "rejected",
          owner: "Delivery",
          enteredAt: 0,
          exitedAt: 60_000,
        },
      ],
    },
  ],
};

it("moves between stage buttons with arrows, Home and End and keeps a single tab stop", async () => {
  const user = userEvent.setup();
  render(<LifecycleBar label="Example" stages={stages} asOf={180_000} />);
  const bar = screen.getByRole("toolbar", { name: "Example lifecycle stages" });
  const buttons = within(bar).getAllByRole("button");
  await user.tab();
  expect(buttons[0]).toHaveFocus();
  await user.keyboard("{ArrowRight}");
  expect(buttons[1]).toHaveFocus();
  expect(buttons.filter((button) => button.tabIndex === 0)).toEqual([buttons[1]]);
  await user.keyboard("{End}");
  expect(buttons[2]).toHaveFocus();
  await user.keyboard("{ArrowRight}");
  expect(buttons[0]).toHaveFocus();
  await user.keyboard("{ArrowLeft}");
  expect(buttons[2]).toHaveFocus();
  await user.keyboard("{Home}");
  expect(buttons[0]).toHaveFocus();
});

it("shows full dwell, owner, state, reason and age details on keyboard focus; Escape dismisses", async () => {
  const user = userEvent.setup();
  render(<LifecycleBar label="Example" stages={stages} asOf={180_000} />);
  await user.tab();
  await user.keyboard("{ArrowRight}");
  const tooltip = await screen.findByRole("tooltip");
  expect(tooltip).toHaveTextContent("Review");
  for (const text of [
    "State",
    "Waiting",
    "Dwell",
    "2m · ongoing",
    "Owner",
    "Review panel",
    "Age since entry",
    "Reason",
    "Awaiting budget",
  ]) {
    expect(tooltip).toHaveTextContent(text);
  }
  const trigger = screen.getByRole("button", { name: /^Review:/ });
  expect(trigger).toHaveAttribute("aria-describedby", tooltip.id);
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("tooltip")).not.toBeInTheDocument());
  expect(trigger).toHaveFocus();
});

it("opens details on hover and click, and distinguishes unentered stages", async () => {
  const user = userEvent.setup();
  render(<LifecycleBar label="Example" stages={stages} asOf={180_000} />);
  const finish = screen.getByRole("button", { name: /^Finish:/ });
  await user.hover(finish);
  expect(await screen.findByRole("tooltip")).toHaveTextContent("Not entered yet");
  await user.unhover(finish);
  await waitFor(() => expect(screen.queryByRole("tooltip")).not.toBeInTheDocument());
  await user.click(finish);
  expect(await screen.findByRole("tooltip")).toHaveTextContent("Future");
});

describe("expandable hierarchy", () => {
  it("implements tree arrow navigation, parent focus, Home/End, Enter/Space and visible-row focus", async () => {
    const user = userEvent.setup();
    render(<LifecycleTree label="Example tree" nodes={[parent]} asOf={180_000} />);
    const root = screen.getByRole("treeitem", { name: "Parent demand, Demand" });
    expect(root).toHaveAttribute("aria-expanded", "false");
    act(() => root.focus());
    await user.keyboard("{ArrowRight}");
    expect(root).toHaveAttribute("aria-expanded", "true");
    const child = screen.getByRole("treeitem", { name: "Independent work, Task" });
    expect(child).toHaveAttribute("aria-level", "2");
    await user.keyboard("{ArrowRight}");
    expect(child).toHaveFocus();
    await user.keyboard("{ArrowLeft}");
    expect(root).toHaveFocus();
    await user.keyboard("{End}");
    expect(child).toHaveFocus();
    await user.keyboard("{Home}{ArrowDown}");
    expect(child).toHaveFocus();
    await user.keyboard("{ArrowUp}{Enter}");
    expect(root).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("treeitem", { name: /Independent work/ })).not.toBeInTheDocument();
    await user.keyboard(" ");
    expect(root).toHaveAttribute("aria-expanded", "true");
  });

  it("does not infer parent stages/state from a rejected child and supports disclosure controls", async () => {
    const user = userEvent.setup();
    render(<LifecycleTree label="Example tree" nodes={[parent]} asOf={180_000} />);
    await user.click(screen.getByRole("button", { name: "Expand Parent demand" }));
    expect(screen.getByRole("button", { name: "Collapse Parent demand" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    const parentBar = screen.getByRole("toolbar", { name: "Parent demand lifecycle stages" });
    expect(within(parentBar).getByRole("button", { name: /^Review: Waiting/ })).toHaveAttribute(
      "data-state",
      "waiting",
    );
    const childBar = screen.getByRole("toolbar", { name: "Independent work lifecycle stages" });
    expect(within(childBar).getByRole("button", { name: /^Defined: Rejected/ })).toHaveAttribute(
      "data-state",
      "rejected",
    );
    expect(
      screen
        .getByRole("treeitem", { name: "Parent demand, Demand" })
        .querySelector(".wf-row > .wf-state"),
    ).toHaveTextContent("Active");
    await user.click(screen.getByRole("button", { name: "Collapse all" }));
    expect(screen.queryByRole("treeitem", { name: /Independent work/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Expand all" }));
    expect(screen.getByRole("treeitem", { name: /Independent work/ })).toBeInTheDocument();
  });

  it("handles empty stages and an empty hierarchy", () => {
    render(<LifecycleBar label="Empty" stages={[]} asOf={0} />);
    expect(screen.getByText("No stages defined")).toBeInTheDocument();
    render(<LifecycleTree label="Empty tree" nodes={[]} asOf={0} />);
    expect(screen.getByRole("status")).toHaveTextContent("No workflows match this search.");
  });
});
