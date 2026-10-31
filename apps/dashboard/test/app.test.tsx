import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/app";
import { mockApps } from "./helpers";

beforeEach(() => history.replaceState(null, "", "/"));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const nav = () => within(screen.getByRole("navigation", { name: "Primary" }));

describe("shell", () => {
  it("renders the sidebar nav with data-flightdeck names", async () => {
    mockApps(200);
    render(<App />);
    for (const [label, id] of [
      ["Live", "live"],
      ["Trends", "trends"],
      ["Journeys", "journeys"],
      ["Funnels", "funnels"],
      ["Retention", "retention"],
      ["Apps", "apps"],
    ]) {
      expect(nav().getByRole("link", { name: new RegExp(`^${label}`) })).toHaveAttribute(
        "data-flightdeck",
        `nav.${id}`,
      );
    }
    await screen.findByText("What is happening in Alpha now");
  });

  it("selects the first app and records it in the URL", async () => {
    const fetcher = mockApps(200);
    render(<App />);
    await screen.findByText("What is happening in Alpha now");
    expect(location.pathname + location.search).toBe("/live?app=app_alpha");
    expect(fetcher).toHaveBeenCalledWith("/api/apps", expect.anything());
    expect(document.title).toBe("Live · Flightdeck");
  });

  it("keeps a valid ?app= and replaces an unknown one", async () => {
    mockApps(200);
    history.replaceState(null, "", "/trends?app=app_beta");
    const { unmount } = render(<App />);
    await screen.findByText("Event counts over time for Beta");
    unmount();
    history.replaceState(null, "", "/trends?app=app_gone");
    render(<App />);
    await screen.findByText("Event counts over time for Alpha");
    expect(location.search).toBe("?app=app_alpha");
  });

  it("leaves modified clicks on the brand link to the browser", async () => {
    mockApps(200);
    render(<App />);
    await screen.findByText("What is happening in Alpha now");
    const brand = screen.getByRole("link", { name: "Flightdeck" });
    expect(brand).toHaveAttribute("href", "/live?app=app_alpha");
    const click = new MouseEvent("click", { bubbles: true, cancelable: true, metaKey: true });
    brand.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(false);
    const plain = new MouseEvent("click", { bubbles: true, cancelable: true });
    brand.dispatchEvent(plain);
    expect(plain.defaultPrevented).toBe(true);
  });

  it("navigates client-side and keeps the selected app", async () => {
    mockApps(200);
    history.replaceState(null, "", "/live?app=app_beta");
    render(<App />);
    await screen.findByText("What is happening in Beta now");
    await userEvent.click(nav().getByRole("link", { name: /^Trends/ }));
    await screen.findByText("Event counts over time for Beta");
    expect(location.pathname + location.search).toBe("/trends?app=app_beta");
    expect(nav().getByRole("link", { name: /^Trends/ })).toHaveAttribute("aria-current", "page");
  });

  it("switches apps from the header", async () => {
    mockApps(200);
    render(<App />);
    await screen.findByText("What is happening in Alpha now");
    const trigger = screen.getByRole("combobox", { name: "Select app" });
    expect(trigger.closest("[data-flightdeck]")).toHaveAttribute("data-flightdeck", "app.switch");
    await userEvent.click(trigger);
    await userEvent.click(await screen.findByRole("option", { name: "Beta" }));
    await screen.findByText("What is happening in Beta now");
    expect(location.search).toBe("?app=app_beta");
  });

  it("shows coming-soon pages without waiting for apps", async () => {
    mockApps(200);
    history.replaceState(null, "", "/funnels");
    render(<App />);
    expect(screen.getByText("Funnels is coming soon")).toBeInTheDocument();
  });

  it("shows a not-found state for unknown paths", async () => {
    mockApps(200);
    history.replaceState(null, "", "/nope");
    render(<App />);
    expect(await screen.findByText("Page not found")).toBeInTheDocument();
  });
});

describe("apps states", () => {
  it("shows a signed-out state on 401", async () => {
    mockApps(401);
    render(<App />);
    await screen.findByText("You are signed out");
    expect(screen.getByRole("button", { name: "Sign in" })).toHaveAttribute(
      "data-flightdeck",
      "auth.signin",
    );
    expect(screen.getByRole("combobox", { name: "Select app" })).toHaveTextContent("Signed out");
  });

  it("shows a no-access state on 403", async () => {
    mockApps(403);
    render(<App />);
    await screen.findByText("You don't have access");
    expect(screen.getByRole("combobox", { name: "Select app" })).toHaveTextContent("No access");
  });

  it("shows empty states when there are no apps", async () => {
    mockApps(200, { apps: [] });
    render(<App />);
    await screen.findByText("No apps yet");
    await userEvent.click(screen.getByRole("button", { name: "Go to Apps" }));
    await screen.findByText("Connect your first app to start collecting events.");
    expect(location.pathname).toBe("/apps");
  });

  it("reports errors and retries", async () => {
    const fetcher = mockApps(500);
    render(<App />);
    await screen.findByText("Couldn't load apps");
    mockApps(200);
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByText("What is happening in Alpha now");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe("apps page", () => {
  it("lists apps and opens the connect dialog", async () => {
    mockApps(200);
    history.replaceState(null, "", "/apps?app=app_beta");
    render(<App />);
    const table = await screen.findByRole("table");
    expect(within(table).getByText("app_alpha")).toBeInTheDocument();
    expect(within(table).getByText("Selected")).toBeInTheDocument();
    const open = screen.getByRole("button", { name: "Connect an app" });
    expect(open).toHaveAttribute("data-flightdeck", "apps.add.open");
    await userEvent.click(open);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/"appId": "app_beta"/)).toBeInTheDocument();
  });

  it("views an app's live page", async () => {
    mockApps(200);
    history.replaceState(null, "", "/apps");
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "View Beta" }));
    await screen.findByText("What is happening in Beta now");
    expect(location.pathname + location.search).toBe("/live?app=app_beta");
  });
});
