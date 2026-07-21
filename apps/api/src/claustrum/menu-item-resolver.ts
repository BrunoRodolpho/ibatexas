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

// ── MENU_OVERVIEW — the menu-wide catalog listing (fixed subject) ────────────────
// A DISTINCT read path from the per-item resolver above: a wildcard catalog LISTING
// (the SAME `searchProducts({ query: "*" })` the catalog route uses — catalog.ts),
// not an NL item lookup. Composed into ONE pre-composed pt-BR scalar (`overviewText`)
// bound 1:1 to the MENU_OVERVIEW claim's C6 valueBinding. PUBLIC + FIXED-SUBJECT (like
// STORE_HOURS — no per-item resolver / no `perResourceKey`). Bounds keep a large
// catalog from blowing the rendered scalar / model context; the ordering is
// DETERMINISTIC (sorted by category then title, NOT the search ranking) so the
// investigator's recorded value and the claim planner's derived value are byte-equal.

/** Max items surfaced PER category (breadth), and the overall cap. */
const MENU_OVERVIEW_PER_CATEGORY = 4;
const MENU_OVERVIEW_MAX_ITEMS = 20;

/**
 * BKL-182 — the "cardápio" overview lists FOOD, not merch. These are the child
 * category handles under seed-data.ts's "Loja" tree (parent `loja`); items in
 * them (Avental/Boné/Camiseta…) are real catalog products but not menu items,
 * and the SCN-005 live drive showed them polluting the food overview. Filtered
 * at the COMPOSER (both call sites — investigator + claim planner — stay
 * byte-equal); explicit merch questions ride searchProducts, untouched.
 * DRIFT NOTE: adding a new merch child category to seed-data.ts "Loja" requires
 * adding its handle here (closed set — the composer only sees child handles).
 */
const NON_FOOD_CATEGORY_HANDLES: ReadonlySet<string> = new Set([
  "camisetas",
  "acessorios",
  "kits",
]);
/** How many published items to pull from the wildcard listing before bounding. */
const MENU_OVERVIEW_WILDCARD_LIMIT = 60;

/** MENU_OVERVIEW scalar: a bounded, DETERMINISTIC pt-BR list of first-party catalog
 *  titles + centavos prices, top-N per category. `undefined` for an empty catalog →
 *  the caller records NO evidence → honest UNKNOWN (never a fabricated menu). NO
 *  allergen/dietary info — first-party titles + prices only. Pure. */
export function composeMenuOverviewText(
  items: ReadonlyArray<Pick<ResolvedMenuItem, "title" | "price" | "categoryHandle">>,
): string | undefined {
  // BKL-182 — drop merch BEFORE composing: the food-only set drives the listing
  // AND the "e mais N itens" remainder count (a merch item must not inflate it).
  // An all-merch catalog composes `undefined` → NO evidence → honest UNKNOWN.
  const food = items.filter(
    (it) => !NON_FOOD_CATEGORY_HANDLES.has(it.categoryHandle ?? ""),
  );
  if (food.length === 0) return undefined;
  // Deterministic order — never the (non-deterministic) search ranking, so the two
  // call sites (investigator + planner) compose the IDENTICAL string.
  const sorted = [...food].sort((a, b) => {
    const ca = a.categoryHandle ?? "";
    const cb = b.categoryHandle ?? "";
    if (ca !== cb) return ca < cb ? -1 : 1;
    return a.title < b.title ? -1 : a.title > b.title ? 1 : 0;
  });
  // Top-N per category for breadth, capped at the overall bound.
  const perCat = new Map<string, number>();
  const picked: Array<{ title: string; price: number }> = [];
  for (const it of sorted) {
    if (picked.length >= MENU_OVERVIEW_MAX_ITEMS) break;
    const cat = it.categoryHandle ?? "";
    const n = perCat.get(cat) ?? 0;
    if (n >= MENU_OVERVIEW_PER_CATEGORY) continue;
    perCat.set(cat, n + 1);
    picked.push({ title: it.title, price: it.price });
  }
  if (picked.length === 0) return undefined;
  const parts = picked.map((p) => `${p.title} — ${formatCentavosBRL(p.price)}`);
  const remaining = food.length - picked.length;
  const more = remaining > 0 ? ` (e mais ${remaining} ${remaining === 1 ? "item" : "itens"} no cardápio)` : "";
  return `No nosso cardápio: ${parts.join("; ")}${more}.`;
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

// ── MENU_OVERVIEW per-turn memo + read ──────────────────────────────────────────
// FIXED subject (no per-item text) ⇒ the memo is keyed on turnId ALONE: ONE wildcard
// catalog read per turn, shared by the investigator (records evidence) and the claim
// planner (derives the candidate value), so their `overviewText` is byte-equal by
// construction. Bounded FIFO; turn-scoped (never leaks across turns).

const MENU_OVERVIEW_MEMO_MAX = 256;
const overviewMemo = new Map<string, Promise<string | undefined>>();

function overviewMemoSet(key: string, value: Promise<string | undefined>): void {
  overviewMemo.set(key, value);
  if (overviewMemo.size > MENU_OVERVIEW_MEMO_MAX) {
    const oldest = overviewMemo.keys().next().value;
    if (oldest !== undefined) overviewMemo.delete(oldest);
  }
}

/** Test-only: clear the per-turn overview memo between cases. */
export function __resetMenuOverviewMemoForTest(): void {
  overviewMemo.clear();
}

async function resolveOverviewUncached(ctx: MenuItemResolveContext): Promise<string | undefined> {
  let products: ReadonlyArray<ProductDTO> = [];
  try {
    // The SAME wildcard path the catalog route uses (query "*" ⇒ keyword-only, no
    // embedding — FE-D17-safe on a key-less box). searchProducts already filters to
    // published + in-stock. A read error → MISS → honest UNKNOWN (fail-closed).
    const out = await searchProducts(
      { query: "*", limit: MENU_OVERVIEW_WILDCARD_LIMIT },
      {
        channel: ctx.channel === "whatsapp" ? Channel.WhatsApp : Channel.Web,
        sessionId: ctx.sessionId ?? ctx.customerId,
        ...(isGuestCustomerId(ctx.customerId) ? {} : { userId: ctx.customerId }),
        userType: "customer",
      },
    );
    products = out.products ?? [];
  } catch {
    return undefined;
  }
  return composeMenuOverviewText(
    products.map((p) => ({ title: p.title, price: p.price, categoryHandle: p.categoryHandle })),
  );
}

/**
 * Resolve the menu-wide overview scalar for the given turn, or `undefined` when the
 * catalog is empty / unreadable (honest no-answer → UNKNOWN, never a fabricated menu).
 *
 * `turnId` scopes the memo: the investigator and the claim planner MUST pass the SAME
 * turnId (`cognition.turnId`) so they compose the IDENTICAL `overviewText` — the
 * fixed-subject twin of `resolveMenuItem`'s same-resolver-same-text invariant.
 */
export function resolveMenuOverviewText(
  turnId: string,
  ctx: MenuItemResolveContext,
): Promise<string | undefined> {
  const cached = overviewMemo.get(turnId);
  if (cached !== undefined) return cached;
  const pending = resolveOverviewUncached(ctx);
  overviewMemoSet(turnId, pending);
  return pending;
}

// ── MENU_DIETARY — dietary-PREFERENCE options (vegetariano / vegano) ──────────────
// BKL-214: a dietary-preference question ("tem opção vegetariana?") reads the products
// carrying the requested dietary TAG and lists them. RESTRICTED to the PURE-PREFERENCE
// tags {vegetariano, vegano}: `sem_gluten` / `sem_lactose` are ALLERGEN-ADJACENT medical
// territory (celiac / lactose-intolerance) — a "sem glúten" list is a "não contém glúten"
// assurance by another name, which the RATIFIED BKL-143/BKL-123 conservative rulings
// forbid, and the registry's own MENU_DIETARY_OPTIONS carve-out comment already gated.
// Those asks trip `ALLERGEN_FAMILY_RE` (glúten|lactose) in the span classifier and NEVER
// reach this read — they route to the conservative honest-abstain path. This claim only
// ever asserts a PREFERENCE attribute ("is tagged vegetarian"), never a health guarantee.

/** The dietary-PREFERENCE tags MENU_DIETARY may render. Deliberately EXCLUDES the
 *  allergen-adjacent `sem_gluten`/`sem_lactose` (BKL-143/123 conservative gate). */
export const DIETARY_PREFERENCE_TAGS = ["vegetariano", "vegano"] as const;
export type DietaryPreferenceTag = (typeof DIETARY_PREFERENCE_TAGS)[number];

/** pt-BR label for the rendered list header, per tag (plural, matches the tag noun). */
const DIETARY_TAG_LABEL: Readonly<Record<DietaryPreferenceTag, string>> = {
  vegetariano: "vegetarianas",
  vegano: "veganas",
};

/** Deterministically detect the requested dietary-PREFERENCE tags from the utterance.
 *  Disjoint stems (`vegan` ≠ `vegetari`); returns the tags present (usually one).
 *  Allergen-adjacent diets are NOT here (they route away before this is called). Pure. */
export function detectDietaryPreferenceTags(text: string): DietaryPreferenceTag[] {
  const t = text.toLowerCase();
  const tags: DietaryPreferenceTag[] = [];
  // `vegan` stem — "vegano"/"vegana"/"vegan"; NOT contained in "vegetariano". Check first.
  if (/\bvegan[ao]?\b/.test(t)) tags.push("vegano");
  if (/vegetarian[ao]?/.test(t)) tags.push("vegetariano");
  return tags;
}

/** How many published tagged items to pull before bounding the rendered list. */
const MENU_DIETARY_WILDCARD_LIMIT = 60;
const MENU_DIETARY_MAX_ITEMS = 20;

/** MENU_DIETARY scalar: a bounded DETERMINISTIC pt-BR list of first-party product titles
 *  carrying the requested dietary-PREFERENCE tag. `undefined` when NO published product
 *  carries the tag → the caller records NO evidence → honest UNKNOWN (never a fabricated
 *  "we have vegetarian options"). Titles only — NO price/allergen assertion. NEVER a
 *  "does not contain X" claim: a tag is a positive preference attribute, not a guarantee.
 *  Pure. */
export function composeDietaryOptionsText(
  tag: DietaryPreferenceTag,
  items: ReadonlyArray<Pick<ResolvedMenuItem, "title" | "categoryHandle">>,
): string | undefined {
  // Food only (drop the "Loja" merch tree — mirrors composeMenuOverviewText).
  const food = items.filter((it) => !NON_FOOD_CATEGORY_HANDLES.has(it.categoryHandle ?? ""));
  if (food.length === 0) return undefined;
  const sorted = [...food].sort((a, b) => (a.title < b.title ? -1 : a.title > b.title ? 1 : 0));
  const picked = sorted.slice(0, MENU_DIETARY_MAX_ITEMS);
  const remaining = food.length - picked.length;
  const more =
    remaining > 0 ? ` (e mais ${remaining} ${remaining === 1 ? "opção" : "opções"})` : "";
  return `Temos estas opções ${DIETARY_TAG_LABEL[tag]}: ${picked.map((p) => p.title).join("; ")}${more}.`;
}

// Per-turn dietary memo, keyed `${turnId}::${tag}` so investigator + planner compose the
// IDENTICAL scalar for a given tag (the same-resolver-same-text invariant, per tag).
const dietaryMemo = new Map<string, Promise<string | undefined>>();
function dietaryMemoSet(key: string, value: Promise<string | undefined>): void {
  dietaryMemo.set(key, value);
  if (dietaryMemo.size > MENU_ITEM_MEMO_MAX) {
    const oldest = dietaryMemo.keys().next().value;
    if (oldest !== undefined) dietaryMemo.delete(oldest);
  }
}
/** Test-only: clear the per-turn dietary memo between cases. */
export function __resetMenuDietaryMemoForTest(): void {
  dietaryMemo.clear();
}

async function resolveDietaryUncached(
  tag: DietaryPreferenceTag,
  ctx: MenuItemResolveContext,
): Promise<string | undefined> {
  let products: ReadonlyArray<ProductDTO> = [];
  try {
    // Faceted read: the SAME Typesense `tags` facet BKL-137 uses. Wildcard query +
    // tag filter ⇒ every published product carrying the preference tag. A read error →
    // MISS → honest UNKNOWN (fail-closed).
    const out = await searchProducts(
      { query: "*", tags: [tag], limit: MENU_DIETARY_WILDCARD_LIMIT },
      {
        channel: ctx.channel === "whatsapp" ? Channel.WhatsApp : Channel.Web,
        sessionId: ctx.sessionId ?? ctx.customerId,
        ...(isGuestCustomerId(ctx.customerId) ? {} : { userId: ctx.customerId }),
        userType: "customer",
      },
    );
    products = out.products ?? [];
  } catch {
    return undefined;
  }
  return composeDietaryOptionsText(
    tag,
    products.map((p) => ({ title: p.title, categoryHandle: p.categoryHandle })),
  );
}

/**
 * Resolve the dietary-options scalar for a given tag + turn, or `undefined` when no
 * product carries the tag (honest no-answer → UNKNOWN). `turnId` scopes the memo so the
 * investigator and the claim planner compose the IDENTICAL scalar for that tag.
 */
export function resolveDietaryOptionsText(
  turnId: string,
  tag: DietaryPreferenceTag,
  ctx: MenuItemResolveContext,
): Promise<string | undefined> {
  const key = `${turnId}::${tag}`;
  const cached = dietaryMemo.get(key);
  if (cached !== undefined) return cached;
  const pending = resolveDietaryUncached(tag, ctx);
  dietaryMemoSet(key, pending);
  return pending;
}
