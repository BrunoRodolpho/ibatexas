// Centralized Redis key factory.
// Every Redis key in the codebase must go through rk() — never build raw strings inline.
// Prepends `${APP_ENV}:` to prevent cross-environment key bleed when staging and
// production share a Redis instance (or when a backup is restored to a different env).
//
// APP_ENV must be set to 'development' | 'staging' | 'production'.
// Falls back to 'development' so local runs always work without extra config.

// Fail-fast if APP_ENV is missing in production to prevent cross-environment
// data bleed. This guard stays at import time: production always sets APP_ENV
// before the process starts, so it never fires spuriously, and a production
// process running without APP_ENV must not boot at all.
if (process.env.NODE_ENV === "production" && !process.env.APP_ENV) {
  throw new Error("APP_ENV is required in production to prevent cross-environment data bleed");
}

/**
 * Namespace a Redis key with the current APP_ENV prefix.
 *
 * APP_ENV is read at CALL time, never captured at module import (FE-D26):
 * out-of-process tooling (the CLI's `loadTestEnv()`) sets APP_ENV AFTER this
 * module is first evaluated via a transitive `@ibatexas/tools` import, so a
 * module-level capture froze the stale `development` default — the CLI then
 * wrote `development:`-prefixed keys while the api read `test:`-prefixed ones
 * (invisible seeded carts + a phantom token-budget-counter reset). A lazy read
 * preserves behavior whenever APP_ENV is stable (set before the first call).
 *
 * @example
 *   rk("customer:profile:cust_123")  // "production:customer:profile:cust_123"
 */
export function rk(key: string): string {
  const envPrefix = process.env.APP_ENV ?? "development";
  return `${envPrefix}:${key}`;
}
