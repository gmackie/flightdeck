# Evidence-based product investigations

An investigation starts from two bounded periods of **Basin aggregate data**, not user-identifiable sessions. Flightdeck computes deltas and their provenance, then optionally asks Workers AI to label hypotheses or propose human-reviewed next steps.

The model response must validate against a restrictive schema. Each hypothesis references one or more real evidence keys, carries confidence, and must not claim causation from correlation. Model-generated actions are only typed **proposals**: instrumentation, experiments, engineering review or documentation. Shell commands, arbitrary API calls, credential access and production changes are never model-executed.

Investigations and proposed actions persist in D1. Administrator approvals require Cloudflare Access, an allowlist, a written rationale, and a status transition in the audit log. Approval is a permission to hand work off to a designated coding agent or workflow—not a hidden autonomous deployment.

Operator controls: optional `AI_ENABLED` + bound Workers AI model, a daily investigation quota, project-scoped query limits, and evidence retention policies. See privacy RFC before enabling for sensitive installations.
