// store-info-resolver.ts — the SHARED claustrum-side store-info (address/parking)
// scalar resolver for the BKL-136 STORE_INFO claim ("onde fica o restaurante?" /
// "tem estacionamento?").
//
// WHY a SHARED per-turn-memoized resolver (the menu-item-resolver.ts discipline):
// the investigator's evidence read AND the claim planner's value derivation BOTH
// need the IDENTICAL `infoText` within a turn so the kernel's C6 compares byte-equal
// values (PASS by construction). The memo is keyed on turnId; both call sites pass
// `cognition.turnId`, so the ONE Medusa admin read serves both.
//
// DATA SOURCE: the Medusa store singleton's OWNER-ATTESTED `metadata.address` /
// `metadata.parking` (written by the committed seed — apps/commerce/src/seed.ts
// `ensureStore` — or by the owner via the Medusa admin). First-party config; PUBLIC
// (owned by nobody). ABSENT/blank metadata OR an unreadable store → `undefined` →
// the caller honestly degrades to UNKNOWN — never a fabricated address (the
// MENU_OVERVIEW empty/unreadable-catalog disposition).
//
// PURE-ish: the only IO is `medusaAdmin`. No clock/RNG. The memo is process-scoped
// and bounded; keyed by turnId so entries never leak across turns.

import { medusaAdmin } from "@ibatexas/tools";

/** The store-metadata shape this resolver reads (a subset of Medusa's free-form
 *  `store.metadata` record — both fields owner-authored strings). */
interface StoreInfoMetadata {
  readonly address?: unknown;
  readonly parking?: unknown;
}

/**
 * Compose the DETERMINISTIC pt-BR store-info scalar from the owner-attested
 * metadata fields. Address is the anchor: no non-blank address → `undefined`
 * (an address-less parking note would answer "onde fica?" with a non-answer).
 * Parking is appended only when present. Pure.
 */
export function composeStoreInfoText(meta: StoreInfoMetadata): string | undefined {
  const address = typeof meta.address === "string" ? meta.address.trim() : "";
  if (address === "") return undefined;
  const parking = typeof meta.parking === "string" ? meta.parking.trim() : "";
  const addressSentence = `Estamos em ${address}.`;
  if (parking === "") return addressSentence;
  return `${addressSentence} ${parking.endsWith(".") ? parking : `${parking}.`}`;
}

async function resolveStoreInfoUncached(): Promise<string | undefined> {
  try {
    // The store is a singleton (apps/commerce seed `ensureStore` — first store wins,
    // matching the seed's own duplicate-store disposition). A read error / empty
    // list / absent metadata → MISS → honest UNKNOWN (fail-closed, never fabricated).
    const out = (await medusaAdmin("/admin/stores?limit=1")) as {
      stores?: ReadonlyArray<{ metadata?: Record<string, unknown> | null }>;
    };
    const meta = out.stores?.[0]?.metadata;
    if (meta === undefined || meta === null) return undefined;
    return composeStoreInfoText(meta as StoreInfoMetadata);
  } catch {
    return undefined;
  }
}

const STORE_INFO_MEMO_MAX = 256;
const storeInfoMemo = new Map<string, Promise<string | undefined>>();

function storeInfoMemoSet(key: string, value: Promise<string | undefined>): void {
  storeInfoMemo.set(key, value);
  if (storeInfoMemo.size > STORE_INFO_MEMO_MAX) {
    const oldest = storeInfoMemo.keys().next().value;
    if (oldest !== undefined) storeInfoMemo.delete(oldest);
  }
}

/** Test seam — clear the per-turn memo between cases. */
export function clearStoreInfoMemoForTests(): void {
  storeInfoMemo.clear();
}

/**
 * Resolve the store-info scalar for the given turn, or `undefined` when the store
 * metadata is absent / unreadable (honest no-answer → UNKNOWN, never a fabricated
 * address). `turnId` scopes the memo: the investigator and the claim planner MUST
 * pass the SAME turnId (`cognition.turnId`) so they compose the IDENTICAL
 * `infoText` — the same-resolver-same-text invariant menu-item-resolver.ts pins.
 */
export function resolveStoreInfoText(turnId: string): Promise<string | undefined> {
  const cached = storeInfoMemo.get(turnId);
  if (cached !== undefined) return cached;
  const pending = resolveStoreInfoUncached();
  storeInfoMemoSet(turnId, pending);
  return pending;
}
