declare namespace Cloudflare {
  interface Env {
    TEST_LIFECYCLE_READ: import("@flightdeckhq/schema").LifecycleReadRpc;
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
  }
}
