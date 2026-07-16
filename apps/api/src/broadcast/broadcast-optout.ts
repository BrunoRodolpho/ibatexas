// Broadcast opt-out / marketing-consent registry (responder-trace-admin D3; WS3A).
//
// DURABLE source of truth: the `customer_broadcast_consent` table (one row per
// canonical E.164 phone). This REPLACES the former Redis-only SET, whose volatile
// nature meant a flush/eviction silently lost consent — a customer who opted out
// could then be blasted again (LGPD exposure). The DB is now authoritative.
//
// NOTE (design): a Redis read-through cache was specified as a perf optimization.
// It is intentionally DEFERRED — making Redis authoritative would reintroduce the
// exact flush-loses-consent bug this workstream fixes, and a manager-triggered
// blast is sequential + rate-limited, so per-recipient DB reads are acceptable.
//
// All phones are canonicalized with toE164BR (WS3B) so opt-out matching is
// format-independent (a "+55 11 99999-0000" opt-out matches a "+5511999990000"
// blast). Callers (admin routes, the clientes toggle, the inbound-STOP handler,
// and the send-time gate) all funnel through this one store.

import { toE164BR, prisma } from "@ibatexas/domain";

/**
 * WS3B — canonicalize a recipient to E.164 so opt-out matching is
 * FORMAT-INDEPENDENT. `toE164BR` throws on non-phone input; fall back to the
 * trimmed raw string so a malformed entry never crashes the store (it simply
 * won't cross-match, as before).
 */
export function normalizeRecipient(recipient: string): string {
  try {
    return toE164BR(recipient);
  } catch {
    return recipient.trim();
  }
}

export interface BroadcastOptOutStore {
  /** `source` records HOW the opt-out was set: 'admin' | 'inbound_stop' | 'clientes_toggle'. */
  optOut(recipient: string, source?: string): Promise<void>;
  optIn(recipient: string, source?: string): Promise<void>;
  isOptedOut(recipient: string): Promise<boolean>;
  list(): Promise<string[]>;
}

/** The durable consent operations, kept as a small injectable interface so tests
 *  can pass a fake without a database. */
export interface BroadcastConsentDb {
  getOptedOut(phone: string): Promise<boolean>;
  setOptedOut(phone: string, optedOut: boolean, source: string): Promise<void>;
  listOptedOut(): Promise<string[]>;
}

export function createBroadcastOptOutStore(db: BroadcastConsentDb): BroadcastOptOutStore {
  return {
    async optOut(recipient, source = "admin") {
      await db.setOptedOut(normalizeRecipient(recipient), true, source);
    },
    async optIn(recipient, source = "admin") {
      await db.setOptedOut(normalizeRecipient(recipient), false, source);
    },
    async isOptedOut(recipient) {
      return db.getOptedOut(normalizeRecipient(recipient));
    },
    async list() {
      return db.listOptedOut();
    },
  };
}

/** Prisma-backed consent store — the durable source of truth. */
function prismaConsentDb(): BroadcastConsentDb {
  return {
    async getOptedOut(phone) {
      const row = await prisma.customerBroadcastConsent.findUnique({
        where: { phone },
        select: { optedOut: true },
      });
      return row?.optedOut ?? false;
    },
    async setOptedOut(phone, optedOut, source) {
      await prisma.customerBroadcastConsent.upsert({
        where: { phone },
        create: { phone, optedOut, source },
        update: { optedOut, source },
      });
    },
    async listOptedOut() {
      const rows = await prisma.customerBroadcastConsent.findMany({
        where: { optedOut: true },
        select: { phone: true },
        orderBy: { updatedAt: "desc" },
      });
      return rows.map((r) => r.phone);
    },
  };
}

export async function getBroadcastOptOutStore(): Promise<BroadcastOptOutStore> {
  return createBroadcastOptOutStore(prismaConsentDb());
}

/** Loose logger shape — pino.Logger and FastifyBaseLogger both satisfy it. */
export type OptOutGateLogger = { warn: (...args: unknown[]) => void };

/**
 * Send-time consent gate for PROMOTIONAL / marketing WhatsApp sends (WS3 / LGPD).
 *
 * Returns `true` when the recipient has opted out of promotional messages and the
 * send MUST be suppressed. Reuses the SAME durable consent store
 * (`customer_broadcast_consent`) honored by the manager-triggered blast path, so
 * a customer who texted PARAR is respected on the AUTOMATED promo paths too
 * (cart-recovery, hesitation nudge, loyalty_reward, review prompts). The recipient
 * is canonicalized to E.164 by the store, so matching is format-independent.
 *
 * Call this ONLY for promotional categories. Transactional / operational messages
 * (OTP, payment confirmations/receipts, order-status updates, incident/staff
 * alerts) MUST NEVER be gated through here — suppressing one is a regression.
 *
 * FAIL-OPEN: a transient consent-read error must never block or crash a send. On
 * error we log a warning and return `false` (the send proceeds), so a DB blip
 * never costs a legitimate message. The `store` param is a test seam; production
 * callers pass only `(recipient, log)`.
 */
export async function shouldSuppressPromotionalSend(
  recipient: string,
  log?: OptOutGateLogger,
  store?: BroadcastOptOutStore,
): Promise<boolean> {
  try {
    const optOutStore = store ?? (await getBroadcastOptOutStore());
    return await optOutStore.isOptedOut(recipient);
  } catch (err) {
    log?.warn(
      { error: String(err) },
      "[broadcast-optout] promotional consent read failed — failing open (send proceeds)",
    );
    return false;
  }
}
