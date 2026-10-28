# Backup, restore and account-owned recovery

All commands operate against **your** Cloudflare account through Wrangler. Flightdeck never requires a hosted control plane.

```sh
pnpm workspace:backup -- --apply
pnpm workspace:doctor
```

The backup command exports D1 metadata (project configurations, source inventory, dashboards, graph, investigations, query budgets and audit) into a local SQL file with a SHA-256 manifest in `.flightdeck/backups/`. Backups may contain user identities and security metadata; encrypt and store them securely. They are gitignored.

To restore, create a **new, empty D1 database** and pass its ID/name explicitly:

```sh
pnpm exec wrangler d1 create flightdeck-meta-recovery
pnpm workspace:restore -- --file .flightdeck/backups/metadata-YYYY-MM-DD.sql --target-d1-name flightdeck-meta-recovery --target-d1-id UUID --apply
```

The restore script **refuses to overwrite the active D1 database**, verifies the exported SQL checksum and imports into the requested new target. It does not switch production bindings. Verify data first, then update generated Worker configs and redeploy through an audited change.

**R2/Basin event data is not included** in D1 exports. Follow your Cloudflare account's R2/Iceberg lifecycle and replication/backup policy, and separately verify Catalog tables, retention, and reprocessing. A D1 SQL export cannot restore lost event history.

Before major migrations:
1. Confirm a successful D1 backup and its checksum.
2. Review the migration SQL and changes affecting backward compatibility.
3. Apply via Wrangler remote migrations with a recorded revision.
4. Validate queries, source auth, and Access JWT enforcement.
5. Roll back Workers independently if required; revert D1 only using a verified recovery plan. D1 schema changes may be nonreversible.
