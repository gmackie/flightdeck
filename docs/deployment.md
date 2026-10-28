# Account-owned installation RFC

Target: Coworkers-style installer with user-owned Cloudflare resources; **not implemented yet**.

1. Select account, domain, data residency, auth and optional AI functionality.
2. Preflight services and quota/costs; obtain narrowly scoped permissions.
3. Persist only non-secret resource identifiers in a gitignored deployment manifest.
4. Provision D1, R2, Basin and Workers, optional Queue/DO/AI/Workflows.
5. Deploy **fail closed**: console/control access locked until Access/OIDC verified, collector disabled until authorized project sources configured.
6. Apply migrations, verify bindings, smoke-test anonymous access denial, then activate routes.
7. Support repeatable upgrade, doctor, backup, restore and uninstall. Preserve data by default.

No one-click deployment should be advertised until fresh-account installation, recovery, security and cost tests pass.
