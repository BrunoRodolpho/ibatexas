// Centralized Redis key factory.
// Every Redis key in the codebase must go through rk() — never build raw strings inline.
// Prepends `${APP_ENV}:` to prevent cross-environment key bleed when staging and
// production share a Redis instance (or when a backup is restored to a different env).
//
// APP_ENV must be set to 'development' | 'staging' | 'production'.
// Falls back to 'development' so local runs always work without extra config.

// Fail-fast if APP_ENV is missing in production to prevent cross-environment data bleed
if (process.env.NODE_ENV === "production" && !process.env.APP_ENV) {
  throw new Error("APP_ENV is required in production to prevent cross-environment data bleed");
}

const ENV_PREFIX: string = process.env.APP_ENV ?? "development";

/**
 * Namespace a Redis key with the current APP_ENV prefix.
 *
 * @example
 *   rk("customer:profile:cust_123")  // "production:customer:profile:cust_123"
 */
export function rk(key: string): string {
  return `${ENV_PREFIX}:${key}`;
}
