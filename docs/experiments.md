# Experiment outcome analysis — Flagship remains separate

Flightdeck can compare observed per-variant exposure and business-outcome counts; **Flagship remains solely responsible for assignment, flag targeting, rollouts and changes** in the Cloudflare dashboard.

The first Flightdeck analysis path is observational. It identifies each actor's earliest `feature.exposed` event for the selected flag, then checks whether the chosen backend-authored goal event occurs after exposure within the analysis window. Subjects exposed to multiple variants are attributed only to their earliest observed exposure. Logical events are deduplicated by (project,source,event ID).

Analysis returns conversion rates, absolute and relative lift, approximate two-sided p-value, Newcombe-style confidence interval, and a sample-ratio-mismatch diagnostic under an assumed 50/50 allocation. It is **not** proof of randomization or causal effects. The API explicitly returns `randomizedAssignmentProven:false` and `causalClaim:false`.

To make causal claims in later releases, add versioned experiment assignments, stable unit IDs, audited randomization and eligibility, predefined primary metrics, guardrails, exclusions, expected allocation, sequential-testing policy and missing-outcome analysis. Flagship's SDK should emit actual use exposures rather than merely counting flag evaluation.

No auto-rollouts or Flagship write APIs are present in Flightdeck.
