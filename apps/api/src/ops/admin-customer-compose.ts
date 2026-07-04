// admin-customer-compose.ts — the shared read-composition behind the OPS-070
// manager Customer view. It reimplements NO domain read: it calls each EXISTING
// @ibatexas/domain read (customer + preferences, addresses, recent order
// projections, loyalty balance) plus the broadcast opt-out registry ONCE and
// folds the returns into a compact, PII-shaped view object. VIEW-FIRST: nothing
// here mutates — every read is a pure findUnique/findMany or a Redis membership
// check (loyalty goes through `peekBalance`, which — unlike `getBalance` — never
// upserts, so opening a customer's profile never writes).
//
// The reads are INJECTED (accessors, like ops-snapshot-compose) so the route
// passes the real `@ibatexas/domain` factories + opt-out store while a unit test
// passes fakes (no DB, no Redis).
//
// Resilience: the customer record itself is the ANCHOR (fetched first — a null
// means 404, a throw means a genuine 500). The four SATELLITE reads (addresses,
// recent orders, loyalty, opt-out) are INDEPENDENT, run concurrently under
// `Promise.allSettled`, and each degrades to its empty/zero fallback on failure
// so one bad signal never fails the whole profile view.

import type {
  createCustomerService,
  createOrderQueryService,
  createLoyaltyService,
} from "@ibatexas/domain";

// ── View types (NOT domain state — a PII-shaped read projection) ─────────────

/** One saved delivery address (as displayed; no derived fields). */
export interface AdminCustomerAddress {
  readonly id: string;
  readonly street: string;
  readonly number: string;
  readonly complement: string | null;
  readonly district: string;
  readonly city: string;
  readonly state: string;
  readonly cep: string;
  readonly isDefault: boolean;
}

/** One recent order (compact projection headline — money in integer centavos). */
export interface AdminCustomerOrder {
  readonly id: string;
  readonly displayId: number;
  readonly fulfillmentStatus: string;
  readonly paymentStatus: string | null;
  readonly totalInCentavos: number;
  readonly itemCount: number;
  readonly deliveryType: string | null;
  readonly paymentMethod: string | null;
  readonly createdAt: string;
}

/** Punch-card loyalty balance (read-only; `exists=false` = no account yet). */
export interface AdminCustomerLoyalty {
  readonly stamps: number;
  readonly stampsNeeded: number;
  readonly totalEarned: number;
  readonly redeemed: number;
  readonly exists: boolean;
}

/** Dietary / allergen preferences, or null when the customer has none. */
export interface AdminCustomerPreferences {
  readonly dietaryRestrictions: readonly string[];
  readonly allergenExclusions: readonly string[];
  readonly favoriteCategories: readonly string[];
}

/** The composed single-customer manager view. */
export interface AdminCustomerDetail {
  readonly id: string;
  readonly name: string | null;
  readonly phone: string;
  readonly email: string | null;
  /** Raw CPF (unmasked at the boundary; the renderer masks it — never logged). */
  readonly cpf: string | null;
  readonly source: string | null;
  readonly firstContactAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly preferences: AdminCustomerPreferences | null;
  readonly addresses: readonly AdminCustomerAddress[];
  readonly recentOrders: {
    readonly orders: readonly AdminCustomerOrder[];
    readonly count: number;
  };
  readonly loyalty: AdminCustomerLoyalty;
  /** Broadcast (marketing) opt-out — the only governed customer write today. */
  readonly optedOutOfBroadcast: boolean;
}

// ── Injected dependencies ────────────────────────────────────────────────────

/** Minimal logger surface — only `.error` is used (a degraded satellite). */
export interface AdminCustomerComposeLog {
  error(obj: unknown, msg?: string): void;
}

export interface AdminCustomerDetailComposeDeps {
  readonly customerId: string;
  readonly customers: () => ReturnType<typeof createCustomerService>;
  readonly orders: () => ReturnType<typeof createOrderQueryService>;
  readonly loyalty: () => ReturnType<typeof createLoyaltyService>;
  /** Broadcast opt-out membership read (phone as recipient). Pure read. */
  readonly isOptedOut: (recipient: string) => Promise<boolean>;
  /** How many recent orders to include (default 10). */
  readonly recentOrdersLimit?: number;
  readonly log: AdminCustomerComposeLog;
}

// ── Resilient accessor (settle → value | log + fallback) ─────────────────────

function unwrap<T>(
  settled: PromiseSettledResult<T>,
  fallback: T,
  signal: string,
  log: AdminCustomerComposeLog,
): T {
  if (settled.status === "fulfilled") {
    return settled.value;
  }
  log.error(
    { err: settled.reason, signal },
    "admin-customer: satellite read failed — degrading to fallback",
  );
  return fallback;
}

const EMPTY_LOYALTY: AdminCustomerLoyalty = {
  stamps: 0,
  stampsNeeded: 0,
  totalEarned: 0,
  redeemed: 0,
  exists: false,
};

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

/**
 * Compose the single-customer manager view. Returns `null` when the id is
 * unknown (→ the route 404s). A satellite read failing degrades that section to
 * its empty/zero fallback; it never fails the whole view.
 */
export async function composeAdminCustomerDetail(
  deps: AdminCustomerDetailComposeDeps,
): Promise<AdminCustomerDetail | null> {
  const { customerId, log } = deps;
  const recentOrdersLimit = deps.recentOrdersLimit ?? 10;

  // Anchor read — the customer record itself (with preferences). A null id →
  // null (404). A throw is a genuine DB error → surfaces as a 500 upstream.
  const customer = await deps.customers().getByIdForAdmin(customerId);
  if (!customer) {
    return null;
  }

  // Four INDEPENDENT satellite reads, concurrent + individually degradable.
  const [addressesR, ordersR, loyaltyR, optOutR] = await Promise.allSettled([
    deps.customers().listAddresses(customerId),
    deps.orders().listByCustomer(customerId, { limit: recentOrdersLimit }),
    deps.loyalty().peekBalance(customerId),
    deps.isOptedOut(customer.phone),
  ]);

  const addresses = unwrap(addressesR, [], "addresses", log).map(
    (a): AdminCustomerAddress => ({
      id: a.id,
      street: a.street,
      number: a.number,
      complement: a.complement ?? null,
      district: a.district,
      city: a.city,
      state: a.state,
      cep: a.cep,
      isDefault: a.isDefault,
    }),
  );

  const ordersResult = unwrap(ordersR, { orders: [], count: 0 }, "orders", log);
  const recentOrders = {
    orders: ordersResult.orders.map(
      (o): AdminCustomerOrder => ({
        id: o.id,
        displayId: o.displayId,
        fulfillmentStatus: o.fulfillmentStatus,
        paymentStatus: o.paymentStatus ?? null,
        totalInCentavos: o.totalInCentavos,
        itemCount: o.itemCount,
        deliveryType: o.deliveryType ?? null,
        paymentMethod: o.paymentMethod ?? null,
        createdAt: toIso(o.medusaCreatedAt),
      }),
    ),
    count: ordersResult.count,
  };

  const loyalty = unwrap(loyaltyR, EMPTY_LOYALTY, "loyalty", log);
  const optedOutOfBroadcast = unwrap(optOutR, false, "optOut", log);

  const preferences: AdminCustomerPreferences | null = customer.preferences
    ? {
        dietaryRestrictions: customer.preferences.dietaryRestrictions,
        allergenExclusions: customer.preferences.allergenExclusions,
        favoriteCategories: customer.preferences.favoriteCategories,
      }
    : null;

  return {
    id: customer.id,
    name: customer.name ?? null,
    phone: customer.phone,
    email: customer.email ?? null,
    cpf: customer.cpf ?? null,
    source: customer.source ?? null,
    firstContactAt: customer.firstContactAt ? toIso(customer.firstContactAt) : null,
    createdAt: toIso(customer.createdAt),
    updatedAt: toIso(customer.updatedAt),
    preferences,
    addresses,
    recentOrders,
    loyalty: { ...loyalty },
    optedOutOfBroadcast,
  };
}
