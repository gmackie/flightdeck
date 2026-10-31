#!/usr/bin/env node
// Optional black-box producer: POSTs fixture events to a lifecycle ingestion endpoint.
//
// SAFETY
//  - Dry run by default. Nothing is sent without --send.
//  - The token is read from FLIGHTDECK_LIFECYCLE_TEST_ONLY_TOKEN only (never argv, never files),
//    and must start with TEST_ONLY_. Production keys do not, so they are refused.
//  - The base URL comes from FLIGHTDECK_LIFECYCLE_BASE_URL (https, or http on loopback only).
//  - It never prints the token, and it never reports success unless the endpoint answered 2xx.
//  - If the endpoint is absent (404/405/501) it says so and exits 3: the lifecycle API
//    (/v1/lifecycle/events) is owned by another workstream and may not be merged or deployed.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { validateEvent } from "./lib/model.mjs";

export const PATH = "/v1/lifecycle/events";
export const TOKEN_ENV = "FLIGHTDECK_LIFECYCLE_TEST_ONLY_TOKEN";
export const URL_ENV = "FLIGHTDECK_LIFECYCLE_BASE_URL";
const MAX_BATCH = 50;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class UsageError extends Error {}

function baseUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new UsageError(`${URL_ENV} is not a valid URL`);
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) {
    throw new UsageError(`${URL_ENV} must be https (http is allowed only for localhost)`);
  }
  if (u.username || u.password) throw new UsageError(`${URL_ENV} must not embed credentials`);
  return u;
}

/**
 * @param {{ file: string, app: string, send: boolean, limit: number, includeInvalid: boolean, includeAppId: boolean }} opts
 * @param {{ env?: Record<string, string | undefined>, fetch?: typeof fetch, log?: (s: string) => void, sleep?: (ms: number) => Promise<void> }} [io]
 * @returns {Promise<{ code: number, status: string, batches: number, events: number }>}
 */
export async function produce(opts, io = {}) {
  const env = io.env ?? process.env;
  const log = io.log ?? console.log;
  const doFetch = io.fetch ?? fetch;
  const wait = io.sleep ?? sleep;

  if (!opts.app)
    throw new UsageError(
      "--app <appId> is required: the credential, not the payload, selects the app",
    );
  const events = [];
  let skippedInvalid = 0;
  for (const line of readFileSync(opts.file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    const ev = rec?.event;
    if (!ev || typeof ev !== "object" || ev.appId !== opts.app) continue;
    if (!opts.includeInvalid && validateEvent(ev)) {
      skippedInvalid++;
      continue;
    }
    if (events.length >= opts.limit) break;
    if (opts.includeAppId) events.push(ev);
    else {
      const { appId: _scope, ...rest } = ev;
      events.push(rest);
    }
  }
  if (events.length === 0) throw new UsageError(`no events for app ${opts.app} in ${opts.file}`);
  const batches = [];
  for (let i = 0; i < events.length; i += MAX_BATCH) batches.push(events.slice(i, i + MAX_BATCH));

  log(
    `plan: ${events.length} events for ${opts.app} in ${batches.length} batch(es) of <=${MAX_BATCH}` +
      (skippedInvalid ? `, ${skippedInvalid} invalid skipped` : ""),
  );
  if (!opts.send) {
    log("DRY RUN: nothing was sent. Re-run with --send to POST to the endpoint.");
    return { code: 0, status: "dry-run", batches: batches.length, events: events.length };
  }

  const token = env[TOKEN_ENV];
  if (!token) throw new UsageError(`${TOKEN_ENV} is not set; refusing to send`);
  if (!/^test_only_/i.test(token))
    throw new UsageError(
      `${TOKEN_ENV} must start with TEST_ONLY_; refusing to send (production credentials are never used)`,
    );
  if (!env[URL_ENV]) throw new UsageError(`${URL_ENV} is not set; refusing to send`);
  const url = new URL(PATH, baseUrl(env[URL_ENV]));
  log(`sending to ${url.origin}${PATH} with a TEST_ONLY token`);

  let sent = 0;
  let accepted = 0;
  let rejected = 0;
  let reported = false;
  for (const [i, batch] of batches.entries()) {
    let res;
    for (let attempt = 0; ; attempt++) {
      try {
        res = await doFetch(url, {
          method: "POST",
          redirect: "manual",
          signal: AbortSignal.timeout(10_000),
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ events: batch }),
        });
      } catch (err) {
        res = null;
        if (attempt >= 3) {
          log(`FAILED: network error on batch ${i + 1}: ${err?.name ?? "error"}`);
          return { code: 1, status: "network-error", batches: sent, events: accepted };
        }
      }
      if (res && res.status !== 503) break;
      if (res && attempt >= 3) break;
      await wait(250 * 2 ** attempt); // bounded backoff, same event ids
    }
    if ([404, 405, 501].includes(res.status)) {
      log(
        `ENDPOINT NOT AVAILABLE: POST ${PATH} returned ${res.status}. Lifecycle ingestion does not appear to be deployed at this URL, so nothing was ingested and nothing was verified.`,
      );
      return { code: 3, status: "endpoint-absent", batches: sent, events: 0 };
    }
    if (res.status === 401 || res.status === 403) {
      log(`FAILED: ${res.status} from endpoint (credential not accepted for ${opts.app}).`);
      return { code: 1, status: "unauthorized", batches: sent, events: accepted };
    }
    if (res.status < 200 || res.status >= 300) {
      const text = (await res.text().catch(() => "")).slice(0, 200).replaceAll(token, "[redacted]");
      log(`FAILED: batch ${i + 1} got HTTP ${res.status} ${text}`);
      return { code: 1, status: `http-${res.status}`, batches: sent, events: accepted };
    }
    sent++;
    const body = await res.json().catch(() => null);
    if (body && Number.isFinite(body.accepted)) {
      reported = true;
      accepted += body.accepted;
      rejected += Number.isFinite(body.rejected) ? body.rejected : 0;
    } else accepted += batch.length;
  }
  log(
    `endpoint answered 2xx for ${sent}/${batches.length} batch(es)` +
      (reported
        ? `; it reported accepted=${accepted} rejected=${rejected}`
        : "; it reported no accepted/rejected counts") +
      ".",
  );
  log(
    "This only shows the endpoint accepted the requests. It does not verify lifecycle semantics: compare server-side results with the fixture's expected.json separately.",
  );
  return { code: 0, status: "sent", batches: sent, events: accepted };
}

function parseArgs(argv) {
  const o = {
    file: null,
    app: null,
    send: false,
    limit: 500,
    includeInvalid: false,
    includeAppId: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--send") o.send = true;
    else if (a === "--include-invalid") o.includeInvalid = true;
    else if (a === "--include-app-id") o.includeAppId = true;
    else if (a === "--app") o.app = argv[++i];
    else if (a === "--limit") o.limit = Number(argv[++i]);
    else if (a === "--token" || a.startsWith("--token=")) {
      throw new UsageError(`tokens are never accepted on the command line; set ${TOKEN_ENV}`);
    } else if (a.startsWith("--")) throw new UsageError(`unknown option ${a}`);
    else o.file = a;
  }
  if (!o.file)
    throw new UsageError(
      "usage: produce-http.mjs <events.ndjson> --app <appId> [--limit N] [--send] [--include-invalid] [--include-app-id]",
    );
  if (!Number.isInteger(o.limit) || o.limit < 1)
    throw new UsageError("--limit must be a positive integer");
  return o;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const r = await produce(parseArgs(process.argv.slice(2)));
    process.exitCode = r.code;
  } catch (err) {
    console.error(`error: ${err.message}`);
    process.exitCode = err instanceof UsageError ? 2 : 1;
  }
}
