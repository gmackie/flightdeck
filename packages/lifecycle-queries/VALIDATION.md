# Workstream G validation

Validated locally on 2026-10-31 against base `af2f2f7` in the isolated `feat/lifecycle-query-analytics` worktree, using Node 24.14.0, pnpm 12.14.0, Vitest 5.0.5 and TypeScript 7.0.2.

- `pnpm --filter @flightdeckhq/lifecycle-queries test --coverage`: **96 tests passed**.
- Measured V8 source coverage: **354/356 statements (99.43%)**, **343/356 branches (96.34%)**, **63/63 functions (100%)**, **333/333 lines (100%)**. Includes adapter, demo, fake, result formatting, SQL builder, validation and entrypoint files. Generated JSON is ignored under `coverage/` and can be reproduced with the command above.
- `pnpm test`: **388 tests passed in 31 files**, including the existing Worker, dashboard, schema and SDK suites. Existing Cloudflare test fixtures log deliberate exception-path messages; Vitest exits successfully.
- `pnpm typecheck`: passed for all workspace projects, including local Wrangler type generation.
- `pnpm lint`: passed.
- `pnpm --filter @flightdeckhq/lifecycle-queries build`: passed.
- `pnpm smoke:pack`: passed, including tarball file restrictions, temporary installation, TypeScript 7.0.2/5.9.3 checks and existing SDK/CLI import smoke checks. The new package remains private; its tarball exports point to built declarations and ESM.
- Built query package imported in Node and served the synthetic demo with two expected strata.
- `git diff --check`: passed.

The local sandbox initially prevented Wrangler logs and loopback sockets. Full tests/type generation were rerun with those local capabilities and passed. Adding the coverage provider initially produced two Vitest peer identities; lockfile deduplication unified them without changing installed versions or shared source files. No dashboard, schema, event, reducer or auth implementation was edited.

SQL tests execute generated SELECT queries against local SQLite with an exact percentile stand-in and compare results to the independently implemented fake adapter. They verify revision/replay/cohort/counting semantics and output limits. **No Basin endpoint, Cloudflare account, real Iceberg table, approximate percentile implementation, query scan budget, or partition pruning was exercised.** See README for the explicit projector and executor integration requirements.

Kanbanger was skipped as authorized: `kanbanger auth whoami` reported no configured API key. The live ForgeGraph API returned `App not found` for its cached `flightdeck` application; publication uses this repository's GitHub remote. No merge, release, staging deployment or production deployment is part of this work.
