import { afterEach, expect, it, vi } from "vitest";
import { followSystemTheme } from "../src/theme";

afterEach(() => vi.unstubAllGlobals());

it("mirrors prefers-color-scheme onto data-mode and follows changes", () => {
  const query = new EventTarget() as EventTarget & { matches: boolean };
  query.matches = true;
  vi.stubGlobal("matchMedia", (q: string) => {
    expect(q).toBe("(prefers-color-scheme: dark)");
    return query;
  });
  const root = document.createElement("div");
  const stop = followSystemTheme(root);
  expect(root.dataset.mode).toBe("dark");
  query.matches = false;
  query.dispatchEvent(new Event("change"));
  expect(root.dataset.mode).toBe("light");
  stop();
  query.matches = true;
  query.dispatchEvent(new Event("change"));
  expect(root.dataset.mode).toBe("light");
});
