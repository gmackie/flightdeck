import { env } from "cloudflare:workers";
import { beforeEach, expect, it } from "vitest";
import { clearAppCache, getApp } from "../src/apps";

beforeEach(() => clearAppCache());

it("returns registered apps and null for unknown ids", async () => {
  await env.DB.prepare("INSERT INTO apps (id, name) VALUES ('app_reg', 'Reg')").run();
  expect(await getApp(env.DB, "app_reg")).toEqual({ id: "app_reg", name: "Reg", access_aud: null });
  expect(await getApp(env.DB, "app_nope")).toBeNull();
});

it("caches hits for 60s and misses for 5s", async () => {
  await env.DB.prepare("INSERT INTO apps (id, name) VALUES ('app_c', 'C')").run();
  await getApp(env.DB, "app_c", 0);
  await env.DB.prepare("DELETE FROM apps WHERE id = 'app_c'").run();
  expect(await getApp(env.DB, "app_c", 59_000)).not.toBeNull();
  expect(await getApp(env.DB, "app_c", 61_000)).toBeNull();
  await env.DB.prepare("INSERT INTO apps (id, name) VALUES ('app_c', 'C')").run();
  expect(await getApp(env.DB, "app_c", 65_000)).toBeNull();
  expect(await getApp(env.DB, "app_c", 67_000)).not.toBeNull();
});
