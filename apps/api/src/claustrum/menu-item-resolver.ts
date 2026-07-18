// menu-item-resolver.ts — the SHARED claustrum-side NL item-name → catalog product
// resolver for the BKL-142 menu-claims slice (MENU_ITEM_PRICE / MENU_ITEM_CONTENTS).
//
// WHY a SHARED per-turn-memoized resolver (the same discipline schedule-date-
// resolver.ts documents for the date chain): the resolved product `id` is BOTH the
// menu claim's `subject` (the claim planner parameterizes the candidate with it) AND
// the suffix of the investigator's per-resource ledger key (`menu:item_price:{id}` …).
// The claim planner's subject-resolution branch AND the investigator BOTH call THIS
// function over the SAME `perception.text` within a turn, so they resolve the
// IDENTICAL product and the kernel's evidence key matches the candidate subject BY
// CONSTRUCTION — never a divergence that would silently answer about the wrong item.
// The per-turn memo (keyed on turnId + normalized text) is what guarantees the two
// call sites see the SAME result even though `searchProducts` is not deterministic
// (network / cache / ranking): the first call resolves, the second reuses the memo.
//
// A within-turn disagreement is impossible by the memo; a MISS (no lexically-related
// product, or a catalog error) resolves to `undefined` → the caller honestly degrades
// to UNKNOWN, NEVER an arbitrary product (post-FE-D17: key-less boxes run keyword-only
// search, so a nonsense query returns no lexically-overlapping hit → `undefined`).
//
// LEXICAL-OVERLAP FLOOR (load-bearing — a twin of resolve-and-assemble.ts's private
// `hasLexicalOverlap`, deliberately NOT imported so the mutation path stays untouched):
// Typesense's fuzzy ranking always returns SOMETHING; without this floor a query like
// "xyzzy" would resolve to an arbitrary top hit and the customer would get a confident
// WRONG price. The floor rejects a hit that shares no token / containment with the
// query, collapsing it to the same `undefined` = honest no-match.
//
// PURE-ish: the only IO is `searchProducts`. No clock/RNG. The memo is process-scoped
// and bounded; it is keyed by turnId so entries never leak across turns.

import { searchProducts } from "@ibatexas/tools";
import { Channel, type ProductDTO } from "@ibatexas/types";

/** The resolved catalog product a menu claim binds its evidence to. First-party
 *  fields only; the caller composes the rendered scalar (priceText / contentsText). */
export interface ResolvedMenuItem {
  readonly id: string;
  readonly title: string;
  /** Integer centavos (Hard Rule #2) — the caller formats "R$89,00", never a float. */
  readonly price: number;
  readonly description: string | null;
  readonly categoryHandle: string | undefined;
  readonly inStock: boolean | undefined;
}

/** The channel + identity the resolver drives `searchProducts` with (mirrors the
 *  mutation-path `resolveProductForItem` context). */
export interface MenuItemResolveContext {
  readonly channel: string;
  readonly sessionId: string | undefined;
  readonly customerId: string;
}

// ── Lexical-overlap floor (twin of resolve-and-assemble.ts) ─────────────────────

function normalizeTokens(s: string): string[] {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

/** `true` iff the query shares at least one normalized token — or a title/query
 *  containment — with the product. Rejecting an unrelated top hit is the floor that
 *  keeps a fuzzy Typesense match from becoming a confident wrong answer. */
function hasLexicalOverlap(
  query: string,
  product: { title?: string; tags?: readonly string[] },
): boolean {
  const queryTokens = normalizeTokens(query);
  if (queryTokens.length === 0) return false;
  const queryTokenSet = new Set(queryTokens);
  const candidateTokens = new Set([
    ...normalizeTokens(product.title ?? ""),
    ...(product.tags ?? []).flatMap(normalizeTokens),
  ]);
  for (const t of queryTokenSet) {
    if (candidateTokens.has(t)) return true;
  }
  const queryNorm = queryTokens.join(" ");
  const titleNorm = normalizeTokens(product.title ?? "").join(" ");
  if (titleNorm.length === 0) return false;
  return titleNorm.includes(queryNorm) || queryNorm.includes(titleNorm);
}

/** Normalized memo key component — same normalization the floor uses, so two textually
 *  equivalent references ("Coca Cola" / "coca  cola") share ONE memo entry (and one read). */
function normalizeItemText(text: string): string {
  return normalizeTokens(text).join(" ");
}

function isGuestCustomerId(customerId: string): boolean {
  return customerId.startsWith("guest:");
}

// ── Deterministic scalar composers (renderer-sole-author C6 values) ─────────────
// The menu claims render ONE pre-composed pt-BR scalar bound 1:1 to the ledger
// (Inv 6 / C6). These composers are the SINGLE source of that scalar — called by
// BOTH the investigator (records the evidence) AND the claim planner (derives the
// candidate value), so the two are byte-equal by construction. Pure; first-party
// product fields only; NEVER model-authored.

/** Format integer centavos as pt-BR currency ("R$ 89,00", "R$ 1.234,50") — Hard
 *  Rule #2 (integer centavos, never floats). Pure. */
export function formatCentavosBRL(centavos: number): string {
  const cents = Math.round(centavos);
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const reais = Math.floor(abs / 100);
  const rem = abs % 100;
  const reaisGrouped = String(reais).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${sign}R$ ${reaisGrouped},${String(rem).padStart(2, "0")}`;
}

/** MENU_ITEM_PRICE scalar: "Costela Defumada custa R$ 89,00" — first-party title +
 *  centavos-formatted price. Deterministic; the C6-bound `priceText`. */
export function composeMenuPriceText(item: ResolvedMenuItem): string {
  return `${item.title} custa ${formatCentavosBRL(item.price)}`;
}

/** MENU_ITEM_CONTENTS scalar: the product's first-party description, prefixed with
 *  its title. When the catalog has no description, the composer returns `undefined`
 *  → the caller records NO evidence → honest UNKNOWN (never a fabricated blurb). */
export function composeMenuContentsText(item: ResolvedMenuItem): string | undefined {
  const desc = item.description?.trim();
  if (desc === undefined || desc.length === 0) return undefined;
  return `${item.title}: ${desc}`;
}

// ── Per-turn memo ───────────────────────────────────────────────────────────────
// Keyed `${turnId}::${normalizedText}` so the claim planner + investigator resolve
// IDENTICALLY within a turn (the same-resolver-same-text invariant) and entries never
// leak across turns. Stores the in-flight PROMISE so two concurrent call sites in the
// same turn coalesce onto ONE `searchProducts` read. Bounded FIFO — a runaway turn
// count can never grow it without bound.

const MENU_ITEM_MEMO_MAX = 512;
const memo = new Map<string, Promise<ResolvedMenuItem | undefined>>();

function memoSet(key: string, value: Promise<ResolvedMenuItem | undefined>): void {
  memo.set(key, value);
  if (memo.size > MENU_ITEM_MEMO_MAX) {
    const oldest = memo.keys().next().value;
    if (oldest !== undefined) memo.delete(oldest);
  }
}

/** Test-only: clear the per-turn memo between cases. */
export function __resetMenuItemMemoForTest(): void {
  memo.clear();
}

// ── The resolver ────────────────────────────────────────────────────────────────

async function resolveUncached(
  itemText: string,
  ctx: MenuItemResolveContext,
): Promise<ResolvedMenuItem | undefined> {
  let product: ProductDTO | undefined;
  try {
    const out = await searchProducts(
      { query: itemText },
      {
        channel: ctx.channel === "whatsapp" ? Channel.WhatsApp : Channel.Web,
        sessionId: ctx.sessionId ?? ctx.customerId,
        ...(isGuestCustomerId(ctx.customerId) ? {} : { userId: ctx.customerId }),
        userType: "customer",
      },
    );
    product = out.products?.[0];
  } catch {
    // A catalog read error is a MISS, never an arbitrary product — the caller degrades
    // to honest UNKNOWN (fail-closed).
    return undefined;
  }
  if (product === undefined) return undefined;
  // The load-bearing floor: an unrelated fuzzy top hit is treated as no match.
  if (!hasLexicalOverlap(itemText, product)) return undefined;
  return {
    id: product.id,
    title: product.title,
    price: product.price,
    description: product.description,
    categoryHandle: product.categoryHandle,
    inStock: product.inStock,
  };
}

/**
 * Resolve an NL item reference to a single catalog product for the given turn, or
 * `undefined` when nothing lexically-related matches (honest no-match → UNKNOWN).
 *
 * `turnId` scopes the memo: the claim planner and the investigator MUST pass the SAME
 * turnId (`cognition.turnId`) and the SAME raw text (`perception.text` item span) so
 * they resolve the IDENTICAL product — the invariant that makes the candidate subject
 * and the evidence ledger key match by construction.
 */
export function resolveMenuItem(
  turnId: string,
  itemText: string,
  ctx: MenuItemResolveContext,
): Promise<ResolvedMenuItem | undefined> {
  const norm = normalizeItemText(itemText);
  if (norm.length === 0) return Promise.resolve(undefined);
  const key = `${turnId}::${norm}`;
  const cached = memo.get(key);
  if (cached !== undefined) return cached;
  const pending = resolveUncached(itemText, ctx);
  memoSet(key, pending);
  return pending;
}
