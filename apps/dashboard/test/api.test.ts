import { expect, it, vi } from "vitest";
import { fetchApps } from "../src/api";

const reply = (status: number, body?: unknown) =>
  vi.fn(async () => new Response(body === undefined ? null : JSON.stringify(body), { status }));

it("returns the apps from GET /api/apps", async () => {
  const apps = [{ id: "app_a", name: "A", created_at: 1 }];
  const fetcher = reply(200, { apps });
  expect(await fetchApps(fetcher)).toEqual({ status: "ok", apps });
  expect(fetcher).toHaveBeenCalledWith("/api/apps", expect.objectContaining({}));
});

it("treats 401 and 403 as signed out", async () => {
  expect(await fetchApps(reply(401))).toEqual({ status: "signed-out" });
  expect(await fetchApps(reply(403))).toEqual({ status: "signed-out" });
});

it("reports server errors, malformed bodies and network failures", async () => {
  expect(await fetchApps(reply(500))).toMatchObject({ status: "error", message: /HTTP 500/ });
  expect(await fetchApps(reply(200, { apps: [{ id: 1 }] }))).toMatchObject({ status: "error" });
  expect(await fetchApps(reply(200, "nope"))).toMatchObject({ status: "error" });
  const offline = vi.fn(async () => {
    throw new TypeError("Failed to fetch");
  });
  expect(await fetchApps(offline)).toMatchObject({ status: "error", message: /unreachable/ });
});
