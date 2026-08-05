/**
 * F-24 — the THREE hand-maintained ownership sets must AGREE, and until now
 * nothing checked that they did.
 *
 * The kernel ownership/IDOR guard (034-F1) is real only where three independently
 * hand-edited sets line up:
 *
 *   1. HOST     `OWNERSHIP_GATED_KINDS`         (authority-wiring.ts) — decides what
 *      this host STAMPS (`resourceRefsForIntent`) and, on the same test, whether it
 *      INJECTS `state.authority` (`buildCustomerAuthority`) at the two injection
 *      sites (ibatexas-resolver.ts plan stage, claustrum-bootstrap.ts
 *      `enrichResumeState`). Both are gated on the SAME `refs === undefined` check.
 *   2. PACK-ORDERS   `OWNERSHIP_GATED_ORDER_KINDS`   (pack-orders policies.ts)
 *   3. PACK-PAYMENTS `OWNERSHIP_GATED_PAYMENT_KINDS` (pack-payments policies.ts)
 *      — each pack's guard checks its OWN set and is otherwise inert.
 *
 * Drift is silent in the dangerous direction: a kind in the HOST set but missing
 * from its pack's set gets a `resourceRefs` stamp and an authority graph that
 * NOTHING reads — it looks wired, passes the loader-coverage contract, and
 * enforces nothing (PR #527 demonstrated exactly this by dropping `order.cancel`
 * from the pack-orders set: EXECUTE instead of REFUSE).
 *
 * ── What this file compares, and why it is not a projection ──────────────────
 *
 * Two INDEPENDENT authorities, neither derived from the other:
 *   • the HOST's declaration — `OWNERSHIP_GATED_KINDS`, imported;
 *   • each PACK's ENFORCEMENT — measured by driving the real, published policy
 *     bundle and reading the verdict.
 *
 * The pack sets are deliberately NOT imported: they are module-private, and the
 * measured behaviour is the STRONGER authority anyway. A set-to-set comparison
 * would still pass if `enforceOrderOwnership` were dropped from `authGuards`, or
 * if a guard returned before reaching its set; the drive catches all of those.
 *
 * The expected membership is a HAND-WRITTEN roll call (`ROLL_CALL` below) and is
 * also the ITERATION source (the F-14 derived-control law, both mechanisms):
 * deleting a row deletes no coverage silently — it reds the name-level agreement
 * assertion, naming the kind.
 *
 * ── Scope line vs PR #527 (ownership-gating-coverage.test.ts) ────────────────
 * That file pins (a) loader routing for gated kinds, and (b) an ORDER-half
 * enforcement census whose iteration source is DERIVED from the host set. This
 * file adds what that cannot: a hand-written roll call the host set is checked
 * against by NAME, the same enforcement claim for the PAYMENTS half (which
 * apps/api never drove before), and a characterisation of the REVERSE drift
 * direction. It restates neither.
 *
 * ── Build-freshness caveat ──────────────────────────────────────────────────
 * apps/api resolves `@ibatexas/pack-orders` / `@ibatexas/pack-payments` through
 * their `dist/` (package `exports`), NOT their sources. A pack edit is invisible
 * here until that pack is rebuilt — so any mutation experiment against this file
 * (including a revert-to-red on a pack set) MUST rebuild the pack in both
 * directions, or it measures the previous build.
 */

import { describe, expect, it } from "vitest";
import { adjudicate, buildEnvelope } from "@adjudicate/core";
import { ordersPolicyBundle } from "@ibatexas/pack-orders";
import { paymentsPolicyBundle } from "@ibatexas/pack-payments";
import {
  OWNERSHIP_GATED_KINDS,
  buildCustomerAuthority,
  customerPrincipalForSession,
  resourceRefsForIntent,
} from "../authority-wiring.js";

const OWNER = "cust-A";
const SESSION = "sess-A";
/** The only resource `cust-A` owns this turn. */
const OWNED = "order-A";
/** Someone else's order — never in the authority graph. */
const FOREIGN = "order-B";

/**
 * The hand-written roll call. NOT derived from any of the three sets — it is the
 * independent statement of what the ownership gate is supposed to cover, and it
 * is the iteration source for the enforcement census below.
 *
 * `taint` is per-row because the kernel runs `state → taint → auth → business`:
 * `payment.refund.confirm` is a system-only kind (`paymentsTaintPolicy`), so an
 * UNTRUSTED envelope of that kind REFUSEs `taint_level_insufficient` in the TAINT
 * phase and never reaches the ownership guard at all. Measured, not assumed.
 */
const ROLL_CALL = [
  { kind: "order.cancel", pack: "orders", taint: "UNTRUSTED" },
  { kind: "order.amend.request", pack: "orders", taint: "UNTRUSTED" },
  { kind: "order.amend.add_item", pack: "orders", taint: "UNTRUSTED" },
  { kind: "order.amend.update_qty", pack: "orders", taint: "UNTRUSTED" },
  { kind: "order.amend.remove_item", pack: "orders", taint: "UNTRUSTED" },
  { kind: "payment.refund.issue", pack: "payments", taint: "UNTRUSTED" },
  { kind: "payment.refund.confirm", pack: "payments", taint: "SYSTEM" },
  { kind: "payment.pix.regenerate", pack: "payments", taint: "UNTRUSTED" },
] as const;

type Row = (typeof ROLL_CALL)[number];

/** The refusal code each pack's ownership guard emits. */
const OWNERSHIP_CODE: Record<Row["pack"], string> = {
  orders: "order.ownership_denied",
  payments: "payment.ownership_denied",
};

/** The prefix each pack owns — the partition axis the host set must respect. */
const PACK_PREFIX: Record<Row["pack"], string> = {
  orders: "order.",
  payments: "payment.",
};

/** Name-pinned roll-call lookup: a row that vanished must red loudly (and by its
 *  NAME), never silently select a neighbour the way a positional index would. */
function rowFor(kind: string): Row {
  const row = ROLL_CALL.find((r) => r.kind === kind);
  if (row === undefined) throw new Error(`roll call has no row for ${kind}`);
  return row;
}

/** One anchor per pack, named — used by the claims that need a representative
 *  rather than the whole census. */
const ORDER_ANCHOR = "order.cancel";
const PAYMENT_ANCHOR = "payment.refund.issue";

// ── The drive: the REAL published bundles, the REAL host wiring ──────────────

/** The host's own authority graph — `cust-A` owns `order-A` and nothing else. */
function hostAuthority() {
  return buildCustomerAuthority(OWNER, [OWNED], customerPrincipalForSession(SESSION, OWNER));
}

function orderState(orderId: string, withAuthority: boolean) {
  const ctx = {
    tenantId: "ibatexas",
    channel: "whatsapp",
    customerId: OWNER,
    isAuthenticated: true,
    actor: { principal: "user", id: OWNER },
    cartId: null,
    orderId,
    fulfillmentStatus: "pending",
    lastAction: null,
  };
  return withAuthority ? { ctx, authority: hostAuthority() } : { ctx };
}

function paymentState(orderId: string, withAuthority: boolean) {
  const ctx = {
    actor: { principal: "user" },
    tenantId: "ibatexas",
    exists: true,
    currentStatus: "paid",
    currentMethod: "pix",
    version: 1,
    orderId,
    isTerminal: false,
    refundedAmountCentavos: 0,
    amountInCentavos: 50_000,
    regenerationCount: 0,
    dailyRetryCount: 0,
    // The refund-authority invariant's freshness conjunct — supplied so these
    // ownership drives reach the ownership verdict rather than a staleness one.
    paymentReadThisTurn: true,
  };
  return withAuthority ? { ctx, authority: hostAuthority() } : { ctx };
}

interface DriveOptions {
  readonly row: Row;
  readonly orderId: string;
  /** `false` reproduces a host that does not stamp this kind (no `resourceRefs`). */
  readonly stamped: boolean;
  /** `false` reproduces a host that does not inject `state.authority`. */
  readonly authority: boolean;
  readonly sessionId?: string;
}

/**
 * Drives the owning pack's real bundle and returns a flat outcome string —
 * `EXECUTE`, or `REFUSE:<code>:<auth-basis reason>` — so a whole census compares
 * in one assertion that reds by NAME.
 *
 * The auth-basis reason is in the string on purpose. BOTH ownership conjuncts
 * emit the SAME refusal code, so a code-only pin lets one conjunct silently stand
 * in for the other (measured: a neutered binding conjunct still REFUSEd
 * `order.ownership_denied`, from the IDOR conjunct, and a code-only assertion
 * stayed green). `resource_not_owned` = conjunct (1), the binding;
 * `tenant_binding_violation` = conjunct (2), the session→principal IDOR gate.
 * The basis row is keyed `category` (never `kind`).
 *
 * The stamp comes from the HOST's own `resourceRefsForIntent` — so the stamping
 * side of every row is production code, not a fixture guess.
 */
function drive({ row, orderId, stamped, authority, sessionId = SESSION }: DriveOptions): string {
  const refs = stamped ? resourceRefsForIntent(row.kind, { orderId }, OWNER) : undefined;
  const envelope = buildEnvelope({
    kind: row.kind,
    payload: {
      orderId,
      itemId: "li-1",
      item: "coca",
      quantity: 1,
      refundAmountCentavos: 1_000,
    },
    actor: { principal: "user", sessionId },
    taint: row.taint,
    nonce: `n-${row.kind}-${orderId}-${String(stamped)}-${String(authority)}-${sessionId}`,
    ...(refs === undefined ? {} : { resourceRefs: refs }),
  });
  const isPayments = row.pack === "payments";
  const state = isPayments
    ? paymentState(orderId, authority)
    : orderState(orderId, authority);
  const bundle = isPayments ? paymentsPolicyBundle : ordersPolicyBundle;
  const decision = adjudicate(envelope as never, state as never, bundle as never) as {
    kind: string;
    refusal?: { code?: string };
    basis?: readonly { category?: string; detail?: { reason?: string } }[];
  };
  if (decision.kind !== "REFUSE") return decision.kind;
  const reason =
    decision.basis?.find((b) => b.category === "auth")?.detail?.reason ?? "no-auth-basis";
  return `REFUSE:${decision.refusal?.code}:${reason}`;
}

/** The conjunct labels the guards stamp on their auth basis row. */
const BINDING_CONJUNCT = "resource_not_owned";
const IDOR_CONJUNCT = "tenant_binding_violation";

// ── 1. The host set, measured against the hand-written roll call ─────────────

describe("F-24 — the HOST ownership set agrees with the hand-written roll call", () => {
  it("OWNERSHIP_GATED_KINDS is EXACTLY the roll call — both directions, by NAME", () => {
    // Sorted name comparison (not a count): adding, dropping or renaming a kind on
    // either side reds with the offending name in the diff.
    expect([...OWNERSHIP_GATED_KINDS].sort()).toEqual(ROLL_CALL.map((r) => r.kind).sort());
  });

  it("the roll call covers BOTH packs (guards the census below against a half going vacuous)", () => {
    expect(ROLL_CALL.filter((r) => r.pack === "orders").length).toBe(5);
    expect(ROLL_CALL.filter((r) => r.pack === "payments").length).toBe(3);
  });

  it("the partition is by prefix: every gated kind sits under exactly one pack's prefix", () => {
    const misfiled = ROLL_CALL.filter((r) => !r.kind.startsWith(PACK_PREFIX[r.pack]));
    expect(misfiled.map((r) => r.kind)).toEqual([]);
    // …and the host set holds nothing outside the two prefixes, so no third pack
    // could be silently on the hook for a stamped kind.
    const outsiders = [...OWNERSHIP_GATED_KINDS].filter(
      (k) => !k.startsWith("order.") && !k.startsWith("payment."),
    );
    expect(outsiders).toEqual([]);
  });
});

// ── 2. Membership must buy ENFORCEMENT — measured in BOTH packs ──────────────

describe("F-24 — every host-stamped kind is ENFORCED by its pack (the counterfeit-fix gate)", () => {
  it("the enforcement census matches the hand-written expectation, in both packs", () => {
    // TREATMENT: the host stamps a FOREIGN order (cust-A owns order-A only) and
    // injects its authority graph — exactly what production does. The owning pack
    // must REFUSE with ITS ownership code, from the BINDING conjunct.
    // CONTROL (same call, same fixtures): the OWNED order must never be
    // ownership-denied, so the treatment's REFUSE is attributable to ownership and
    // not to some other guard that would refuse everything.
    const measured = Object.fromEntries(
      ROLL_CALL.map((row) => {
        const foreign = drive({ row, orderId: FOREIGN, stamped: true, authority: true });
        const owned = drive({ row, orderId: OWNED, stamped: true, authority: true });
        return [
          row.kind,
          {
            foreign,
            ownedIsOwnershipDenied: owned.startsWith(`REFUSE:${OWNERSHIP_CODE[row.pack]}`),
          },
        ];
      }),
    );

    // Hand-written, one literal row per kind — NOT built from ROLL_CALL.
    const ORDER_DENIED = "REFUSE:order.ownership_denied:resource_not_owned";
    const PAYMENT_DENIED = "REFUSE:payment.ownership_denied:resource_not_owned";
    expect(measured).toEqual({
      "order.cancel": { foreign: ORDER_DENIED, ownedIsOwnershipDenied: false },
      "order.amend.request": { foreign: ORDER_DENIED, ownedIsOwnershipDenied: false },
      "order.amend.add_item": { foreign: ORDER_DENIED, ownedIsOwnershipDenied: false },
      "order.amend.update_qty": { foreign: ORDER_DENIED, ownedIsOwnershipDenied: false },
      "order.amend.remove_item": { foreign: ORDER_DENIED, ownedIsOwnershipDenied: false },
      "payment.refund.issue": { foreign: PAYMENT_DENIED, ownedIsOwnershipDenied: false },
      "payment.refund.confirm": { foreign: PAYMENT_DENIED, ownedIsOwnershipDenied: false },
      "payment.pix.regenerate": { foreign: PAYMENT_DENIED, ownedIsOwnershipDenied: false },
    });
  });

  it("the IDOR conjunct is live in BOTH packs too: an unauthenticated session is REFUSEd `tenant_binding_violation` on the OWNED order", () => {
    // The second conjunct of both pack guards (principalOf(actor.sessionId) ===
    // fact.principal). One anchor per pack. The resource IS owned here, so the
    // binding conjunct cannot fire — and the basis reason proves which conjunct
    // spoke, so this cannot be satisfied by the census's mechanism.
    const anchors: readonly Row[] = [rowFor(ORDER_ANCHOR), rowFor(PAYMENT_ANCHOR)];
    const measured = anchors.map((row) => [
      row.kind,
      drive({ row, orderId: OWNED, stamped: true, authority: true, sessionId: "sess-INTRUDER" }),
    ]);
    expect(measured).toEqual([
      ["order.cancel", `REFUSE:order.ownership_denied:${IDOR_CONJUNCT}`],
      ["payment.refund.issue", `REFUSE:payment.ownership_denied:${IDOR_CONJUNCT}`],
    ]);
  });
});

// ── 3. The reverse drift, MEASURED: a kind in a PACK set the host never stamps ─

describe("F-24 — reverse drift (pack-gated, host-unstamped) is SILENT, not fail-closed", () => {
  it("the pack guard SKIPS at its `authority === undefined` line — because the host withholds refs and authority on the SAME test, a pack-only member buys NOTHING", () => {
    // A kind the host does not stamp gets `refs === undefined`, and BOTH injection
    // sites (ibatexas-resolver.ts plan stage, claustrum-bootstrap.ts
    // enrichResumeState) branch on exactly that value — no refs ⇒ no
    // `state.authority` ⇒ the pack guard returns null on its first line. Reproduced
    // here by withholding both, on a kind both packs DO gate: even a gated kind is
    // completely unenforced, so a pack-only member would be too.
    const measured = [rowFor(ORDER_ANCHOR), rowFor(PAYMENT_ANCHOR)].map((row) => [
      row.kind,
      drive({ row, orderId: FOREIGN, stamped: false, authority: false }),
    ]);
    // The FOREIGN order sails past the ownership guard entirely: nothing here is an
    // ownership refusal. (The exact terminal is whatever the rest of the bundle
    // says — that is the point: the ownership guard contributed nothing.)
    expect(measured).toEqual([
      ["order.cancel", "EXECUTE"],
      ["payment.refund.issue", "REQUEST_CONFIRMATION"],
    ]);
  });

  it("were authority injected WITHOUT the host's stamp, the same guard fails CLOSED on its BINDING conjunct — `resolveOwnership` reads resourceRefs, so principal/resource come back null ⇒ unbound ⇒ REFUSE even the TRUE owner", () => {
    // The other half of the characterisation, and the reason the two host branches
    // must stay coupled: decoupling them (injecting authority for a kind that is
    // not stamped) does not open a hole — it DoS-es the kind, refusing its rightful
    // owner. Same OWNED resource, same authority graph as the census control, which
    // there was NOT ownership-denied; the only edit is the missing stamp.
    //
    // Pinned by CONJUNCT, not just by code: `resource_not_owned` is the binding
    // conjunct. Measured — with the binding conjunct neutered the IDOR conjunct
    // REFUSEs with the SAME code (null principal ≠ the authenticated one), so a
    // code-only assertion here would survive its own mechanism being deleted.
    const measured = [rowFor(ORDER_ANCHOR), rowFor(PAYMENT_ANCHOR)].map((row) => [
      row.kind,
      drive({ row, orderId: OWNED, stamped: false, authority: true }),
    ]);
    expect(measured).toEqual([
      ["order.cancel", `REFUSE:order.ownership_denied:${BINDING_CONJUNCT}`],
      ["payment.refund.issue", `REFUSE:payment.ownership_denied:${BINDING_CONJUNCT}`],
    ]);
  });

  it("`resourceRefsForIntent` is the single host decision that withholds BOTH — undefined for a non-member, defined for a member", () => {
    // The coupling itself is pinned end-to-end at the resolver by
    // refund-ownership-wiring.test.ts ("does NOT engage the guard when ownership is
    // INDETERMINATE": refs undefined ⇒ authority undefined). Here we pin the input
    // to that branch: a kind outside the host set can never reach it.
    expect(resourceRefsForIntent("payment.retry", { orderId: OWNED }, OWNER)).toBeUndefined();
    expect(resourceRefsForIntent("order.item.add", { orderId: OWNED }, OWNER)).toBeUndefined();
    expect(resourceRefsForIntent("order.cancel", { orderId: OWNED }, OWNER)).toEqual({
      owner: OWNER,
      resource: OWNED,
    });
  });
});
