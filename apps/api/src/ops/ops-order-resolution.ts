// ops-order-resolution.ts — deterministic ops-plane order REFERENCE→id
// resolution (BKL-089, orders scope).
//
// The ops resolver's `order.note.add` / `order.status.transition` paths are
// id-literal: a payload `orderId` that is not a real order id projects
// `ctx.orderId: null` → pack-orders' `requireOrderIdForMutation` REFUSEs
// `no_order`. But staff speak the DISPLAY NUMBER ("avança o 4242") or a CUSTOMER
// NAME ("adiciona uma nota no pedido da Maria"), not the internal Medusa order id.
// This module resolves such a free-text reference to a concrete order
// DETERMINISTICALLY (no LLM in the path), so the ops resolver can rewrite the
// payload BEFORE adjudication — the SAME chat-plane BKL-028/061 posture the
// product path uses: enrich the payload deterministically, rebuild the envelope,
// and let the kernel's intentHash re-derivation cover the FINAL (resolved) payload.
//
// ── STRICTNESS BAR (higher than products — a wrong-order write is harmful) ────
// Resolution is fail-closed at every branch. It resolves ONLY on an unambiguous
// UNIQUE match; zero or multiple candidates ⇒ NO resolution (a discriminated
// result the caller honours by leaving the payload untouched → honest kernel
// REFUSE). A read throw degrades to "none" (logged).
//
// ── displayId (primary, "o 4242") ────────────────────────────────────────────
// `OrderProjection.displayId` mirrors Medusa's `order.display_id`, a per-store
// MONOTONIC auto-increment — it is NOT reset per day and is not reused, so a
// displayId identifies at most one order in practice (single-tenant today). The
// Prisma schema does NOT enforce `@unique` on `displayId` (only `@@index`), so we
// do NOT assume uniqueness: the injected read returns EVERY row with that
// displayId and we resolve ONLY when there is EXACTLY ONE. A numeric reference is
// therefore displayId-only — it never falls through to name matching. No recent-
// window scope is needed (displayIds are not reused), which keeps the flagship
// "avança o 4242" working for an order placed earlier in the day/week; the
// exactly-one guard is the defense against a theoretical duplicate.
//
// ── customer name (secondary, "o pedido da Maria") ───────────────────────────
// Matched ONLY against RECENT ACTIVE (non-terminal) orders — a terminal order
// (`delivered` / `canceled`) is NEVER matched by name (this module re-checks
// terminality via `isTerminalOrderStatus` even though the injected read is
// expected to be pre-scoped to active orders — defense in depth). Matching is
// stricter than the product path: an EXACT normalized-name match wins, else a
// unique TOKEN-SUBSET match (every query token is a whole token of the candidate
// name, or vice-versa — bidirectional), so "maria" resolves "Maria Silva" but
// "ana" never resolves "Joana". Zero or multiple active matches ⇒ NO resolution.

import {
  isKnownOrderStatus,
  isTerminalOrderStatus,
  type OrderFulfillmentStatus,
} from "@ibatexas/types";
import { logger } from "../lib/logger.js";

/**
 * A candidate order the resolver can resolve to. Carries the matching keys
 * (`displayId` + `customerName`) AND the full state-projection subset the ops
 * resolver builds `OrderState` from (so a resolved match needs NO re-fetch —
 * mirrors how the product path builds `product` straight from the candidate).
 * `fulfillmentStatus` is BOTH the terminal-exclusion key for name matching and
 * the CURRENT status the BKL-090 legality guard reads.
 */
export interface OrderCandidate {
  readonly id: string;
  readonly displayId: number;
  readonly customerName: string | null;
  readonly fulfillmentStatus: string | null;
  readonly customerId: string | null;
  readonly paymentMethod: string | null;
  readonly paymentStatus: string | null;
  readonly totalInCentavos: number;
}

/** Which reference kind a resolution was attempted / succeeded through. */
export type OrderRefKind = "displayId" | "customer_name";

/**
 * The injected first-party order reads. Both degrade to a "none" resolution when
 * they throw (caught in {@link resolveOrderByReference}).
 *   - `findByDisplayId` — every order with that displayId (production: the domain
 *     `OrderQueryService.findByDisplayId`, an indexed exact-equality read).
 *   - `listRecentActive` — recent, non-terminal orders for name matching
 *     (production: `OrderQueryService.listAll` over a recent window; this module
 *     re-filters terminal defensively).
 */
export interface OrderReferenceReads {
  readonly findByDisplayId: (
    displayId: number,
  ) => Promise<readonly OrderCandidate[]>;
  readonly listRecentActive: () => Promise<readonly OrderCandidate[]>;
}

/** A discriminated resolution outcome — the caller NEVER guesses on none/ambiguous. */
export type OrderResolution =
  | { readonly kind: "resolved"; readonly via: OrderRefKind; readonly order: OrderCandidate }
  | { readonly kind: "none"; readonly via: OrderRefKind | null }
  | { readonly kind: "ambiguous"; readonly via: OrderRefKind; readonly candidates: readonly OrderCandidate[] };

/**
 * Deterministic name normalization: NFD diacritic-strip → lowercase → collapse
 * internal whitespace runs → trim. Applied identically to the query reference and
 * every candidate name so matching is diacritic- and case-insensitive
 * ("José" ≡ "jose", "  Maria  Silva " ≡ "maria silva").
 */
export function normalizeOrderRef(raw: string): string {
  return raw
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Parse a reference as a displayId: strip a single optional leading `#`, then
 * require an all-digits string within the Postgres `int4` range (displayId is an
 * `Int` column). Returns the number, or `null` when the reference is not a plain
 * positive integer (⇒ the caller treats it as a name). A leading-zero form
 * ("04242") parses to its numeric value.
 */
export function parseDisplayIdRef(raw: string): number | null {
  const s = raw.trim().replace(/^#/, "").trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n <= 0 || n > 2_147_483_647) return null;
  return n;
}

/** Whitespace-delimited normalized tokens of a name (empty tokens dropped). */
function nameTokens(raw: string): string[] {
  const n = normalizeOrderRef(raw);
  return n === "" ? [] : n.split(" ");
}

/** True when every token of `a` is a whole token of `b`. */
function tokensSubset(a: readonly string[], b: readonly string[]): boolean {
  if (a.length === 0) return false;
  const set = new Set(b);
  return a.every((t) => set.has(t));
}

/**
 * BKL-150(a) — does the CURRENT staff message contain the order REFERENCE the
 * model put in the payload? A deterministic anti-bleed check reusing this
 * module's own reference forms (the ops resolver honors a model-supplied
 * `orderId` ONLY when it is grounded in the current message; a reference the
 * message does not contain is a cross-turn bleed to drop):
 *   - a DISPLAY-ID number (`parseDisplayIdRef`) must appear as a STANDALONE
 *     integer token (optional leading `#` / leading zeros), never a digit
 *     substring of a larger number;
 *   - a NAME / free-text reference must have EVERY normalized token
 *     (`normalizeOrderRef`) present as a WHOLE token of the normalized message
 *     — the same whole-token idiom `resolveByCustomerName` uses, so "ana" never
 *     matches "banana" and a full-name ref the message only half-names is not
 *     falsely honored.
 * Returns `false` for an empty message or empty reference (the caller treats an
 * absent message as "cannot classify" and keeps the legacy honor-the-ref path).
 */
export function orderReferenceAppearsInMessage(
  rawRef: string,
  messageText: string,
): boolean {
  const text = messageText.trim();
  if (text === "" || rawRef.trim() === "") return false;

  const displayId = parseDisplayIdRef(rawRef);
  if (displayId !== null) {
    return new RegExp(`(?<!\\d)#?0*${displayId}(?!\\d)`).test(text);
  }

  const refTokens = nameTokens(rawRef);
  if (refTokens.length === 0) return false;
  const messageTokens = new Set(nameTokens(text));
  return refTokens.every((t) => messageTokens.has(t));
}

/** Keep only well-formed candidates (the read is first-party but its runtime
 *  shape is not guaranteed by the type system). */
function validCandidates(
  candidates: readonly OrderCandidate[],
): readonly OrderCandidate[] {
  return candidates.filter(
    (c) =>
      typeof c.id === "string" &&
      c.id.length > 0 &&
      typeof c.displayId === "number",
  );
}

/** True when a candidate's status is a KNOWN non-terminal status (active). An
 *  unknown/null status is treated as NOT active (fail-closed) so name matching
 *  never targets an order we cannot confirm is in flight. */
function isActiveOrder(c: OrderCandidate): boolean {
  const s = c.fulfillmentStatus;
  return (
    typeof s === "string" &&
    isKnownOrderStatus(s) &&
    !isTerminalOrderStatus(s as OrderFulfillmentStatus)
  );
}

/** Resolve a numeric reference by displayId — exactly-one wins, else none/ambiguous. */
async function resolveByDisplayId(
  displayId: number,
  reads: OrderReferenceReads,
): Promise<OrderResolution> {
  let rows: readonly OrderCandidate[];
  try {
    rows = await reads.findByDisplayId(displayId);
  } catch (err) {
    logger.warn(
      { component: "ops-order-resolution", via: "displayId", err: (err as Error).message },
      "order displayId lookup failed — treating as no resolution (fail-closed)",
    );
    return { kind: "none", via: "displayId" };
  }
  const valid = validCandidates(rows).filter((c) => c.displayId === displayId);
  if (valid.length === 1) return { kind: "resolved", via: "displayId", order: valid[0]! };
  if (valid.length > 1) return { kind: "ambiguous", via: "displayId", candidates: valid };
  return { kind: "none", via: "displayId" };
}

/** Resolve a name reference against recent ACTIVE orders — unique exact, else
 *  unique token-subset; zero/multiple ⇒ none/ambiguous. */
async function resolveByCustomerName(
  reference: string,
  reads: OrderReferenceReads,
): Promise<OrderResolution> {
  const q = normalizeOrderRef(reference);
  if (q === "") return { kind: "none", via: "customer_name" };

  let rows: readonly OrderCandidate[];
  try {
    rows = await reads.listRecentActive();
  } catch (err) {
    logger.warn(
      { component: "ops-order-resolution", via: "customer_name", err: (err as Error).message },
      "recent-active order lookup failed — treating as no resolution (fail-closed)",
    );
    return { kind: "none", via: "customer_name" };
  }

  // Active, named candidates only — a terminal order is NEVER matched by name.
  const active = validCandidates(rows).filter(
    (c) => isActiveOrder(c) && typeof c.customerName === "string" && normalizeOrderRef(c.customerName) !== "",
  );

  // 1) EXACT normalized-name match.
  const exact = active.filter((c) => normalizeOrderRef(c.customerName as string) === q);
  if (exact.length === 1) return { kind: "resolved", via: "customer_name", order: exact[0]! };
  if (exact.length > 1) return { kind: "ambiguous", via: "customer_name", candidates: exact };

  // 2) Unique bidirectional TOKEN-SUBSET match (stricter than raw substring: a
  //    query token must be a WHOLE token of the candidate name — "ana" ⊄ "joana").
  const qTokens = nameTokens(q);
  const tokenMatches = active.filter((c) => {
    const cTokens = nameTokens(c.customerName as string);
    return tokensSubset(qTokens, cTokens) || tokensSubset(cTokens, qTokens);
  });
  if (tokenMatches.length === 1) return { kind: "resolved", via: "customer_name", order: tokenMatches[0]! };
  if (tokenMatches.length > 1) return { kind: "ambiguous", via: "customer_name", candidates: tokenMatches };

  return { kind: "none", via: "customer_name" };
}

/**
 * Resolve a free-text order reference to a single order, STRICTLY and
 * DETERMINISTICALLY (see the module header). A numeric reference (optionally
 * `#`-prefixed) resolves by displayId ONLY; anything else is matched by customer
 * name against recent active orders. Returns a discriminated {@link
 * OrderResolution}; never throws (a read throw → none, logged fail-closed).
 */
export async function resolveOrderByReference(
  reference: string,
  reads: OrderReferenceReads,
): Promise<OrderResolution> {
  if (normalizeOrderRef(reference) === "") return { kind: "none", via: null };

  const displayId = parseDisplayIdRef(reference);
  if (displayId !== null) {
    // Numeric ⇒ displayId-only; a name never looks like a bare integer.
    return resolveByDisplayId(displayId, reads);
  }
  return resolveByCustomerName(reference, reads);
}

/** Which reference kind a "most recent" resolution was attempted through. */
export type MostRecentOrderResolution =
  | { readonly kind: "resolved"; readonly order: OrderCandidate }
  | { readonly kind: "none" };

/**
 * FE-T05 — resolve "the most recent order" DETERMINISTICALLY: the first
 * ACTIVE (non-terminal) candidate in `listRecentActive()`'s result. The
 * production read orders by `medusaCreatedAt DESC` (see the `orderCmdSvc`
 * wiring in `claustrum-bootstrap.ts`), so the first row IS the most recent —
 * this resolver additionally re-filters to active-only (defense in depth,
 * mirroring `resolveByCustomerName`'s posture) rather than trust the read's
 * pre-scoping.
 *
 * This is a GUESS, never an explicit reference — the caller is expected to
 * tag its provenance `grounded` (never `authoritative`) and force a
 * confirmation (FE-1.5). A read throw or an empty active set degrades to
 * `{kind:"none"}` (fail-closed — never silently pick a stale/terminal order).
 */
export async function resolveMostRecentActiveOrder(
  reads: OrderReferenceReads,
): Promise<MostRecentOrderResolution> {
  let rows: readonly OrderCandidate[];
  try {
    rows = await reads.listRecentActive();
  } catch (err) {
    logger.warn(
      { component: "ops-order-resolution", via: "most_recent", err: (err as Error).message },
      "most-recent-active order lookup failed — treating as no resolution (fail-closed)",
    );
    return { kind: "none" };
  }
  const active = validCandidates(rows).filter(isActiveOrder);
  const mostRecent = active[0];
  return mostRecent === undefined ? { kind: "none" } : { kind: "resolved", order: mostRecent };
}
