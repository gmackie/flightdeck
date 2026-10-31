import { vi } from "vitest";
import type { App } from "../src/api";

export const APPS: App[] = [
  { id: "app_alpha", name: "Alpha", created_at: Date.UTC(2026, 9, 1) },
  { id: "app_beta", name: "Beta", created_at: Date.UTC(2026, 9, 2) },
];

/** Stubs `fetch` so `GET /api/apps` answers with `status` and `body`. */
export function mockApps(status: number, body: unknown = { apps: APPS }) {
  const fetcher = vi.fn(
    async () => new Response(status === 401 ? null : JSON.stringify(body), { status }),
  );
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}
