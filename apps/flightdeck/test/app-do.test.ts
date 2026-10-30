import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { appShard } from "../src/do/shards";
import { row, sid } from "./fixtures";

it("counts events by kind and name, and unique sessions", async () => {
  const shard = appShard(env, "app_count", "2026-10-30T14");
  await shard.recordEvents([
    row({ path: "/" }),
    row({ path: "/" }),
    row({ kind: "click", name: "cta", session_id: sid("b") }),
  ]);
  expect(await shard.snapshot()).toEqual({
    counters: [
      { kind: "click", name: "cta", count: 1 },
      { kind: "page", name: "/", count: 2 },
    ],
    transitions: [],
    sessions: 2,
  });
});

it("counts sessionless rows without counting a session", async () => {
  const shard = appShard(env, "app_nosession", "2026-10-30T14");
  await shard.recordEvents([
    row({ kind: "track", name: "signup", session_id: null }),
    row({ kind: "track", name: "signup", session_id: null }),
  ]);
  expect(await shard.snapshot()).toEqual({
    counters: [{ kind: "track", name: "signup", count: 2 }],
    transitions: [],
    sessions: 0,
  });
});

it("accumulates transitions", async () => {
  const shard = appShard(env, "app_tr", "2026-10-30T14");
  await shard.recordTransitions([{ source: "$start", target: "/", count: 1 }]);
  await shard.recordTransitions([
    { source: "$start", target: "/", count: 2 },
    { source: "/", target: "cta", count: 1 },
  ]);
  expect((await shard.snapshot()).transitions).toEqual([
    { source: "$start", target: "/", count: 3 },
    { source: "/", target: "cta", count: 1 },
  ]);
});
