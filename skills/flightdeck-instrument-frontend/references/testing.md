# Testing the browser instrumentation

Assert that tagged interactions produce a `POST /_fd/e` with the expected `{ events: [{ kind, name, props? }] }` body. The SDK sends with `navigator.sendBeacon` (falling back to `fetch`), batching until 20 events, every 5 s, or when the tab is hidden/closed.

## Playwright (preferred where the repo has an e2e suite)

Intercept the endpoint, so the test does not depend on a running Flightdeck and never posts real analytics:

```ts
import { expect, test } from "@playwright/test";

type Sent = { events: { kind: string; name: string; props?: Record<string, unknown> }[] };

test("primary actions reach /_fd/e", async ({ page }) => {
  const batches: Sent[] = [];
  await page.route("**/_fd/e", async (route) => {
    batches.push(JSON.parse(route.request().postData() ?? "{}"));
    await route.fulfill({ status: 204 });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "New issue" }).click();

  // Hiding the page flushes the queue immediately (otherwise wait for the 5 s interval).
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });

  await expect
    .poll(() => batches.flatMap((b) => b.events).map((e) => `${e.kind}:${e.name}`))
    .toEqual(expect.arrayContaining(["page:/", "click:issue.create"]));
});
```

If `postData()` is null for beacons in your Playwright version, assert on `route.request().postDataBuffer()?.toString()` instead.

## happy-dom / Vitest (component or unit level)

Stub `sendBeacon`, render the component, interact, then flush by hiding the document. `_reset()` tears the singleton down between tests.

```ts
// @vitest-environment happy-dom
import { _reset, init } from "@flightdeckhq/browser";
import { afterEach, beforeEach, expect, it } from "vitest";

const sent: { kind: string; name: string }[] = [];
const setVisibility = (value: DocumentVisibilityState) =>
  Object.defineProperty(document, "visibilityState", { configurable: true, value });

beforeEach(() => {
  sent.length = 0;
  setVisibility("visible");
  Object.defineProperty(navigator, "sendBeacon", {
    configurable: true,
    value: (url: string, blob: Blob) => {
      expect(url).toBe("/_fd/e");
      void blob.text().then((t) => sent.push(...JSON.parse(t).events));
      return true;
    },
  });
});
afterEach(() => {
  _reset();
  setVisibility("visible");
});

/** Hiding the page flushes the queue; the beacon body is read asynchronously. */
async function flush() {
  setVisibility("hidden");
  document.dispatchEvent(new Event("visibilitychange"));
  await new Promise((r) => setTimeout(r, 0));
  return sent.map((e) => `${e.kind}:${e.name}`);
}

it("tags the create button", async () => {
  document.body.innerHTML = `<button data-flightdeck="issue.create">New issue</button>`; // or render(<Toolbar />)
  init({ trackPages: false });
  document.querySelector("button")?.click();
  expect(await flush()).toEqual(["click:issue.create"]);
});
```

Test `beforeSend`/`redactProps` the same way for sensitive apps: render a page whose path or props would leak, and assert the sent body is scrubbed.

## Manual check

DevTools > Network, filter `_fd`: each flush shows a `POST /_fd/e` with status 204. The payload lists the events. A 403 means the page's origin differs from the URL the Worker sees (configure `allowedOrigins` in the Worker); 404/405 means `/_fd/e` is not reaching the wrapped Worker (step 3 of the skill).
