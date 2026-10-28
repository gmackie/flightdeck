# Workers AI journey interpretation (opt-in, experimental)

Flightdeck discovers patterns using deterministic directly-follows graph analysis. Workers AI may optionally **name** these graph patterns and propose hypotheses. AI doesn't receive raw user events, customer content or user-level timelines; it receives bounded aggregates and their observation counts.

- Set `AI_ENABLED=true` on your console only after enabling Workers AI and accepting costs/privacy policies.
- Bind `AI` as a Workers AI binding; set `AI_MODEL` to a structured-output model supported by your account (default `@cf/meta/llama-3.3-70b-instruct-fp8-fast`).
- The console's `POST /api/discover` endpoint requires a valid Cloudflare Access JWT, exact same-origin request and an account-configured AI feature flag. It calls Basin SQL for transition aggregates, then performs at most **3** model calls per request.
- All inferred titles, summaries, confidence and hypotheses undergo deterministic validation. Invalid model output becomes an unavailable-interpretation status, never executable code.
- The proposals are *not* deployed or saved as journey state machines automatically. An authorized human will need to review generated definitions before DOs may consume them.
- Deployments handling sensitive information should disable this feature until consent, prompt audit, quota/rate limiting, and model data-handling requirements are reviewed.

The graph is a directly-follows **aggregate**, not individual path reconstruction. Edge observation counts are not path conversion counts, and hypotheses are not causal claims.
