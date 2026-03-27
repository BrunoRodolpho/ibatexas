// Welcome credit utility — Redis-backed coupon for first-time customers.
//
// Lives in packages/tools (not apps/api) so it can be imported by the
// create_checkout tool without circular dependencies.
//
// NOTE: The coupon code "BEMVINDO15" must be created in Medusa admin
// with a R$15 fixed discount before going live.

import { getRedisClient } from "../redis/client.js";
import { rk } from "../redis/key.js";

/**
 * Retrieve and atomically consume the welcome credit for a customer.
 * Returns the coupon code if available, null if already used or not set.
 * Deletes the key after reading to prevent double-apply.
 */
export async function getAndConsumeWelcomeCredit(customerId: string): Promise<string | null> {
  const redis = await getRedisClient();
  const code = await redis.getDel(rk(`welcome:credit:${customerId}`));
  return code ?? null;
}
