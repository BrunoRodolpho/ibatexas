// tests/e2e/fixtures/test-stack.ts — T2-7 e2e fixtures over the journeys
// test plane.
//
// The authed api-golden-path legs need exactly what JOURNEY-001's harness
// needs: the seeded customer's id (resolved through the SELECT-only oracle
// role) and a minted customer JWT cookie (the authFixture). Both live in
// @ibatexas/journeys — the SINGLE sanctioned implementation (its module
// header forbids re-declaring the minting logic anywhere else), so this file
// imports it rather than duplicating fast-jwt calls. tests/e2e is test
// plane → test plane: check-bypass leg 6 forbids apps/* and non-test
// packages/* from importing @ibatexas/journeys; the root e2e suite is
// neither.
//
// ENV CONTRACT (all from .env.test — source it before running playwright):
//   JWT_SECRET            the stack's generated customer-JWT secret
//   IBX_TEST_FINGERPRINT  containment gate — minting REFUSES without it
//   ORACLE_DATABASE_URL   SELECT-only oracle role (read-only by construction)
//
// Imports are dynamic (`await import`) so loading this file never hard-fails
// outside the e2e env: specs decide skip-vs-fail via missingE2EEnv() first
// (skip locally for DX, throw on CI so a misconfigured workflow can never
// silently green).

/** The env vars the authed e2e legs require (values come from .env.test). */
export const E2E_REQUIRED_ENV = [
  "JWT_SECRET",
  "IBX_TEST_FINGERPRINT",
  "ORACLE_DATABASE_URL",
] as const;

/**
 * Seeded customer used by the e2e suite: Pedro Rocha (SEED_CUSTOMERS[9],
 * packages/domain/src/seed-constants.ts). DELIBERATELY a different customer
 * from JOURNEY-001's Maria Silva (+5519900000001): e2e checkouts must never
 * perturb a journey's most-recent-order auto-resolution or share its
 * order-cancel rate-limit window if both suites ever run against one stack
 * (docs/agents/phase-1b-pending-push.md §6 records the same rule for any
 * second money flow).
 */
export const E2E_SEED_CUSTOMER_PHONE = "+5519900000010";

/**
 * Returns the first missing required env var, or null when the e2e stack
 * env is fully present. Specs: skip locally, hard-fail on CI.
 */
export function missingE2EEnv(): string | null {
  for (const name of E2E_REQUIRED_ENV) {
    const value = process.env[name];
    if (value === undefined || value.trim() === "") return name;
  }
  return null;
}

/**
 * Resolves the seeded e2e customer (read-only oracle lookup — never writes)
 * and mints their customer JWT cookie exactly as the API would issue it.
 * Returns the ready-to-send Cookie header value plus the customerId.
 */
export async function authenticatedCustomerFixture(): Promise<{
  customerId: string;
  cookie: string;
}> {
  const missing = missingE2EEnv();
  if (missing !== null) {
    throw new Error(
      `authenticatedCustomerFixture: ${missing} is not set — source .env.test ` +
        "(set -a; . ./.env.test; set +a) and run against the e2e test stack " +
        "(IBX_TEST_E2E=1 ./scripts/test-stack-up.sh)",
    );
  }

  const { createDomainReader, mintCustomerToken, cookieHeader } = await import(
    "@ibatexas/journeys"
  );

  const domain = createDomainReader();
  try {
    const customer = await domain.customerByPhone(E2E_SEED_CUSTOMER_PHONE);
    if (customer === null) {
      throw new Error(
        `authenticatedCustomerFixture: no customer with phone ${E2E_SEED_CUSTOMER_PHONE} — ` +
          "run `ibx test seed` (the fixture only resolves seeded rows, it never writes)",
      );
    }
    const minted = mintCustomerToken({
      customerId: customer.id,
      jwtSecret: process.env.JWT_SECRET as string,
    });
    return { customerId: customer.id, cookie: cookieHeader(minted) };
  } finally {
    await domain.close();
  }
}
