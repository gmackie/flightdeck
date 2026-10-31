import type { ClientEventInput, IngestResult, IngestRpc } from "@flightdeckhq/schema";

export type PrivacyOptions = {
  /**
   * Runs on every event before it leaves the app Worker: browser events posted to `/_fd/e` and
   * server `track`/`identify` calls (stamped with `ts` first). Return the event (rewritten or
   * not), or null to drop it. An exception drops the event.
   */
  beforeSend?: (event: ClientEventInput) => ClientEventInput | null;
  /**
   * Replaces a non-empty string `userId` with the SHA-256 hex of `salt + userId`, after
   * `beforeSend`. Use a secret salt: without one, guessable ids can be reversed by hashing
   * candidates. A salt that is not a non-empty string drops `userId` instead (with one warning).
   * The Access-verified identity Flightdeck resolves itself is not affected.
   */
  hashUserId?: true | { salt: string };
};

const NOTHING: IngestResult = { accepted: 0, rejected: 0 };
const DROP = Symbol("drop");
const encoder = new TextEncoder();
let warnedSalt = false;

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The salt to hash with, or null when a configured salt is unusable. */
function saltOf(hash: NonNullable<PrivacyOptions["hashUserId"]>): string | null {
  if (hash === true) return "";
  const salt: unknown = hash.salt;
  if (typeof salt === "string" && salt) return salt;
  if (!warnedSalt) {
    warnedSalt = true;
    console.warn("Flightdeck: hashUserId salt is missing or empty; dropping userId instead");
  }
  return null;
}

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
  // Only non-empty strings are hashed; anything else is left for ingest to reject.
  if (o.hashUserId && typeof out.userId === "string" && out.userId) {
    const salt = saltOf(o.hashUserId);
    if (salt === null) {
      const { userId: _, ...rest } = out;
      return rest;
    }
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
    // Stamp ts as the Ingest entrypoint would, so beforeSend sees a complete event.
    const full = isRecord(event) ? { ts: Date.now(), ...event, ...fixed } : event;
    const out = await scrub(full, o);
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
