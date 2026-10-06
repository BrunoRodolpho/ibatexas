// R3-S2 — the coverage contract for the resolver→guard honesty-floor channel.
//
// `resolution-signals.ts` exists to make ONE class of defect impossible: the
// resolve stage stamps `ctx.<flag>` and a guard reads it back, both ends spelling
// the key as a bare string on a `Record<string, unknown>`. Every one of those
// guards is LENIENT WHEN ABSENT (no key ⇒ null ⇒ PASS), so a typo on either end
// compiled clean and left the guard SILENTLY INERT — an un-guarded EXECUTE against
// a guessed money target, or a lost honesty floor that ships a found-implying
// "Confirma?" for an item that was never found.
//
// The primary defence is the COMPILE-TIME property (rename a signal in the
// contract ⇒ tsc breaks the stamp site AND the guard read; an undeclared key
// cannot be spelled through the accessors). tsc, not a test, is what enforces
// that. This file covers the three things tsc cannot say:
//
//   1. THE WIRE IS UNCHANGED — the accessors put/read the same literal ctx keys
//      the channel has always used (hard-coded here, NOT derived from the
//      interface, so a contract rename fails HERE instead of silently renaming a
//      key that external consumers and a published pack's typed field read).
//   2. EVERY DECLARED SIGNAL HAS A REAL READER — driven through the PRODUCTION
//      guard, not a replica. A signal with a stamp and no reader is a floor the
//      resolver believes it raised and nothing enforces.
//   3. THE ABSENT-KEY DIRECTION IS PASS, per guard-facing reader — the property
//      that makes these guards safe to prepend to every pack, and the one a
//      behaviour-preserving conversion could most easily have flipped.
//
// Division of labour: that each PRODUCTION stamp site fires on the right turn is
// resolve-and-assemble.test.ts's job (it drives `resolveAndAssemble` end to end);
// that the composed ladder orders these guards correctly is
// compose-policy-packs.test.ts's. This file pins the CHANNEL between them.

import { describe, expect, it } from "vitest";
import { buildEnvelope, type IntentEnvelope } from "@adjudicate/core";
import { adjudicate } from "@adjudicate/core/kernel";
import type { Guard } from "@adjudicate/core/kernel";
import {
  ordersPolicyBundle,
  type OrderIntentKind,
  type OrderPayload,
  type OrderState,
} from "@ibatexas/pack-orders";
import {
  IBATEXAS_ADOPTER_BUSINESS_GUARDS,
  SESSION_TOKEN_BUDGET,
  confirmOnAutoResolveGuard,
  refuseAllergenMentionGuard,
  refuseUnresolvedAmendItemGuard,
  refuseUnresolvedReviewProductGuard,
  sessionTokenBudgetGuard,
} from "../compose-policy-packs.js";
import {
  ALLERGEN_MENTION_DETECTED,
  AMEND_ITEM_UNRESOLVED,
  AUTO_RESOLVED_MONEY_REF,
  RESOLUTION_SIGNAL_NAMES,
  REVIEW_PRODUCT_UNRESOLVED,
  SESSION_TOKENS_CONSUMED,
  STAY_HOME_DELIVERY_MARKER,
  readResolutionSignal,
  resolutionSignalIsSet,
  stampResolutionSignal,
  type ResolutionSignalName,
  type ResolutionSignalSink,
  type ResolutionSignals,
} from "../resolution-signals.js";

const envelopeFor = (kind: string, payload: Record<string, unknown> = {}) =>
  buildEnvelope({
    kind,
    payload,
    actor: { principal: "llm", sessionId: "s-r3s2" },
    taint: "UNTRUSTED",
    nonce: `n-${kind}`,
    createdAt: "2026-05-22T12:00:00.000Z",
  });

/**
 * The same envelope, typed for the PACK bundle (`adjudicate` pins K to the pack's
 * own `OrderIntentKind`, unlike the adopter guards' erased `Guard<string, …>`).
 * Mirrors pack-orders' own test helper.
 */
const orderEnvelopeFor = (
  kind: OrderIntentKind,
  payload: Record<string, unknown>,
): IntentEnvelope<OrderIntentKind, OrderPayload> =>
  buildEnvelope({
    kind,
    payload: payload as OrderPayload,
    actor: { principal: "llm", sessionId: "s-r3s2" },
    taint: "UNTRUSTED",
    nonce: `n-${kind}`,
    createdAt: "2026-05-22T12:00:00.000Z",
  });

const CONTRADICTING_CHECKOUT = {
  cartId: "cart-1",
  paymentMethod: "cash",
  deliveryType: "pickup",
} as const;

// The guard's own fallback, mirrored: `sessionTokensConsumed` is a THRESHOLD, so
// its reader only fires at/above the budget. An absent key reads 0 — fail-OPEN,
// which is this signal's PASS direction.
const EFFECTIVE_TOKEN_BUDGET = Number.isFinite(SESSION_TOKEN_BUDGET)
  ? SESSION_TOKEN_BUDGET
  : 100_000;

// The pack-side reader's state. Deliberately the V7 checkout row from
// pack-orders' own BKL-280 suite: `totalInCentavos: 5_000` sits BELOW the R$ 1.000
// `confirmLargeTicket` band, so a REQUEST_CONFIRMATION here is unambiguously the
// contradiction guard's and never the money ladder's — and the prompt is pinned
// below to prove which sentence was asked.
const CHECKOUT_CTX = {
  channel: "whatsapp",
  customerId: "c-1",
  cartId: "cart-1",
  orderId: null,
  items: [{ variantId: "v-1", quantity: 1, priceInCentavos: 5_000 }],
  fulfillment: "pickup",
  paymentMethod: "cash",
  paymentStatus: null,
  totalInCentavos: 5_000,
  lastAction: null,
} satisfies OrderState["ctx"];

const CONTRADICTION_PROMPT =
  "O pedido está marcado como retirada no local, mas sua mensagem indica entrega. Como você prefere receber: entrega no seu endereço ou retirada no local?";

/**
 * One row per declared signal: an in-band sample value, WHERE production stamps
 * it, and its PRODUCTION reader driven for real.
 *
 * `satisfies { [K in ResolutionSignalName]: SignalRow<K> }` is what makes this an
 * enumeration and not a sample: a signal added to `ResolutionSignals` without a
 * row here fails to COMPILE ("property is missing"), and a row for an undeclared
 * signal fails the same way — so the table cannot silently fall behind the
 * contract the way the inline casts fell behind the stamp sites.
 */
interface SignalRow<K extends ResolutionSignalName> {
  /** A value of the signal's DECLARED type — a cross-typed sample won't compile. */
  readonly sample: NonNullable<ResolutionSignals[K]>;
  /** The production stamp site, for the failure message a human has to act on. */
  readonly stampSite: string;
  /** Human name of the reader, used in failure messages. */
  readonly readerName: string;
  /**
   * The adopter guard that reads this signal, or null when the reader lives in a
   * published pack (which cannot import from apps/api). Used by the reverse-
   * direction check below: every adopter business guard must be some declared
   * signal's reader.
   */
  readonly readerGuard: Guard<string, unknown, unknown> | null;
  /** Drives the REAL reader over a ctx carrying only what the writer stamped. */
  readonly readerFires: (ctx: ResolutionSignalSink) => boolean;
}

const ROWS = {
  autoResolvedMoneyRef: {
    sample: true,
    stampSite: "resolveAndAssemble — applyAutoResolve's verdict",
    readerName: "confirmOnAutoResolveGuard (adopter business guard)",
    readerGuard: confirmOnAutoResolveGuard,
    readerFires: (ctx) =>
      confirmOnAutoResolveGuard(envelopeFor("order.cancel"), { ctx })?.kind ===
      "REQUEST_CONFIRMATION",
  },
  allergenMentionDetected: {
    sample: true,
    stampSite: "resolveAndAssemble — isAllergenMentionUtterance (FE-T14)",
    readerName: "refuseAllergenMentionGuard (adopter business guard)",
    readerGuard: refuseAllergenMentionGuard,
    readerFires: (ctx) =>
      refuseAllergenMentionGuard(envelopeFor("customer.preferences.update"), { ctx })?.kind ===
      "REFUSE",
  },
  amendItemUnresolved: {
    sample: true,
    stampSite: "threadResolvedIdsIntoPayload — unresolved amend variantId (FE-D18)",
    readerName: "refuseUnresolvedAmendItemGuard (adopter business guard)",
    readerGuard: refuseUnresolvedAmendItemGuard,
    readerFires: (ctx) =>
      refuseUnresolvedAmendItemGuard(envelopeFor("order.amend.add_item"), { ctx })?.kind ===
      "REFUSE",
  },
  reviewProductUnresolved: {
    sample: true,
    stampSite: "threadResolvedIdsIntoPayload — resolveReviewedProduct miss (FE-D28)",
    readerName: "refuseUnresolvedReviewProductGuard (adopter business guard)",
    readerGuard: refuseUnresolvedReviewProductGuard,
    readerFires: (ctx) =>
      refuseUnresolvedReviewProductGuard(envelopeFor("order.review.submit"), { ctx })?.kind ===
      "REFUSE",
  },
  stayHomeDeliveryMarker: {
    sample: true,
    stampSite: "resolveAndAssemble — hasStayHomeDeliveryMarker (BKL-280)",
    readerName: "confirmDeliveryContradiction (@ibatexas/pack-orders, ordersPolicyBundle)",
    readerGuard: null,
    // The CROSS-PACKAGE round-trip: the host's writer stamps the flag, the
    // published pack's own typed read consumes it. This is why the contract
    // DERIVES the field from `OrderState` rather than mirroring it — the two ends
    // are in different packages and only the type can hold them together.
    readerFires: (ctx) => {
      const decision = adjudicate(
        orderEnvelopeFor("order.checkout.create", CONTRADICTING_CHECKOUT),
        { ctx: { ...CHECKOUT_CTX, ...ctx } } as OrderState,
        ordersPolicyBundle,
      );
      return (
        decision.kind === "REQUEST_CONFIRMATION" && decision.prompt === CONTRADICTION_PROMPT
      );
    },
  },
  sessionTokensConsumed: {
    sample: EFFECTIVE_TOKEN_BUDGET,
    stampSite: "resolveAndAssemble — readSessionTokensConsumed (F4 / ADR-120)",
    readerName: "sessionTokenBudgetGuard (adopter business guard)",
    readerGuard: sessionTokenBudgetGuard,
    readerFires: (ctx) =>
      sessionTokenBudgetGuard(envelopeFor("order.cancel"), { ctx })?.kind === "REFUSE",
  },
} satisfies { [K in ResolutionSignalName]: SignalRow<K> };

/**
 * The ctx keys this channel has ALWAYS used, hard-coded on purpose.
 *
 * These strings are the wire: existing tests assert on them, HTTP/e2e fixtures
 * build them, and `stayHomeDeliveryMarker` is a field of a published pack's
 * public `OrderState`. Deriving this list from `ResolutionSignals` would make the
 * check vacuous — a rename would rename both sides and pass. Written out, a
 * rename fails here and names the key that would have gone silent.
 */
const HISTORICAL_CTX_KEYS = [
  "allergenMentionDetected",
  "amendItemUnresolved",
  "autoResolvedMoneyRef",
  "reviewProductUnresolved",
  "sessionTokensConsumed",
  "stayHomeDeliveryMarker",
] as const;

const ROW_ENTRIES = RESOLUTION_SIGNAL_NAMES.map(
  (name) => [name, ROWS[name]] as const,
);

describe("R3-S2 resolution-signals — the declared resolver→guard contract", () => {
  it("declares exactly the ctx keys this channel has always put on the wire", () => {
    // Both directions, so neither an added-but-unshipped signal nor a dropped one
    // slips through: the contract IS the wire, no more and no less.
    expect([...RESOLUTION_SIGNAL_NAMES].sort()).toEqual([...HISTORICAL_CTX_KEYS].sort());
  });

  it("enumerates every declared signal exactly once (the runtime list matches the type)", () => {
    expect(RESOLUTION_SIGNAL_NAMES).toHaveLength(new Set(RESOLUTION_SIGNAL_NAMES).size);
    expect(ROW_ENTRIES).toHaveLength(RESOLUTION_SIGNAL_NAMES.length);
  });

  // ── 1. WRITER → READER round-trip, per signal ────────────────────────────

  describe.each(ROW_ENTRIES)("%s", (name, row) => {
    it("the writer puts the DECLARED key on ctx, and nothing else", () => {
      const ctx: ResolutionSignalSink = {};

      stampResolutionSignal(ctx, name, row.sample);

      // The wire key, byte-exact — a stamp that wrote any other key (or a second
      // one) would leave its guard inert while every type still checked out.
      expect(Object.keys(ctx)).toEqual([name]);
      expect(ctx[name]).toBe(row.sample);
    });

    it("the reader reads back exactly what the writer stamped", () => {
      const ctx: ResolutionSignalSink = {};
      stampResolutionSignal(ctx, name, row.sample);

      expect(readResolutionSignal({ ctx }, name)).toBe(row.sample);
    });

    it("the reader answers undefined for an unstamped ctx (the PASS direction's source)", () => {
      expect(readResolutionSignal({ ctx: {} }, name)).toBeUndefined();
    });

    // ── 2. The PRODUCTION reader exists and consumes this exact key ─────────

    it(`is consumed by ${row.readerName} — a stamp with no reader is an unenforced floor`, () => {
      const ctx: ResolutionSignalSink = {};
      stampResolutionSignal(ctx, name, row.sample);

      expect(
        row.readerFires(ctx),
        `signal "${name}" is stamped by ${row.stampSite} but ${row.readerName} did not react ` +
          `to it. Either the reader no longer reads this key (the resolver now raises a floor ` +
          `nothing enforces — a silent PASS: un-guarded EXECUTE / lost honesty floor), or the ` +
          `key on the wire changed.`,
      ).toBe(true);
    });

    // ── 3. Absent-key PASS semantics, per guard-facing reader ───────────────

    it(`${row.readerName} PASSES when the key is absent (lenient-when-absent, unchanged)`, () => {
      expect(
        row.readerFires({}),
        `signal "${name}": ${row.readerName} fired on a ctx that carries NO signal. ` +
          `Absence must be the PASS direction — it is what makes this guard safe to prepend ` +
          `to every pack, and what the confirm-RESUME leg (which re-resolves with no utterance ` +
          `text) relies on.`,
      ).toBe(false);
    });
  });

  // ── The honesty-floor predicate's exact semantics ────────────────────────

  describe("resolutionSignalIsSet — the `!== true` the REFUSE guards each wrote by hand", () => {
    const BOOLEAN_SIGNALS = [
      AUTO_RESOLVED_MONEY_REF,
      ALLERGEN_MENTION_DETECTED,
      AMEND_ITEM_UNRESOLVED,
      REVIEW_PRODUCT_UNRESOLVED,
      STAY_HOME_DELIVERY_MARKER,
    ] as const;

    it.each(BOOLEAN_SIGNALS)("%s: only an exact `true` counts as set", (signal) => {
      expect(resolutionSignalIsSet({ ctx: { [signal]: true } }, signal)).toBe(true);
      expect(resolutionSignalIsSet({ ctx: { [signal]: false } }, signal)).toBe(false);
      expect(resolutionSignalIsSet({ ctx: {} }, signal)).toBe(false);
      // The shape a confirm-RESUME produces (re-resolved with no utterance text):
      // the key is simply not there, and every floor must pass.
      expect(resolutionSignalIsSet({ ctx: { unrelated: true } }, signal)).toBe(false);
    });

    it("a truthy-but-not-true value is NOT set (a flag is a flag, never a coercion)", () => {
      const ctx = { [ALLERGEN_MENTION_DETECTED]: "sim" } as unknown as ResolutionSignals;

      expect(resolutionSignalIsSet({ ctx }, ALLERGEN_MENTION_DETECTED)).toBe(false);
      // …and the guard agrees, because the guard IS this predicate.
      expect(refuseAllergenMentionGuard(envelopeFor("customer.preferences.update"), { ctx })).toBeNull();
    });
  });

  // ── The reverse direction: no guard reads an UNDECLARED key ──────────────

  it("every adopter business guard is a declared signal's reader (a new guard reading an undeclared ctx key fails here)", () => {
    const declaredReaders = ROW_ENTRIES.map(([, row]) => row.readerGuard).filter(
      (g): g is Guard<string, unknown, unknown> => g !== null,
    );

    for (const guard of IBATEXAS_ADOPTER_BUSINESS_GUARDS) {
      expect(
        declaredReaders,
        `an adopter business guard is composed onto EVERY pack but reads no declared signal. ` +
          `If it reads a ctx key, declare that key in ResolutionSignals and give it a row here ` +
          `— an inline \`state as { ctx?: { … } }\` cast is exactly the drift this slice closed.`,
      ).toContain(guard);
    }
    // Count both ways so an adopter guard that is DELETED (its signal left stamped
    // but unread) fails too, rather than trivially satisfying the loop above.
    expect(IBATEXAS_ADOPTER_BUSINESS_GUARDS).toHaveLength(declaredReaders.length);
  });

  // ── Non-vacuity of the cross-package leg ─────────────────────────────────

  it("the pack-side reader is a REAL pack guard: the same checkout EXECUTEs without the stamp", () => {
    // If `readerFires` were driving something inert, the "absent ⇒ PASS" case
    // above would pass for the wrong reason (nothing ever fires). Pin the verdict
    // itself: unstamped ⇒ EXECUTE, stamped ⇒ the contradiction question.
    const unstamped = adjudicate(
      orderEnvelopeFor("order.checkout.create", CONTRADICTING_CHECKOUT),
      { ctx: { ...CHECKOUT_CTX } } as OrderState,
      ordersPolicyBundle,
    );

    expect(unstamped.kind).toBe("EXECUTE");

    const ctx: ResolutionSignalSink = {};
    stampResolutionSignal(ctx, STAY_HOME_DELIVERY_MARKER, true);
    expect(ROWS.stayHomeDeliveryMarker.readerFires(ctx)).toBe(true);
  });

  it("the F4 threshold reader is a REAL threshold: below budget PASSES, at budget REFUSEs", () => {
    // Same non-vacuity point for the one non-boolean signal — its PASS direction
    // is "below the budget", not "absent", so absence alone could not prove the
    // reader is live.
    const under: ResolutionSignalSink = {};
    stampResolutionSignal(under, SESSION_TOKENS_CONSUMED, EFFECTIVE_TOKEN_BUDGET - 1);

    expect(sessionTokenBudgetGuard(envelopeFor("order.cancel"), { ctx: under })).toBeNull();
    expect(ROWS.sessionTokensConsumed.readerFires({ [SESSION_TOKENS_CONSUMED]: EFFECTIVE_TOKEN_BUDGET })).toBe(
      true,
    );
  });
});
