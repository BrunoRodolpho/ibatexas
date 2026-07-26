// pix-payer-identity.ts — BKL-230 (chat-wiring slice).
//
// Resolves the PIX payer identity (name / email / taxId) for a CONVERSATIONAL
// `order.checkout.create` execution, server-side, from the SESSION's
// authenticated customerId.
//
// WHY THIS EXISTS. `createCheckout` (packages/tools/src/cart/create-checkout.ts)
// hard-requires `extra.customerName || extra.customerEmail` before it will
// confirm a PIX PaymentIntent — Stripe's PIX confirm needs payer identity. The
// HTTP cart route always supplied it (`resolvePixBillingDetails`, routes/cart.ts),
// but the chat/WhatsApp plane's registry executor called
// `createCheckout(input, ctx)` with NO third argument, so every chat PIX
// checkout died on that guard: the customer got "Nome e email são obrigatórios
// para pagamento PIX.", no QR was ever minted, `metadata.cartId` was never
// written, no `payment_intent.succeeded` ever fired, and no order ever landed.
//
// WHY IT IS RESOLVED HERE AND NOT EXTRACTED FROM THE UTTERANCE. name / email /
// CPF are PII. `order-checkout-create.schema.ts` DELIBERATELY never declares a
// `pixDetails` field — `email`/`cpf` are FORBIDDEN_EXTRACTION_FIELD_NAMES at any
// trustClass, and `assertSoundExtractionSchema` fails the import if they ever
// appear. So the model never sees, is never asked for, and can never supply this
// identity. It is filled from stores the customer already populated through an
// authenticated surface. Fixing the gap on the executor side keeps that PII
// posture exactly as-is: nothing is added to any extraction schema or prompt.
//
// TRUST BOUNDARY. The only input is `customerId`, which the executor takes from
// `AgentContext.customerId` — derived by `agentCtxFromCapsule` from
// `Capsule.customerId` (the session's authenticated identity, with guest/anon
// markers stripped). No caller-, payload-, or model-supplied identifier is ever
// consulted, so a turn can only ever resolve its OWN customer's stored details;
// there is no argument through which another customer's could be selected.
// `OrderCheckoutCreatePayload.pixDetails` is deliberately IGNORED on this plane
// even though the type allows it — the web route fills that field for its own
// direct `createCheckout` call, and honoring it here would create a payload-
// shaped channel into Stripe's payer identity that the chat plane does not need.
//
// A session with no authenticated customer (guest) resolves to EMPTY and the
// EXISTING guard in create-checkout.ts fails the checkout with its existing
// pt-BR message. Identity is never fabricated to get past the guard.

import { createCustomerService } from "@ibatexas/domain";
import { getRedisClient, rk } from "@ibatexas/tools";
import { isGuestCustomerId } from "./guest-identity.js";

/**
 * The `extra` shape `createCheckout`'s PIX branch reads. Field names mirror it
 * exactly so the resolved value can be handed over without a rename.
 */
export interface PixPayerIdentity {
  readonly customerName?: string;
  readonly customerEmail?: string;
  readonly customerTaxId?: string;
}

/** Sliding TTL on the saved-PIX-details hash — matches routes/cart.ts's
 *  `PIX_CACHE_TTL` so a chat checkout refreshes the same 90-day window a web
 *  checkout does (a customer who only ever pays via chat must not have their
 *  saved details expire sooner than one who pays on the web). */
const PIX_CACHE_TTL = 90 * 86400;

/** Drop empty / whitespace-only stored values so they can never satisfy
 *  create-checkout's `extra.customerName || extra.customerEmail` guard with a
 *  blank string. `cachePixDetailsForCustomer` writes `""` for absent fields
 *  into the Prisma row via the save envelope, so this is a real case. */
function clean(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * Tier 1 — the customer's EXPLICIT saved PIX details: the Redis hash
 * `customer:pix:<customerId>` that `cachePixDetailsForCustomer` (routes/cart.ts)
 * writes alongside its `customer.pix.details.save` envelope. This is the only
 * store in the system that holds "the identity this customer chose to pay PIX
 * with" as distinct from their profile, and the only one carrying `cpf`/taxId
 * as a PIX-specific value.
 */
async function loadSavedPixDetails(
  customerId: string,
): Promise<PixPayerIdentity> {
  try {
    const redis = await getRedisClient();
    const key = rk(`customer:pix:${customerId}`);
    const hash = await redis.hGetAll(key);
    if (!hash || Object.keys(hash).length === 0) return {};
    // Mirror the web route: a read refreshes the sliding window.
    await redis.expire(key, PIX_CACHE_TTL);
    return {
      ...(clean(hash.name) ? { customerName: clean(hash.name)! } : {}),
      ...(clean(hash.email) ? { customerEmail: clean(hash.email)! } : {}),
      ...(clean(hash.cpf) ? { customerTaxId: clean(hash.cpf)! } : {}),
    };
  } catch {
    // Best-effort: a Redis outage must not also cost us the profile fallback
    // below, so this is caught per-source rather than around both tiers.
    return {};
  }
}

/**
 * Tier 2 — the authenticated customer's stored profile (`Customer.name` /
 * `.email` / `.cpf`). Note these are the SAME columns `performUpdatePixDetails`
 * writes, so at the durable layer "saved PIX details" and "profile" are not
 * distinguishable; the Redis hash above is the only genuinely PIX-specific
 * tier. This tier is what makes a chat PIX checkout work for a customer who
 * onboarded (name + email verified) but never completed a web PIX checkout.
 */
async function loadProfileIdentity(
  customerId: string,
): Promise<PixPayerIdentity> {
  try {
    const customer = await createCustomerService().getById(customerId);
    const cpf = (customer as Record<string, unknown>)["cpf"] as
      | string
      | null
      | undefined;
    return {
      ...(clean(customer.name) ? { customerName: clean(customer.name)! } : {}),
      ...(clean(customer.email) ? { customerEmail: clean(customer.email)! } : {}),
      ...(clean(cpf) ? { customerTaxId: clean(cpf)! } : {}),
    };
  } catch {
    return {};
  }
}

/**
 * Resolve the PIX payer identity for a chat-plane checkout.
 *
 * PRECEDENCE — per FIELD, saved PIX details win over the profile fallback:
 *   1. `customer:pix:<customerId>` (explicit saved PIX details, incl. taxId)
 *   2. `Customer.name` / `.email` / `.cpf` (authenticated profile)
 *
 * The merge is per-field rather than first-tier-wins-wholesale: a hash holding
 * only a `cpf` must not blank out a name+email the profile has, which is
 * precisely the combination that would otherwise still hit the PIX guard and
 * fail the checkout. (routes/cart.ts's `loadCachedPixDetails` returns on the
 * first non-empty hash instead; this slice does not change that web-plane
 * behavior, so the chat resolver is a strict superset of it.)
 *
 * Stored values are NOT re-validated. Both tiers were written through
 * authenticated surfaces that already validated at the trust boundary (the web
 * route's `isValidCpf`/`normalizeCpf` before caching; the onboarding pack's
 * CPF-shape guard on the `customer.pix.details.save` envelope) — same posture as
 * the web route, which likewise passes `cached?.cpf` straight through.
 *
 * @param customerId the SESSION's customer id (`AgentContext.customerId`). A
 *   guest / anon / absent id resolves to `{}`, preserving create-checkout's
 *   existing honest failure.
 */
export async function resolvePixPayerIdentity(
  customerId: string | undefined,
): Promise<PixPayerIdentity> {
  if (isGuestCustomerId(customerId)) return {};
  const id = customerId as string;

  const [saved, profile] = await Promise.all([
    loadSavedPixDetails(id),
    loadProfileIdentity(id),
  ]);

  const customerName = saved.customerName ?? profile.customerName;
  const customerEmail = saved.customerEmail ?? profile.customerEmail;
  const customerTaxId = saved.customerTaxId ?? profile.customerTaxId;

  return {
    ...(customerName ? { customerName } : {}),
    ...(customerEmail ? { customerEmail } : {}),
    ...(customerTaxId ? { customerTaxId } : {}),
  };
}
