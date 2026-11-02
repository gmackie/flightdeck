import type {
  BasinErasureExecutor,
  CleanupRequest,
  ExecutorRequest,
} from "../../src/lifecycle-erasure/executor";
import {
  ed25519Verifier,
  messageOf,
  type ReceiptVerifier,
  type SignedReceipt,
  sha256Hex,
} from "../../src/lifecycle-erasure/receipt";
import { canonical } from "../../src/lifecycle-projection/identity";

/** Synthetic signing material and a fake Iceberg runner. Nothing here talks to any service. */

const b64 = (bytes: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(bytes)));

export type Signer = {
  keyId: string;
  publicKey: string;
  verifier: ReceiptVerifier;
  sign(payload: Record<string, unknown>): Promise<SignedReceipt>;
};

export async function makeSigner(keyId = "test-key-1"): Promise<Signer> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const publicKey = b64((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  return {
    keyId,
    publicKey,
    verifier: ed25519Verifier({ [keyId]: publicKey }),
    async sign(payload) {
      const signature = await crypto.subtle.sign(
        { name: "Ed25519" },
        pair.privateKey,
        messageOf(payload),
      );
      return { payload, signature: b64(signature), key_id: keyId };
    },
  };
}

export const checksumOf = (payload: unknown) => sha256Hex(canonical(payload));

export type RunnerOptions = {
  signer: Signer;
  now: () => number;
  /** Rows the fake DELETE reports and (for the failure drills) the leftovers it reports. */
  rowsDeleted?: number;
  rowsRemaining?: number;
  /** How the fake Iceberg table writes DELETEs. merge_on_read adds a separate rewrite commit. */
  deleteMode?: "copy_on_write" | "merge_on_read";
  retainedSnapshotsWithRows?: number;
  affectedFilesRemaining?: number;
  deleteFilesApplying?: number;
  /** Override fields of the payload to model a wrong or hostile receipt. */
  tamperLogical?: Record<string, unknown>;
  tamperPhysical?: Record<string, unknown> | ((request: CleanupRequest) => Record<string, unknown>);
  failWith?: Error;
};

/** Stand-in for sha256 of the sorted paths of the data files that held the identity's rows. */
export const filesDigest = (caseDigest: string) => checksumOf({ files: caseDigest });

/** A fake runner: signs what a correct Spark job would report. Records the calls it received. */
export function syntheticRunner(options: RunnerOptions) {
  const calls: { op: "delete" | "cleanup"; request: ExecutorRequest }[] = [];
  const mode = options.deleteMode ?? "copy_on_write";
  const runner: BasinErasureExecutor = {
    async deleteForwardedRows(request) {
      calls.push({ op: "delete", request });
      if (options.failWith) throw options.failWith;
      const now = options.now();
      return options.signer.sign({
        v: 1,
        kind: "logical_delete",
        app_id: request.appId,
        case_digest: request.caseDigest,
        purge_generation: request.purgeGeneration,
        nonce: request.nonce,
        table: request.table,
        issued_at: now,
        predicate: "digest_v1",
        snapshot_id: "7000000000000000001",
        committed_at: Math.max(now, request.notBefore),
        rows_deleted: options.rowsDeleted ?? 3,
        rows_remaining: options.rowsRemaining ?? 0,
        delete_mode: mode,
        affected_files_digest: await filesDigest(request.caseDigest),
        affected_files: 2,
        ...options.tamperLogical,
      });
    },
    async expireAndCleanup(request: CleanupRequest) {
      calls.push({ op: "cleanup", request });
      if (options.failWith) throw options.failWith;
      const at = Math.max(options.now(), request.cleanupNotBefore);
      // Copy-on-write materializes the delete in its own commit; merge-on-read needs a rewrite after it.
      const materialized =
        mode === "merge_on_read" ? request.deleteCommittedAt + 1 : request.deleteCommittedAt;
      return options.signer.sign({
        v: 1,
        kind: "physical_cleanup",
        app_id: request.appId,
        case_digest: request.caseDigest,
        purge_generation: request.purgeGeneration,
        nonce: request.nonce,
        table: request.table,
        issued_at: at,
        logical_receipt_checksum: request.logicalReceiptChecksum,
        snapshot_id: request.deleteSnapshotId,
        delete_mode: request.deleteMode,
        affected_files_digest: request.affectedFilesDigest,
        materialized_at: materialized,
        affected_files_remaining: options.affectedFilesRemaining ?? 0,
        delete_files_applying: options.deleteFilesApplying ?? 0,
        expired_at: at,
        expired_before: materialized,
        oldest_retained_committed_at: materialized,
        retained_snapshots_with_rows: options.retainedSnapshotsWithRows ?? 0,
        orphans_removed_at: at,
        ...(typeof options.tamperPhysical === "function"
          ? options.tamperPhysical(request)
          : options.tamperPhysical),
      });
    },
  };
  return { runner, calls };
}
