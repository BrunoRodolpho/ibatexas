// R3-S3 — the coverage contract for the per-kind resolution profile table.
//
// The table replaced EIGHT hand-maintained kind-sets in resolve-and-assemble.ts
// plus a ninth hand-mirrored set in compose-policy-packs.ts. Collapsing nine
// declarations into one buys consistency, and costs exactly one new risk: a row
// edited or dropped now changes several behaviours at once, silently, because
// there is no longer a second declaration to disagree with it.
//
// This suite is that second declaration — deliberately, and ONLY here. The
// CENSUS below is a HAND-WRITTEN transcription of every set's pre-migration
// membership. It is not derived from the table, not generated from it, and not
// spread out of it: it is typed out, so that dropping a kind from a row fails
// with the kind NAMED rather than passing because both sides moved together.
// (That is the R3-S2 lesson about `RESOLUTION_SIGNAL_NAMES`: a control list stops
// being a control the moment it is derived from the thing it controls. The first
// draft of that slice's wire pin renamed the control along with the subject and
// had to be caught and restored.)
//
// What this suite does NOT do is prove production routes through the table. That
// is the existing suites' job and they pass UNEDITED: resolve-and-assemble.test.ts
// (273 cases) drives the real resolver, autoresolve-confirm-lockstep.test.ts
// drives the real composed guard, ownership-gating-coverage.test.ts pins the
// ownership dispatch. Splitting it this way keeps each side non-vacuous — this
// file pins WHAT IS DECLARED with no mocks, those files pin WHAT RUNS.

import { describe, expect, it } from "vitest";
import {
  AUTORESOLVE_CONFIRM_KINDS,
  COUPON_SWAP_CTX_KINDS,
  DOMAIN_DEFAULT_CTX_LOADERS,
  KIND_RESOLUTION_PROFILES,
  ORDER_AUTORESOLVE_KINDS,
  ORDER_BY_ID_KINDS,
  ORDER_NAMED_REFERENCE_KINDS,
  PREVIOUS_ORDER_CTX_KINDS,
  REFUND_OWNERSHIP_KINDS,
  RESERVATION_AUTORESOLVE_KINDS,
  RESERVATION_SLOT_RESOLVE_KINDS,
  UNIVERSAL_RESOLUTION_SIGNALS,
  UNPROFILED_KIND,
  ctxLoaderConfirmsOwnership,
  ctxLoaderFor,
  kindMayStamp,
  resolutionProfileFor,
  stampProfiledSignal,
  type CtxLoaderSelection,
  type KindResolutionProfile,
} from "../kind-resolution-profiles.js";
import { RESOLUTION_SIGNAL_NAMES } from "../resolution-signals.js";

// ── THE CENSUS ───────────────────────────────────────────────────────────────
//
// Every list below is the pre-migration membership of one hand-maintained set,
// transcribed from the deleted declarations (resolve-and-assemble.ts lines
// 378-392, 469-471, 909-919, 947-964, 980-985, 1001, 1006-1009, 1020, and
// compose-policy-packs.ts lines 117-142 at commit c5017e73). Sorted, so a
// diff against a derived set names the kind that moved.

/** ORDER_BY_ID_KINDS — the nine order kinds loaded by id (034-F1). */
const CENSUS_ORDER_BY_ID = [
  "order.address.change",
  "order.amend.add_item",
  "order.amend.remove_item",
  "order.amend.request",
  "order.amend.update_qty",
  "order.cancel",
  "order.note.add",
  "order.review.submit",
  "order.type.switch",
];

/** ORDER_AUTORESOLVE_KINDS — the ten kinds whose implicit ORDER target is resolved. */
const CENSUS_ORDER_AUTORESOLVE = [
  "order.address.change",
  "order.amend.add_item",
  "order.amend.remove_item",
  "order.amend.request",
  "order.amend.update_qty",
  "order.cancel",
  "order.note.add",
  "order.review.submit",
  "order.type.switch",
  "payment.pix.regenerate",
];

/** ORDER_NAMED_REFERENCE_KINDS — BKL-216, the four amend kinds. */
const CENSUS_ORDER_NAMED_REFERENCE = [
  "order.amend.add_item",
  "order.amend.remove_item",
  "order.amend.request",
  "order.amend.update_qty",
];

/** RESERVATION_AUTORESOLVE_KINDS — FE-T14. */
const CENSUS_RESERVATION_AUTORESOLVE = ["reservation.cancel", "reservation.modify"];

/** RESERVATION_SLOT_RESOLVE_KINDS — FE-D27 create/waitlist (modify was separate). */
const CENSUS_RESERVATION_SLOT_RESOLVE = ["reservation.create", "reservation.waitlist.join"];

/** REFUND_OWNERSHIP_KINDS — 034-F1 finding 6/7. */
const CENSUS_REFUND_OWNERSHIP = ["payment.refund.confirm", "payment.refund.issue"];

/** PREVIOUS_ORDER_CTX_KINDS — the three workflow anchors (LE2-021/023/024). */
const CENSUS_PREVIOUS_ORDER_CTX = [
  "order.cancel.request",
  "order.coupon.swap.request",
  "order.reorder.request",
];

/** COUPON_SWAP_CTX_KINDS — LE2-023, the swap anchor alone. */
const CENSUS_COUPON_SWAP_CTX = ["order.coupon.swap.request"];

/**
 * Every kind this slice profiles — the hand-written roll call of rows.
 *
 * Load-bearing beyond the count pin below, and the reason it exists: the loader
 * census iterates THIS list, not `Object.keys(KIND_RESOLUTION_PROFILES)`. Driving
 * it off the table's own keys made the loader check silently stop covering a kind
 * the moment its row was deleted — the removal removed the test with it. That was
 * caught by running this slice's own revert-to-red experiment (a), which is the
 * only reason it is not still a hole: the census named the dropped kind, the
 * loader assertion said nothing.
 */
const CENSUS_PROFILED_KINDS = [
  "customer.preferences.update",
  "order.address.change",
  "order.amend.add_item",
  "order.amend.remove_item",
  "order.amend.request",
  "order.amend.update_qty",
  "order.cancel",
  "order.cancel.request",
  "order.checkout.create",
  "order.coupon.swap.request",
  "order.note.add",
  "order.reorder.request",
  "order.review.submit",
  "order.type.switch",
  "payment.pix.regenerate",
  "payment.refund.confirm",
  "payment.refund.issue",
  "reservation.cancel",
  "reservation.create",
  "reservation.modify",
  "reservation.waitlist.join",
];

/** AUTORESOLVE_CONFIRM_KINDS — the twelve, hand-written in compose-policy-packs.ts. */
const CENSUS_AUTORESOLVE_CONFIRM = [
  "order.address.change",
  "order.amend.add_item",
  "order.amend.remove_item",
  "order.amend.request",
  "order.amend.update_qty",
  "order.cancel",
  "order.note.add",
  "order.review.submit",
  "order.type.switch",
  "payment.pix.regenerate",
  "reservation.cancel",
  "reservation.modify",
];

const sorted = (s: ReadonlySet<string>): string[] => [...s].sort();

describe("R3-S3 profile table — the derived sets equal the pre-migration memberships", () => {
  it.each([
    ["ORDER_BY_ID_KINDS", ORDER_BY_ID_KINDS, CENSUS_ORDER_BY_ID],
    ["ORDER_AUTORESOLVE_KINDS", ORDER_AUTORESOLVE_KINDS, CENSUS_ORDER_AUTORESOLVE],
    ["ORDER_NAMED_REFERENCE_KINDS", ORDER_NAMED_REFERENCE_KINDS, CENSUS_ORDER_NAMED_REFERENCE],
    ["RESERVATION_AUTORESOLVE_KINDS", RESERVATION_AUTORESOLVE_KINDS, CENSUS_RESERVATION_AUTORESOLVE],
    [
      "RESERVATION_SLOT_RESOLVE_KINDS",
      RESERVATION_SLOT_RESOLVE_KINDS,
      CENSUS_RESERVATION_SLOT_RESOLVE,
    ],
    ["REFUND_OWNERSHIP_KINDS", REFUND_OWNERSHIP_KINDS, CENSUS_REFUND_OWNERSHIP],
    ["PREVIOUS_ORDER_CTX_KINDS", PREVIOUS_ORDER_CTX_KINDS, CENSUS_PREVIOUS_ORDER_CTX],
    ["COUPON_SWAP_CTX_KINDS", COUPON_SWAP_CTX_KINDS, CENSUS_COUPON_SWAP_CTX],
    ["AUTORESOLVE_CONFIRM_KINDS", AUTORESOLVE_CONFIRM_KINDS, CENSUS_AUTORESOLVE_CONFIRM],
  ])("%s derives exactly its pre-migration membership", (_name, derived, census) => {
    expect(sorted(derived as ReadonlySet<string>)).toEqual(census as string[]);
  });

  // The census lists are only a control if they are not empty and not each
  // other. A predicate typo that made every derivation return {} would satisfy
  // nine `toEqual([])` assertions without this.
  it("every census list is non-empty (a control that matched nothing would pass vacuously)", () => {
    for (const census of [
      CENSUS_ORDER_BY_ID,
      CENSUS_ORDER_AUTORESOLVE,
      CENSUS_ORDER_NAMED_REFERENCE,
      CENSUS_RESERVATION_AUTORESOLVE,
      CENSUS_RESERVATION_SLOT_RESOLVE,
      CENSUS_REFUND_OWNERSHIP,
      CENSUS_PREVIOUS_ORDER_CTX,
      CENSUS_COUPON_SWAP_CTX,
      CENSUS_AUTORESOLVE_CONFIRM,
    ]) {
      expect(census.length).toBeGreaterThan(0);
    }
  });
});

// ── THE LOADER CENSUS ────────────────────────────────────────────────────────

describe("R3-S3 profile table — ctxLoaderFor reproduces the pre-migration dispatch", () => {
  // A hand-written replica of `loadCtxForKind`'s if-chain at c5017e73, INCLUDING
  // its own hand-written ORDER_BY_ID list. The migration hoisted the per-kind
  // override above the prefix ladder; this is the ladder in its original order,
  // so the two agreeing is a real claim about that hoist.
  const LEGACY_ORDER_BY_ID = new Set(CENSUS_ORDER_BY_ID);
  const legacyLoaderFor = (kind: string): CtxLoaderSelection => {
    if (kind.startsWith("payment.")) return "payment";
    if (LEGACY_ORDER_BY_ID.has(kind)) return "order-by-id";
    if (kind.startsWith("reservation.")) return "reservation";
    if (kind.startsWith("customer.")) return "customer";
    if (kind.startsWith("order.")) return "cart";
    return "base";
  };

  // Every rowed kind, plus un-rowed kinds exercising each ladder branch and the
  // base fallthrough — the un-rowed half is what proves the domain ladder still
  // serves the open kind space rather than everything collapsing to "base".
  const UNROWED_PROBES = [
    "payment.pix.create",
    "payment.method.change",
    "reservation.waitlist.leave",
    "customer.profile.update",
    "order.item.add",
    "order.item.update",
    "order.item.remove",
    "order.coupon.apply",
    "order.cart.ensure",
    "whatsapp.session.start",
    "ops.order.refund",
    "totally.unknown.kind",
    "",
  ];

  // Iterates the HAND-WRITTEN roll call, never the table's keys: a deleted row
  // must still be asked which loader it routes to, or deleting it deletes its
  // coverage. (Revert-to-red (a) proved that failure mode on this very block.)
  it.each([...CENSUS_PROFILED_KINDS, ...UNROWED_PROBES])(
    "%s routes to the same loader as before the migration",
    (kind) => {
      expect(ctxLoaderFor(kind)).toBe(legacyLoaderFor(kind));
    },
  );

  it("the un-rowed probes are genuinely un-rowed (else the branch above proves nothing)", () => {
    for (const kind of UNROWED_PROBES) {
      expect(KIND_RESOLUTION_PROFILES[kind]).toBeUndefined();
    }
    // …and they do not all land on the same loader, which is what would make
    // the ladder untested.
    expect(new Set(UNROWED_PROBES.map(ctxLoaderFor)).size).toBeGreaterThan(1);
  });

  it("ctxLoaderConfirmsOwnership is exactly the two resourceOwnerConfirmed loaders", () => {
    for (const kind of [...Object.keys(KIND_RESOLUTION_PROFILES), ...UNROWED_PROBES]) {
      const loader = ctxLoaderFor(kind);
      expect(ctxLoaderConfirmsOwnership(kind)).toBe(
        loader === "payment" || loader === "order-by-id",
      );
    }
    // Directional spot checks, so a helper that always returned true fails here.
    expect(ctxLoaderConfirmsOwnership("order.cancel")).toBe(true);
    expect(ctxLoaderConfirmsOwnership("payment.refund.issue")).toBe(true);
    expect(ctxLoaderConfirmsOwnership("order.item.add")).toBe(false);
    expect(ctxLoaderConfirmsOwnership("reservation.cancel")).toBe(false);
  });

  it("the domain ladder is ordered and total over the four prefixes", () => {
    expect(DOMAIN_DEFAULT_CTX_LOADERS.map(([prefix]) => prefix)).toEqual([
      "payment.",
      "reservation.",
      "customer.",
      "order.",
    ]);
  });
});

// ── ROW WELL-FORMEDNESS ──────────────────────────────────────────────────────

describe("R3-S3 profile table — every row is well-formed", () => {
  const TARGET_RESOLUTIONS = new Set([
    "none",
    "order-most-recent",
    "order-named-reference",
    "order-display-reference",
    "reservation-active",
  ]);
  const SLOT_RESOLUTIONS = new Set(["none", "create-keys", "modify-keys"]);
  const OWNERSHIP_BINDINGS = new Set(["none", "refund-payment-order"]);
  const NORMALIZERS = new Set([
    "checkout-payment-method",
    "checkout-delivery-type",
    "preferences-wire-fields",
    "modify-party-size",
  ]);
  const PROJECTIONS = new Set(["previous-order", "coupon-swap"]);
  const CTX_LOADERS = new Set(["payment", "order-by-id", "reservation", "customer", "cart", "base"]);

  const rows = Object.entries(KIND_RESOLUTION_PROFILES);

  it.each(rows)("%s declares values inside every vocabulary", (_kind, profile) => {
    const p = profile as KindResolutionProfile;
    expect(TARGET_RESOLUTIONS.has(p.targetResolution)).toBe(true);
    expect(SLOT_RESOLUTIONS.has(p.slotResolution)).toBe(true);
    expect(OWNERSHIP_BINDINGS.has(p.ownershipBinding)).toBe(true);
    expect(typeof p.confirmOnAutoResolve).toBe("boolean");
    // A row always names a concrete loader — "domain-default" is the unprofiled
    // value only, and a row carrying it would silently re-enter the ladder.
    expect(CTX_LOADERS.has(p.ctxLoader)).toBe(true);
    for (const n of p.payloadNormalizers) expect(NORMALIZERS.has(n)).toBe(true);
    for (const c of p.ctxProjections) expect(PROJECTIONS.has(c)).toBe(true);
    for (const s of p.signals) expect(RESOLUTION_SIGNAL_NAMES).toContain(s);
  });

  it.each(rows)("%s has no duplicate entries in its list fields", (_kind, profile) => {
    const p = profile as KindResolutionProfile;
    expect(new Set(p.payloadNormalizers).size).toBe(p.payloadNormalizers.length);
    expect(new Set(p.ctxProjections).size).toBe(p.ctxProjections.length);
    expect(new Set(p.signals).size).toBe(p.signals.length);
  });

  // The table's own membership rule: a row exists IFF the kind has non-default
  // behaviour somewhere. An all-default row would be a claim of coverage the
  // table has not earned, and would silently join every "kinds with a profile"
  // count.
  it.each(rows)("%s is non-default in at least one axis (rows must mean something)", (_kind, profile) => {
    const p = profile as KindResolutionProfile;
    const isDefault =
      p.targetResolution === "none" &&
      p.confirmOnAutoResolve === false &&
      p.slotResolution === "none" &&
      p.ownershipBinding === "none" &&
      p.payloadNormalizers.length === 0 &&
      p.ctxProjections.length === 0 &&
      p.signals.length === 0 &&
      p.ctxLoader === ctxLoaderFor(`__unrowed__${_kind}`);
    expect(isDefault).toBe(false);
  });

  it("the table's rows are exactly the hand-written roll call, by name", () => {
    // Names, not just a count: a row ADDED without a census entry and a row
    // DROPPED both fail here saying which kind. Two rows in the table
    // (order.checkout.create, customer.preferences.update) belong to no derived
    // kind-set at all — they exist for a normalizer and a signal — so without
    // this assertion nothing would pin their presence.
    expect(Object.keys(KIND_RESOLUTION_PROFILES).sort()).toEqual([...CENSUS_PROFILED_KINDS].sort());
    // 9 order-by-id + 3 payment + 4 reservation + 3 workflow anchors + checkout
    // + preferences.
    expect(rows.length).toBe(21);
  });
});

// ── THE FAIL-CLOSED DEFAULT ──────────────────────────────────────────────────

describe("R3-S3 profile table — an absent kind gets none of it", () => {
  const ABSENT = "definitely.not.a.kind";

  it("resolutionProfileFor returns the unprofiled default for an unknown kind", () => {
    expect(KIND_RESOLUTION_PROFILES[ABSENT]).toBeUndefined();
    expect(resolutionProfileFor(ABSENT)).toEqual(UNPROFILED_KIND);
  });

  it("the unprofiled default is safe on every axis", () => {
    expect(UNPROFILED_KIND).toEqual({
      targetResolution: "none",
      confirmOnAutoResolve: false,
      // The one axis where "absent" cannot mean "nothing" — every kind gets some
      // loader, so the default defers to the domain ladder instead of forcing
      // "base" and stripping cart/reservation/customer ctx from unlisted kinds.
      ctxLoader: "domain-default",
      slotResolution: "none",
      ownershipBinding: "none",
      payloadNormalizers: [],
      ctxProjections: [],
      signals: [],
    });
  });

  it("an absent kind may stamp NO kind-gated signal", () => {
    for (const signal of RESOLUTION_SIGNAL_NAMES) {
      expect(kindMayStamp(ABSENT, signal)).toBe(UNIVERSAL_RESOLUTION_SIGNALS.includes(signal));
    }
  });

  it("an absent kind appears in no derived set", () => {
    for (const set of [
      ORDER_BY_ID_KINDS,
      ORDER_AUTORESOLVE_KINDS,
      ORDER_NAMED_REFERENCE_KINDS,
      RESERVATION_AUTORESOLVE_KINDS,
      RESERVATION_SLOT_RESOLVE_KINDS,
      REFUND_OWNERSHIP_KINDS,
      PREVIOUS_ORDER_CTX_KINDS,
      COUPON_SWAP_CTX_KINDS,
      AUTORESOLVE_CONFIRM_KINDS,
    ]) {
      expect(set.has(ABSENT)).toBe(false);
    }
  });
});

// ── THE SIGNAL GATE ──────────────────────────────────────────────────────────

describe("R3-S3 profile table — signals are declared per kind and enforced", () => {
  // Hand-written, same discipline as the census above: which kinds may stamp
  // which honesty-floor signal, transcribed from the stamp sites' kind gates at
  // c5017e73 (resolve-and-assemble.ts lines 2745, 2753, 2777, 2349, 2447).
  const CENSUS_SIGNAL_KINDS: ReadonlyArray<readonly [string, readonly string[]]> = [
    ["autoResolvedMoneyRef", CENSUS_AUTORESOLVE_CONFIRM],
    ["allergenMentionDetected", ["customer.preferences.update"]],
    ["amendItemUnresolved", ["order.amend.add_item"]],
    ["reviewProductUnresolved", ["order.review.submit"]],
    ["stayHomeDeliveryMarker", ["order.checkout.create"]],
  ];

  it.each(CENSUS_SIGNAL_KINDS)(
    "%s is declared by exactly the kinds that stamped it before the migration",
    (signal, kinds) => {
      const declared = Object.entries(KIND_RESOLUTION_PROFILES)
        .filter(([, p]) => p.signals.includes(signal as never))
        .map(([kind]) => kind)
        .sort();

      expect(declared).toEqual([...kinds].sort());
    },
  );

  it("every R3-S2 signal is either universal or declared by some row", () => {
    // Proves the table covers the WHOLE signal contract. A signal declared in
    // resolution-signals.ts but on no row would be unstampable — an honesty floor
    // that can never fire, which is R3-S1's "orphan confirm" failure one layer
    // down.
    for (const signal of RESOLUTION_SIGNAL_NAMES) {
      const declaredSomewhere = Object.values(KIND_RESOLUTION_PROFILES).some((p) =>
        p.signals.includes(signal),
      );
      expect(declaredSomewhere || UNIVERSAL_RESOLUTION_SIGNALS.includes(signal)).toBe(true);
    }
  });

  it("the universal set is exactly the F4 token counter", () => {
    expect([...UNIVERSAL_RESOLUTION_SIGNALS]).toEqual(["sessionTokensConsumed"]);
  });

  it("stampProfiledSignal writes a DECLARED signal with the R3-S2 key spelling", () => {
    const ctx: Record<string, unknown> = {};
    stampProfiledSignal(ctx, "order.amend.add_item", "amendItemUnresolved", true);
    expect(ctx).toEqual({ amendItemUnresolved: true });
  });

  it("the universal signal stamps for ANY kind, rowed or not", () => {
    const rowed: Record<string, unknown> = {};
    stampProfiledSignal(rowed, "order.cancel", "sessionTokensConsumed", 42);
    expect(rowed).toEqual({ sessionTokensConsumed: 42 });

    const unrowed: Record<string, unknown> = {};
    stampProfiledSignal(unrowed, "whatsapp.session.start", "sessionTokensConsumed", 7);
    expect(unrowed).toEqual({ sessionTokensConsumed: 7 });
  });

  it("stampProfiledSignal THROWS on an undeclared (kind, signal) pair, naming both", () => {
    const ctx: Record<string, unknown> = {};
    // order.cancel auto-resolves, so it declares autoResolvedMoneyRef — but it
    // has no amend item and must not be able to claim one.
    expect(() =>
      stampProfiledSignal(ctx, "order.cancel", "amendItemUnresolved", true),
    ).toThrow(/order\.cancel.*amendItemUnresolved/s);
    // Nothing was written: the throw is the whole behaviour, not a throw-after-write.
    expect(ctx).toEqual({});
  });

  it("throwing (not skipping) is the fail-CLOSED direction for an honesty floor", () => {
    // Documented as a test rather than a comment because the alternative looks
    // safer and is not: every honesty-floor guard PASSES on an absent signal, so
    // silently skipping an undeclared stamp is an un-guarded EXECUTE. A throw is
    // loud and stops the turn.
    const ctx: Record<string, unknown> = {};
    expect(() =>
      stampProfiledSignal(ctx, "definitely.not.a.kind", "reviewProductUnresolved", true),
    ).toThrow();
    expect(ctx.reviewProductUnresolved).toBeUndefined();
  });
});

// ── CROSS-FIELD CONSISTENCY (what R3-S1's lockstep now rests on) ─────────────

describe("R3-S3 profile table — cross-field consistency", () => {
  it("confirmOnAutoResolve and targetResolution are INDEPENDENT fields", () => {
    // The reason R3-S1's lockstep contract is not tautological after this slice.
    // If confirm were derived FROM the strategy, the equality that contract pins
    // would be a no-op; because they are two fields, a row can violate it, and
    // the assertion below is the claim that today none does.
    const strategyWithoutConfirm = Object.entries(KIND_RESOLUTION_PROFILES)
      .filter(([, p]) => p.targetResolution !== "none" && !p.confirmOnAutoResolve)
      .map(([kind]) => kind);
    expect(strategyWithoutConfirm).toEqual([]);

    const confirmWithoutStrategy = Object.entries(KIND_RESOLUTION_PROFILES)
      .filter(([, p]) => p.confirmOnAutoResolve && p.targetResolution === "none")
      .map(([kind]) => kind);
    expect(confirmWithoutStrategy).toEqual([]);
  });

  it("an ownership BINDING never forces a confirm (034-F1: the target stays explicit)", () => {
    for (const kind of REFUND_OWNERSHIP_KINDS) {
      const p = resolutionProfileFor(kind);
      expect(p.ownershipBinding).toBe("refund-payment-order");
      expect(p.targetResolution).toBe("none");
      expect(p.confirmOnAutoResolve).toBe(false);
    }
  });

  it("every ORDER_BY_ID kind auto-resolves and confirms (the 034-F1 ⇄ lockstep overlap)", () => {
    for (const kind of ORDER_BY_ID_KINDS) {
      expect(ORDER_AUTORESOLVE_KINDS.has(kind)).toBe(true);
      expect(AUTORESOLVE_CONFIRM_KINDS.has(kind)).toBe(true);
    }
    // Not symmetric, and that asymmetry is real: payment.pix.regenerate resolves
    // an ORDER target but loads through the PAYMENT loader.
    expect(ORDER_AUTORESOLVE_KINDS.has("payment.pix.regenerate")).toBe(true);
    expect(ORDER_BY_ID_KINDS.has("payment.pix.regenerate")).toBe(false);
    expect(ctxLoaderFor("payment.pix.regenerate")).toBe("payment");
  });

  it("the named-reference kinds are a strict subset of the order-autoresolve kinds", () => {
    for (const kind of ORDER_NAMED_REFERENCE_KINDS) {
      expect(ORDER_AUTORESOLVE_KINDS.has(kind)).toBe(true);
    }
    expect(ORDER_NAMED_REFERENCE_KINDS.size).toBeLessThan(ORDER_AUTORESOLVE_KINDS.size);
    // FE-D28's review kind auto-resolves but by DISPLAY number, not by name —
    // the two strategies the old nesting made easy to conflate.
    expect(ORDER_NAMED_REFERENCE_KINDS.has("order.review.submit")).toBe(false);
    expect(resolutionProfileFor("order.review.submit").targetResolution).toBe(
      "order-display-reference",
    );
  });

  it("the coupon-swap projection never appears without previous-order (it prices against it)", () => {
    for (const kind of COUPON_SWAP_CTX_KINDS) {
      expect(PREVIOUS_ORDER_CTX_KINDS.has(kind)).toBe(true);
      // And the interpreter's ordering requirement is visible in the row: the
      // dependency comes FIRST in the declared list.
      const projections = resolutionProfileFor(kind).ctxProjections;
      expect(projections.indexOf("previous-order")).toBeLessThan(
        projections.indexOf("coupon-swap"),
      );
    }
  });

  it("reservation.modify is the kind that proves the axes are independent", () => {
    // It auto-resolves a target AND grounds a slot AND recovers a party size —
    // three axes at once, which is why they could not be one enum.
    const p = resolutionProfileFor("reservation.modify");
    expect(p.targetResolution).toBe("reservation-active");
    expect(p.slotResolution).toBe("modify-keys");
    expect(p.payloadNormalizers).toEqual(["modify-party-size"]);
    // reservation.create grounds a slot under the OTHER key group and resolves
    // no target at all — so slot-resolution cannot be read off the strategy.
    const create = resolutionProfileFor("reservation.create");
    expect(create.slotResolution).toBe("create-keys");
    expect(create.targetResolution).toBe("none");
    expect(create.confirmOnAutoResolve).toBe(false);
  });

  it("checkout is deliberately NOT auto-resolved but IS normalized and signalled", () => {
    const p = resolutionProfileFor("order.checkout.create");
    expect(p.targetResolution).toBe("none");
    expect(p.confirmOnAutoResolve).toBe(false);
    expect(p.payloadNormalizers).toEqual([
      "checkout-payment-method",
      "checkout-delivery-type",
    ]);
    expect(p.signals).toEqual(["stayHomeDeliveryMarker"]);
  });
});
