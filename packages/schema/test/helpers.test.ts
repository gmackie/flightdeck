import { describe, expect, it } from "vitest";
import { hourKey, normalizeRoute, parseUserAgent, stepName } from "../src";

describe("normalizeRoute", () => {
  it.each([
    ["/users/123", "/users/:id"],
    ["/orders/0b6f8d0e-6c1e-4a59-9a43-6f1f0f6c2b11/items", "/orders/:id/items"],
    ["/r/01JBQ8Z6X3K2M4N5P6Q7R8S9T0", "/r/:id"],
    ["/blob/9f86d081884c7d65", "/blob/:id"],
    ["/pricing?plan=pro#faq", "/pricing"],
    ["/docs/", "/docs"],
    ["", "/"],
    ["/", "/"],
  ])("%s -> %s", (input, out) => expect(normalizeRoute(input)).toBe(out));
});

describe("parseUserAgent", () => {
  it("detects desktop Chrome on macOS", () => {
    const ua =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
    expect(parseUserAgent(ua)).toEqual({ device: "desktop", browser: "Chrome", os: "macOS" });
  });
  it("detects iPhone Safari, iPad, bots, and missing UAs", () => {
    expect(
      parseUserAgent(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1",
      ),
    ).toEqual({ device: "mobile", browser: "Safari", os: "iOS" });
    expect(
      parseUserAgent("Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) Safari/604.1").device,
    ).toBe("tablet");
    expect(parseUserAgent("Mozilla/5.0 (compatible; Googlebot/2.1)").device).toBe("bot");
    expect(parseUserAgent(undefined)).toEqual({ device: "unknown", browser: "Other", os: "Other" });
  });
});

describe("stepName", () => {
  it("uses the path for pages, the name otherwise, and skips identify", () => {
    expect(stepName({ kind: "page", name: "page", path: "/pricing" })).toBe("/pricing");
    expect(stepName({ kind: "click", name: "pricing.cta", path: "/pricing" })).toBe("pricing.cta");
    expect(stepName({ kind: "identify", name: "identify", path: "/" })).toBeNull();
  });
});

it("hourKey truncates to the UTC hour", () => {
  expect(hourKey(Date.UTC(2026, 9, 30, 14, 59, 59))).toBe("2026-10-30T14");
});
