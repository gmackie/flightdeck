# Source governance, privacy and credential lifecycle

Flightdeck trusts **application Workers and Durable Objects**, not browsers. Authentication in the consumer is necessary but not sufficient: the Flightdeck core authenticates every source against a project-bound credential and validates a configurable source policy.

## Source registry entries

```json
{
  "checkout-worker": {
    "sha256": "<64 hex chars>",
    "rotatingSha256": [],
    "enabled": true,
    "projectId": "shop",
    "allowedEnvironments": ["production", "staging"],
    "allowedKinds": ["product", "exposure", "rum"],
    "consentRequired": false,
    "maxBatchSize": 100,
    "maxBatchBytes": 256000,
    "allowedEvents": ["page.viewed", "purchase.completed", "rum.*"],
    "allowedProperties": {
      "page.viewed": ["route"],
      "purchase.completed": ["total", "currency"],
      "rum.*": ["value", "rating", "metricId"]
    }
  }
}
```

All policies run after source authentication, before persistence. Unknown event names and top-level properties are denied, nested sensitive keys are denied, values have depth/size limits, route properties cannot contain URL query strings or absolute URLs, and event IDs cannot repeat within one batch.

Source rotation: generate a new 32-byte token, add its digest to `rotatingSha256`, deploy the registry secret, update all consuming Workers, then promote the new hash to `sha256` and remove the old hash. A disabled source is rejected even with valid credentials. Each hash belongs to exactly one configured project.

Consent: if `consentRequired` is enabled, the authenticated application must explicitly set `CaptureContext.consentGranted=true` from its own consent record. **Do not accept this assertion from a browser request.** The browser SDK also defaults to collecting nothing until the embedding application grants consent.

## Limitations / release gates

This initial policy is structural, **not a full PII detector**. Sensitive values stored under innocuous field names require an additional approved schema or tailored redaction. We still need per-source rate quotas, subject deletion/retention execution, D1 registry administration, and end-to-end privacy testing before claiming production compliance. Source credentials are currently stored in an account-owned Worker secret; never log or export plaintext tokens.
