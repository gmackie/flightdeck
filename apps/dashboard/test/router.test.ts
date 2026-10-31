import { beforeEach, expect, it } from "vitest";
import { navigate, pageFrom, pageHref, selectedAppParam, withApp } from "../src/router";

beforeEach(() => history.replaceState(null, "", "/"));

it("maps paths to pages", () => {
  expect(pageFrom("/")).toBe("live");
  expect(pageFrom("/trends")).toBe("trends");
  expect(pageFrom("/workflows")).toBe("workflows");
  expect(pageFrom("/apps/")).toBe("apps");
  expect(pageFrom("/nope")).toBeNull();
});

it("keeps the selected app in the URL across pages", () => {
  navigate("/live?app=app_a%2Fb");
  expect(selectedAppParam()).toBe("app_a/b");
  expect(pageHref("trends")).toBe("/trends?app=app_a%2Fb");
  expect(pageHref("live", "app_c")).toBe("/live?app=app_c");
  expect(withApp("app_c")).toBe("/live?app=app_c");
  expect(withApp(null)).toBe("/live");
});

it("replaces or pushes history entries", () => {
  const before = history.length;
  navigate("/trends");
  expect(history.length).toBe(before + 1);
  navigate("/apps", { replace: true });
  expect(history.length).toBe(before + 1);
  expect(location.pathname).toBe("/apps");
});
