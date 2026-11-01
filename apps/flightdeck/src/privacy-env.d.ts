// Provision via Wrangler secret; absent deployments keep aggregate reads unavailable.
interface Env {
  LIFECYCLE_PRIVACY_KEY?: string;
}
