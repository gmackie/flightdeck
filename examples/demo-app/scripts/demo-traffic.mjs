#!/usr/bin/env node
// Posts realistic multi-session funnel traffic to a running demo app (`pnpm dev`):
// a ForgeGraph delivery funnel through the Worker endpoint and a Wafflehouse game funnel
// through the Durable Object endpoint, with seeded drop-off at every stage.
//
//   node scripts/demo-traffic.mjs [--url http://localhost:8799] [--sessions 40] [--seed 7]

import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    url: { type: "string", default: "http://localhost:8799" },
    sessions: { type: "string", default: "40" },
    seed: { type: "string", default: "7" },
  },
});
const base = values.url.replace(/\/$/, "");
const sessions = Number(values.sessions);
const random = mulberry32(Number(values.seed));

const USER_AGENTS = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:144.0) Gecko/20100101 Firefox/144.0",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1",
];

/**
 * Each funnel: the pages a visitor lands on, the endpoint its custom events go to, and its
 * stages with the chance of reaching each one from the previous stage.
 */
const FUNNELS = {
  forgegraph: {
    endpoint: "/_fd/e",
    pages: (id) => ["/", `/changesets/${id}`],
    stages: [
      ["changeset.created", 0.9],
      ["ci.passed", 0.75],
      ["review.approved", 0.65],
      ["deployment.verified", 0.8],
    ],
  },
  wafflehouse: {
    endpoint: "/room/_fd/e",
    pages: (id) => ["/", `/rooms/${id}`],
    stages: [
      ["room.created", 0.85],
      ["room.joined", 0.8],
      ["game.started", 0.7],
      ["game.completed", 0.6],
    ],
  },
};

const run = randomBytes(4).toString("hex");
const tally = { sessions: 0, events: 0 };
const reached = Object.fromEntries(
  Object.entries(FUNNELS).map(([key, f]) => [
    key,
    Object.fromEntries(f.stages.map(([s]) => [s, 0])),
  ]),
);

for (let i = 0; i < sessions; i++) {
  const source = i % 2 === 0 ? "forgegraph" : "wafflehouse";
  const funnel = FUNNELS[source];
  const sessionId = `demo-${run}-${i}`;
  const anonymousId = `anon-${run}-${i}`;
  const userAgent = USER_AGENTS[i % USER_AGENTS.length];
  const objectId = Math.floor(random() * 10_000);
  const start = Date.now();
  let seq = 0;
  const event = (kind, name, extra = {}) => {
    seq++;
    return {
      kind,
      name,
      eventId: `${sessionId}-${seq}`,
      ts: start + seq * 100,
      sessionId,
      anonymousId,
      ...extra,
    };
  };

  const pageEvents = funnel.pages(objectId).map((path) => event("page", path, { path }));
  const stageEvents = [];
  for (const [stage, chance] of funnel.stages) {
    if (random() > chance) break;
    reached[source][stage]++;
    stageEvents.push(event("track", stage, { props: { source, stage: stageEvents.length } }));
  }

  await post("/_fd/e", pageEvents, userAgent);
  if (stageEvents.length) await post(funnel.endpoint, stageEvents, userAgent);
  tally.sessions++;
  tally.events += pageEvents.length + stageEvents.length;
}

console.log(JSON.stringify({ run, ...tally, reached }, null, 2));

/** Posts one batch like the browser script does: same-origin text/plain with a browser UA. */
async function post(path, events, userAgent) {
  const res = await fetch(base + path, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=UTF-8", Origin: base, "User-Agent": userAgent },
    body: JSON.stringify({ events }),
  });
  if (!res.ok) throw new Error(`POST ${path} failed: ${res.status} ${await res.text()}`);
}

/** Small seeded PRNG so the funnel shape is the same on every run. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}
