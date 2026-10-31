import { _reset } from "@flightdeckhq/browser";
import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { boot } from "../src/boot";
import { mockApps } from "./helpers";

type Sent = { url: string; events: { kind: string; name: string; props?: object }[] };
const beacons: Sent[] = [];
let root: Root | undefined;

beforeEach(() => {
  beacons.length = 0;
  history.replaceState(null, "", "/");
  Object.defineProperty(navigator, "sendBeacon", {
    configurable: true,
    value: (url: string, blob: Blob) => {
      void blob.text().then((t) => beacons.push({ url, ...JSON.parse(t) }));
      return true;
    },
  });
  mockApps(200);
});
afterEach(() => {
  act(() => root?.unmount());
  _reset();
  vi.unstubAllGlobals();
});

/** Tears down the SDK, which flushes its queue, and returns everything it sent. */
async function sent() {
  _reset();
  await new Promise((r) => setTimeout(r, 0));
  return beacons;
}

async function start() {
  const container = document.body.appendChild(document.createElement("div"));
  await act(async () => {
    root = boot(container);
  });
  await screen.findByText("What is happening in Alpha now");
}

it("posts the dashboard's events to the same-origin /_fd/e", async () => {
  await start();
  const batches = await sent();
  expect(batches.map((b) => b.url)).toEqual(["/_fd/e"]);
  expect(batches[0]?.events[0]).toMatchObject({ kind: "page", name: "/" });
});

it("records clicks on data-flightdeck elements under their names", async () => {
  await start();
  const nav = within(screen.getByRole("navigation", { name: "Primary" }));
  await userEvent.click(nav.getByRole("link", { name: /^Trends/ }));
  await userEvent.click(screen.getByRole("button", { name: "7d" }));
  const events = (await sent()).flatMap((b) => b.events);
  expect(events).toContainEqual(expect.objectContaining({ kind: "click", name: "nav.trends" }));
  expect(events).toContainEqual(
    expect.objectContaining({ kind: "click", name: "trends.range", props: { range: "7d" } }),
  );
  // The SPA navigation itself is a page view.
  expect(events).toContainEqual(expect.objectContaining({ kind: "page", name: "/trends" }));
});

it("tracks app switches", async () => {
  await start();
  await userEvent.click(screen.getByRole("combobox", { name: "Select app" }));
  await userEvent.click(await screen.findByRole("option", { name: "Beta" }));
  const events = (await sent()).flatMap((b) => b.events);
  expect(events).toContainEqual(expect.objectContaining({ kind: "click", name: "app.switch" }));
  expect(events).toContainEqual(
    expect.objectContaining({ kind: "track", name: "app.switched", props: { app: "app_beta" } }),
  );
});
