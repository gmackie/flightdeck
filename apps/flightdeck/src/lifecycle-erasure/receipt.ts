import * as v from "valibot";
import { canonical } from "../lifecycle-projection/identity";

/**
 * Receipts: the only evidence that moves an erasure job past `basin_pending`.
 *
 * A receipt is signed by the maintenance runner that executed the Iceberg operation (Spark, run
 * outside this Worker). The Worker holds only the matching PUBLIC key (Ed25519), so neither a
 * caller nor a leaked Worker config can mint one. A receipt also binds to one job (app, hashed
 * case identity, purge generation, per-request nonce), so it cannot be replayed for another case
 * or generation, and the two kinds are not interchangeable:
 *
 *   logical_delete    an Iceberg DELETE committed a snapshot and the current snapshot holds no
 *                     matching rows. Data files for older snapshots STILL EXIST (time travel).
 *   physical_cleanup  snapshots predating the DELETE were expired, no retained snapshot holds
 *                     matching rows, and orphan files were removed.
 *
 * Verifying a receipt proves only that the runner attested to it. Whether the runner really did
 * the work is an external trust assumption, documented in docs/operations/lifecycle-erasure-retention.md.
 */

export const RECEIPT_DOMAIN = "flightdeck.erasure.receipt.v1\n";
const FUTURE_SKEW_MS = 5 * 60_000;

const hex64 = v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/));
const ms = v.pipe(v.number(), v.safeInteger(), v.minValue(946_684_800_000));
const count = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const token = v.pipe(v.string(), v.regex(/^[A-Za-z0-9_.:-]{1,64}$/));
const table = v.pipe(
  v.string(),
  v.regex(/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*){1,3}$/),
);
const common = {
  v: v.literal(1),
  app_id: token,
  case_digest: hex64,
  purge_generation: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
  nonce: v.pipe(v.string(), v.regex(/^[0-9a-f]{32}$/)),
  table,
  issued_at: ms,
};

export const LogicalReceipt = v.strictObject({
  ...common,
  kind: v.literal("logical_delete"),
  /** `digest_v1`: the DELETE matched sha2(concat_ws('|', 'flightdeck.erasure.v1', app_id, case_id), 256). */
  predicate: v.literal("digest_v1"),
  snapshot_id: v.pipe(v.string(), v.regex(/^[0-9a-zA-Z_-]{1,40}$/)),
  committed_at: ms,
  rows_deleted: count,
  /** Rows matching the identity in the CURRENT snapshot after the DELETE. Must be 0. */
  rows_remaining: count,
});

export const PhysicalReceipt = v.strictObject({
  ...common,
  kind: v.literal("physical_cleanup"),
  logical_receipt_checksum: hex64,
  /** The DELETE snapshot this cleanup is relative to. */
  snapshot_id: v.pipe(v.string(), v.regex(/^[0-9a-zA-Z_-]{1,40}$/)),
  /** Snapshots committed before this instant were expired. */
  expired_before: ms,
  /** Commit time of the oldest snapshot still retained. */
  oldest_retained_committed_at: ms,
  /** Retained snapshots (time travel) that still contain a matching row. Must be 0. */
  retained_snapshots_with_rows: count,
  orphan_files_removed: v.boolean(),
});

export const ReconciliationAttestation = v.strictObject({
  v: v.literal(1),
  kind: v.literal("basin_reconciliation"),
  app_id: token,
  /** Basin was confirmed to hold every D1 log row of the app with seq <= through_seq. */
  through_seq: count,
  /** Number of such rows (checked against D1 at record time). */
  event_count: count,
  issued_at: ms,
});

export type LogicalReceipt = v.InferOutput<typeof LogicalReceipt>;
export type PhysicalReceipt = v.InferOutput<typeof PhysicalReceipt>;
export type ReconciliationAttestation = v.InferOutput<typeof ReconciliationAttestation>;
export type Receipt = LogicalReceipt | PhysicalReceipt | ReconciliationAttestation;

const Signed = v.strictObject({
  payload: v.unknown(),
  signature: v.pipe(v.string(), v.regex(/^[A-Za-z0-9+/]{86}==$/)),
  key_id: token,
});
export type SignedReceipt = { payload: unknown; signature: string; key_id: string };

/** Verifies a signature over the canonical payload. Fail-closed default: `rejectAll`. */
export interface ReceiptVerifier {
  verify(keyId: string, message: Uint8Array, signature: Uint8Array): Promise<boolean>;
}

export const rejectAll: ReceiptVerifier = { verify: async () => false };

const encoder = new TextEncoder();
export const messageOf = (payload: unknown) => encoder.encode(RECEIPT_DOMAIN + canonical(payload));

const fromBase64 = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

/** Ed25519 verification against pinned PUBLIC keys: `{ keyId: base64 raw 32-byte key }`. */
export function ed25519Verifier(publicKeys: Record<string, string>): ReceiptVerifier {
  const imported = new Map<string, Promise<CryptoKey | null>>();
  const keyFor = (id: string) => {
    let key = imported.get(id);
    if (!key) {
      const raw = publicKeys[id];
      key = raw
        ? crypto.subtle
            .importKey("raw", fromBase64(raw), { name: "Ed25519" }, false, ["verify"])
            .catch(() => null)
        : Promise.resolve(null);
      imported.set(id, key);
    }
    return key;
  };
  return {
    async verify(keyId, message, signature) {
      const key = await keyFor(keyId);
      if (!key) return false;
      return crypto.subtle.verify({ name: "Ed25519" }, key, signature, message).catch(() => false);
    },
  };
}

/** The verifier configured by `LIFECYCLE_ERASURE_RECEIPT_KEYS` (JSON `{ keyId: base64 }`), else none. */
export function verifierFromEnv(env: object): ReceiptVerifier {
  const raw = (env as { LIFECYCLE_ERASURE_RECEIPT_KEYS?: string }).LIFECYCLE_ERASURE_RECEIPT_KEYS;
  if (!raw) return rejectAll;
  try {
    const keys = JSON.parse(raw) as Record<string, string>;
    return ed25519Verifier(keys);
  } catch {
    return rejectAll;
  }
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export type Parsed<T> =
  | { ok: true; receipt: T; checksum: string; keyId: string }
  | { ok: false; code: ReceiptCode };

export type ReceiptCode =
  | "receipt_malformed"
  | "receipt_signature_invalid"
  | "receipt_wrong_kind"
  | "receipt_wrong_job"
  | "receipt_before_settle"
  | "receipt_from_future"
  | "receipt_rows_remaining"
  | "receipt_wrong_table"
  | "receipt_wrong_snapshot"
  | "receipt_logical_missing"
  | "receipt_snapshots_retained"
  | "receipt_orphans_not_removed"
  | "receipt_reconciliation_mismatch";

/**
 * Parses and authenticates a signed receipt of one kind. Order matters: shape first (so the
 * signature is never checked over junk), then signature, then the caller binds it to a job.
 */
export async function authenticate<K extends Receipt["kind"]>(
  signed: unknown,
  kind: K,
  verifier: ReceiptVerifier,
): Promise<Parsed<Extract<Receipt, { kind: K }>>> {
  const envelope = v.safeParse(Signed, signed);
  if (!envelope.success) return { ok: false, code: "receipt_malformed" };
  const schema =
    kind === "logical_delete"
      ? LogicalReceipt
      : kind === "physical_cleanup"
        ? PhysicalReceipt
        : ReconciliationAttestation;
  const body = v.safeParse(schema, envelope.output.payload);
  if (!body.success) {
    const asKind = (envelope.output.payload as { kind?: unknown } | null)?.kind;
    return {
      ok: false,
      code:
        typeof asKind === "string" && asKind !== kind ? "receipt_wrong_kind" : "receipt_malformed",
    };
  }
  const signature = fromBase64(envelope.output.signature);
  if (!(await verifier.verify(envelope.output.key_id, messageOf(body.output), signature))) {
    return { ok: false, code: "receipt_signature_invalid" };
  }
  return {
    ok: true,
    receipt: body.output as Extract<Receipt, { kind: K }>,
    checksum: await sha256Hex(canonical(body.output)),
    keyId: envelope.output.key_id,
  };
}

/** The slice of a job a receipt must match. */
export type JobBinding = {
  appId: string;
  caseDigest: string;
  purgeGeneration: number;
  nonce: string;
  settleUntil: number | null;
  logicalSnapshotId: string | null;
  logicalCommittedAt: number | null;
  logicalReceiptChecksum: string | null;
};

const bound = (
  r: { app_id: string; case_digest: string; purge_generation: number; nonce: string },
  j: JobBinding,
) =>
  r.app_id === j.appId &&
  r.case_digest === j.caseDigest &&
  r.purge_generation === j.purgeGeneration &&
  r.nonce === j.nonce;

export function checkLogical(
  r: LogicalReceipt,
  job: JobBinding,
  expectedTable: string,
  now: number,
): ReceiptCode | null {
  if (!bound(r, job)) return "receipt_wrong_job";
  if (r.table !== expectedTable) return "receipt_wrong_table";
  if (r.issued_at > now + FUTURE_SKEW_MS || r.committed_at > now + FUTURE_SKEW_MS) {
    return "receipt_from_future";
  }
  // A DELETE before the settle window may miss rows still in flight to Basin.
  if (
    job.settleUntil === null ||
    r.committed_at < job.settleUntil ||
    r.issued_at < r.committed_at
  ) {
    return "receipt_before_settle";
  }
  if (r.rows_remaining !== 0) return "receipt_rows_remaining";
  return null;
}

export function checkPhysical(
  r: PhysicalReceipt,
  job: JobBinding,
  expectedTable: string,
  now: number,
): ReceiptCode | null {
  if (!bound(r, job)) return "receipt_wrong_job";
  if (r.table !== expectedTable) return "receipt_wrong_table";
  if (!job.logicalReceiptChecksum || job.logicalCommittedAt === null)
    return "receipt_logical_missing";
  if (
    r.logical_receipt_checksum !== job.logicalReceiptChecksum ||
    r.snapshot_id !== job.logicalSnapshotId
  ) {
    return "receipt_wrong_snapshot";
  }
  if (r.issued_at > now + FUTURE_SKEW_MS) return "receipt_from_future";
  // Every snapshot from before the DELETE must be gone, or time travel can still read the rows.
  if (
    r.issued_at < job.logicalCommittedAt ||
    r.expired_before < job.logicalCommittedAt ||
    r.oldest_retained_committed_at < job.logicalCommittedAt ||
    r.retained_snapshots_with_rows !== 0
  ) {
    return "receipt_snapshots_retained";
  }
  if (!r.orphan_files_removed) return "receipt_orphans_not_removed";
  return null;
}
