// Welcome credit utility — Redis-backed coupon for first-time customers.
//
// Lives in packages/tools (not apps/api) so it can be imported by the
// create_checkout tool without circular dependencies.
//
// The coupon this reads is a DECLARED EXTERNAL REFERENCE (LE2-018):
// `promotion.welcome-credit` in @ibatexas/catalog's src/external-references.ts,
// sourced from WELCOME_CREDIT_COUPON_CODE. Its existence in Medusa is verified
// at api boot and by `ibx catalog check --live`, which is what retired the
// "must be created in Medusa admin before going live" note that used to stand
// here. This function does not resolve the code itself — it returns whatever
// was granted, so a code rotated mid-TTL still redeems for the customer who
// was promised it.

import { getRedisClient } from "../redis/client.js";
import { rk } from "../redis/key.js";

/**
 * Retrieve and atomically consume the welcome credit for a customer.
 * Returns the coupon code if available, null if already used or not set.
 * Deletes the key after reading to prevent double-apply.
 */
export async function getAndConsumeWelcomeCredit(customerId: string): Promise<string | null> {
  const redis = await getRedisClient();
  const code = await redis.get(rk(`welcome:credit:${customerId}`));
  if (code) {
    await redis.del(rk(`welcome:credit:${customerId}`));
  }
  return code;
}
