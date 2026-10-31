import type { ClientEventInput, IngestResult, IngestRpc } from "@flightdeckhq/schema";

export type PrivacyOptions = {
  /**
   * Runs on every event before it leaves the app Worker: browser events posted to `/_fd/e` and
   * server `track`/`identify` calls. Return the event (rewritten or not), or null to drop it.
   * An exception drops the event.
   */
  beforeSend?: (event: ClientEventInput) => ClientEventInput | null;
  /**
   * Replaces `userId` with the SHA-256 hex of `salt + userId`, after `beforeSend`. The
   * Access-verified identity Flightdeck resolves itself is not affected.
   */
  hashUserId?: true | { salt: string };
};

const NOTHING: IngestResult = { accepted: 0, rejected: 0 };
const DROP = Symbol("drop");
const encoder = new TextEncoder();

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Returns the event to send, or DROP. Non-objects pass through for Flightdeck to reject. */
async function scrub(event: unknown, o: PrivacyOptions): Promise<unknown> {
  if (!isRecord(event)) return event;
  let out: ClientEventInput | null = event as ClientEventInput;
  if (o.beforeSend) {
    try {
      out = o.beforeSend(out);
    } catch (err) {
      console.error("Flightdeck: beforeSend threw; event dropped", err);
      return DROP;
    }
  }
  if (!out) return DROP;
  if (o.hashUserId && typeof out.userId === "string") {
    const salt = o.hashUserId === true ? "" : o.hashUserId.salt;
    out = { ...out, userId: await sha256Hex(salt + out.userId) };
  }
  return out;
}

/** Wraps `binding` so every event goes through `beforeSend` and `hashUserId` first. */
export function withPrivacy(binding: IngestRpc, o: PrivacyOptions): IngestRpc {
  if (!o.beforeSend && !o.hashUserId) return binding;
  const one = async (
    event: unknown,
    fixed: { kind: string; name?: string },
    send: (event: unknown) => Promise<IngestResult>,
  ) => {
    const out = await scrub(isRecord(event) ? { ...event, ...fixed } : event, o);
    return out === DROP ? NOTHING : send(out);
  };
  return {
    async ingest(batch) {
      if (!isRecord(batch) || !Array.isArray(batch.events) || batch.events.length === 0) {
        return binding.ingest(batch);
      }
      const events: unknown[] = batch.events;
      const kept = (await Promise.all(events.map((e) => scrub(e, o)))).filter((e) => e !== DROP);
      return kept.length ? binding.ingest({ ...batch, events: kept }) : NOTHING;
    },
    track: (event) => one(event, { kind: "track" }, (e) => binding.track(e)),
    identify: (input) =>
      one(input, { kind: "identify", name: "identify" }, (e) => binding.identify(e)),
  };
}
