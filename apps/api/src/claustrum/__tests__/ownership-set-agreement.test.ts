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

/** The tenant every pack's `requireTenantBindingGuard` accepts (its predicate
 *  reads `KERNEL_TENANT_ID ?? "ibatexas"`). Every drive below uses it unless a
 *  test is deliberately reaching for the cross-tenant path (see §4, F-29). */
const HOST_TENANT = "ibatexas";
/** Any other tenant — trips `requireTenantBindingGuard`, the FIRST authGuard. */
const OTHER_TENANT = "another-tenant";

// ── The drive: the REAL published bundles, the REAL host wiring ──────────────

/** The host's own authority graph — `cust-A` owns `order-A` and nothing else. */
function hostAuthority() {
  return buildCustomerAuthority(OWNER, [OWNED], customerPrincipalForSession(SESSION, OWNER));
}

function orderState(orderId: string, withAuthority: boolean, tenantId = HOST_TENANT) {
  const ctx = {
    tenantId,
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

function paymentState(orderId: string, withAuthority: boolean, tenantId = HOST_TENANT) {
  const ctx = {
    actor: { principal: "user" },
    tenantId,
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
  /** Defaults to `HOST_TENANT`, which every pack's `requireTenantBindingGuard`
   *  accepts. Only §4 (F-29) overrides it, to reach the cross-tenant path. */
  readonly tenantId?: string;
}

/** The four decision fields F-29 needs to keep apart. `reason` is `undefined`
 *  — not a sentinel — when the auth basis row carries no `detail.reason` AT
 *  ALL, because "which field is the string in" is the whole discriminator. */
interface DecisionFields {
  readonly kind: string;
  readonly refusalKind: string | undefined;
  readonly code: string | undefined;
  /** The refusal's free-text `detail` — §4 uses it to identify the PRODUCER. */
  readonly refusalDetail: string | undefined;
  readonly basisCode: string | undefined;
  readonly reason: string | undefined;
}

/** The measurement `drive` flattens. Split out so §4 can read the fields the
 *  flat string deliberately fuses (a missing reason and a literal
 *  `"no-auth-basis"` are indistinguishable once stringified). */
function driveFields({
  row,
  orderId,
  stamped,
  authority,
  sessionId = SESSION,
  tenantId = HOST_TENANT,
}: DriveOptions): DecisionFields {
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
    // The tenant segment is appended only when it is NOT the default, so every
    // pre-F-29 row keeps the nonce it had — the refactor stays byte-neutral.
    nonce:
      `n-${row.kind}-${orderId}-${String(stamped)}-${String(authority)}-${sessionId}` +
      (tenantId === HOST_TENANT ? "" : `-${tenantId}`),
    ...(refs === undefined ? {} : { resourceRefs: refs }),
  });
  const isPayments = row.pack === "payments";
  const state = isPayments
    ? paymentState(orderId, authority, tenantId)
    : orderState(orderId, authority, tenantId);
  const bundle = isPayments ? paymentsPolicyBundle : ordersPolicyBundle;
  const decision = adjudicate(envelope as never, state as never, bundle as never) as {
    kind: string;
    refusal?: { kind?: string; code?: string; detail?: string };
    basis?: readonly { category?: string; code?: string; detail?: { reason?: string } }[];
  };
  const authBasis = decision.basis?.find((b) => b.category === "auth");
  return {
    kind: decision.kind,
    refusalKind: decision.refusal?.kind,
    code: decision.refusal?.code,
    refusalDetail: decision.refusal?.detail,
    basisCode: authBasis?.code,
    reason: authBasis?.detail?.reason,
  };
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
function drive(options: DriveOptions): string {
  const f = driveFields(options);
  if (f.kind !== "REFUSE") return f.kind;
  return `REFUSE:${f.code}:${f.reason ?? "no-auth-basis"}`;
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

// ── 4. F-29 — one string, TWO guards ─────────────────────────────────────────
//
// `tenant_binding_violation` names two different mechanisms, and a grep for
// either one finds the other:
//
//   • a refusal CODE — emitted by `requireTenantBindingGuard`, which is
//     `requireTenantBinding` from the EXTERNAL `@adjudicate/primitives`. It is
//     `authGuards[0]` in five packs (orders, payments, reservations,
//     customer-onboarding, whatsapp).
//   • a basis REASON — stamped by the ownership guards' SECOND conjunct, the
//     session→principal IDOR gate (pack-orders policies.ts, pack-payments
//     policies.ts), on a refusal whose code is `<pack>.ownership_denied`.
//
// This is F-26's shadowing one level UP: F-26 was two conjuncts of ONE guard
// sharing a code; this is two independent GUARDS sharing a string across a
// package boundary. The decisions agree on refusal.kind AND on the auth basis
// code — every field an ownership test habitually asserts — so the FIELD the
// string lands in is the only thing that tells them apart, and `tenantId` (the
// input that selects which guard speaks) is exactly the field an author writing
// an ownership fixture is not thinking about.
//
// ── Why a pin and not a rename (recorded so it is not re-derived) ────────────
// Renaming was CONSIDERED AND DECLINED, on three grounds:
//   1. The colliding refusal code originates in `@adjudicate/primitives`, a
//      package this repo cannot change. Renaming our basis reason breaks the
//      exact-string collision but leaves the confusable CONCEPT live upstream —
//      a half-close.
//   2. A rename prevents grep confusion; it does not stop an author asserting
//      the wrong FIELD, which is the reachable mistake. Detection at the point
//      of failure beats renaming around it.
//   3. The basis reason is written to audit records; changing it is
//      operator-visible and splits historical grouping across the boundary.
// Out of scope for this slice, NOT permanently settled — escalated to the owner
// queue with the Q1/Q4 measurement below as its evidence.

/** The one string that means two things. */
const TENANT_STRING = "tenant_binding_violation";
/** Absence of a basis reason, made visible — the flat `drive` string fuses a
 *  missing reason with a literal one, and here that difference IS the finding. */
const ABSENT = "«absent»";

/** Which field of a decision carries `tenant_binding_violation`. */
function whereIsTheString(f: DecisionFields): string {
  const inCode = f.code === TENANT_STRING;
  const inReason = f.reason === TENANT_STRING;
  if (inCode && inReason) return "BOTH — CONFLATED";
  if (inCode) return "refusal.code";
  if (inReason) return "auth-basis detail.reason";
  return "neither";
}

function fieldRow(f: DecisionFields): Record<string, string> {
  return {
    refusalKind: f.refusalKind ?? ABSENT,
    authBasisCode: f.basisCode ?? ABSENT,
    code: f.code ?? ABSENT,
    reason: f.reason ?? ABSENT,
    where: whereIsTheString(f),
  };
}

/**
 * The fully-wired ownership fixture, cross-tenant AND with an intruder session —
 * so BOTH guards are armed to refuse and only the authGuards ORDER decides which
 * one speaks. The intruder session is load-bearing: measured, with the authentic
 * session the ownership guard passes, and moving `requireTenantBindingGuard` to
 * LAST produces the identical outcome — i.e. the fixture would be blind to the
 * short-circuit it exists to demonstrate.
 */
function tenantGuardOptions(row: Row): DriveOptions {
  return {
    row,
    orderId: OWNED,
    stamped: true,
    authority: true,
    sessionId: "sess-INTRUDER",
    tenantId: OTHER_TENANT,
  };
}
/** Cross-tenant: `requireTenantBindingGuard` (authGuards[0]) speaks. */
function tenantGuardDrive(row: Row) {
  return driveFields(tenantGuardOptions(row));
}
/** Host tenant + an intruder session on an OWNED resource: the IDOR conjunct. */
function idorDrive(row: Row) {
  return driveFields({
    row,
    orderId: OWNED,
    stamped: true,
    authority: true,
    sessionId: "sess-INTRUDER",
  });
}

describe("F-29 — `tenant_binding_violation` is a refusal CODE and a basis REASON, from two different guards", () => {
  it("the two mechanisms AGREE on refusal.kind and on the auth basis code — the FIELD the string lands in is the only discriminator, in BOTH packs", () => {
    const measured = {
      "orders / requireTenantBindingGuard": fieldRow(tenantGuardDrive(rowFor(ORDER_ANCHOR))),
      "orders / ownership IDOR conjunct": fieldRow(idorDrive(rowFor(ORDER_ANCHOR))),
      "payments / requireTenantBindingGuard": fieldRow(tenantGuardDrive(rowFor(PAYMENT_ANCHOR))),
      "payments / ownership IDOR conjunct": fieldRow(idorDrive(rowFor(PAYMENT_ANCHOR))),
    };

    // Hand-written, one literal row per mechanism — NOT derived from the drives.
    // Read the columns: `refusalKind` and `authBasisCode` are the SAME on every
    // row. Only `code`/`reason` move, and they move in opposite directions.
    expect(measured).toEqual({
      "orders / requireTenantBindingGuard": {
        refusalKind: "SECURITY",
        authBasisCode: "scope_insufficient",
        code: TENANT_STRING,
        reason: ABSENT,
        where: "refusal.code",
      },
      "orders / ownership IDOR conjunct": {
        refusalKind: "SECURITY",
        authBasisCode: "scope_insufficient",
        code: "order.ownership_denied",
        reason: TENANT_STRING,
        where: "auth-basis detail.reason",
      },
      "payments / requireTenantBindingGuard": {
        refusalKind: "SECURITY",
        authBasisCode: "scope_insufficient",
        code: TENANT_STRING,
        reason: ABSENT,
        where: "refusal.code",
      },
      "payments / ownership IDOR conjunct": {
        refusalKind: "SECURITY",
        authBasisCode: "scope_insufficient",
        code: "payment.ownership_denied",
        reason: TENANT_STRING,
        where: "auth-basis detail.reason",
      },
    });

    // The claim the table is FOR, stated so it cannot be read past: the string
    // occupies exactly ONE field per mechanism and they are DIFFERENT fields.
    // `BOTH — CONFLATED` is the value that appears the moment anyone merges the
    // two meanings onto one decision — which is precisely what this reds on.
    expect(Object.values(measured).map((r) => r.where)).toEqual([
      "refusal.code",
      "auth-basis detail.reason",
      "refusal.code",
      "auth-basis detail.reason",
    ]);
  });

  it("ALL EIGHT ownership-gated kinds reach BOTH guards, and the tenant guard runs FIRST — so a cross-tenant fixture never reaches the ownership guard at all", () => {
    // The reachability half of the finding, and the ORDER that makes it bite.
    // Every row arms BOTH guards (cross-tenant AND intruder session on an owned,
    // stamped resource with authority injected), so each row's outcome is
    // decided purely by which guard the bundle consults first. All eight say the
    // TENANT guard — that is `authGuards[0]`. Move that guard behind the
    // ownership guard and every row flips to `<pack>.ownership_denied`.
    // Iterated over the hand-written ROLL_CALL, asserted as a hand-written
    // literal map, so a dropped row reds by NAME.
    const measured = Object.fromEntries(
      ROLL_CALL.map((row) => [row.kind, drive(tenantGuardOptions(row))]),
    );
    const TENANT_REFUSAL = `REFUSE:${TENANT_STRING}:no-auth-basis`;
    expect(measured).toEqual({
      "order.cancel": TENANT_REFUSAL,
      "order.amend.request": TENANT_REFUSAL,
      "order.amend.add_item": TENANT_REFUSAL,
      "order.amend.update_qty": TENANT_REFUSAL,
      "order.amend.remove_item": TENANT_REFUSAL,
      "payment.refund.issue": TENANT_REFUSAL,
      "payment.refund.confirm": TENANT_REFUSAL,
      "payment.pix.regenerate": TENANT_REFUSAL,
    });

    // CONTROL — the SAME eight kinds, the SAME fixture, host tenant: none of
    // them refuses with the tenant code. Without this the row above is
    // satisfied by a bundle that refuses everything for some unrelated reason.
    const control = ROLL_CALL.map((row) =>
      drive({ ...tenantGuardOptions(row), tenantId: HOST_TENANT }),
    );
    expect(control.filter((o) => o.startsWith(`REFUSE:${TENANT_STRING}:`))).toEqual([]);
  });

  it("a `refusal.code` of `tenant_binding_violation` is EVIDENCE-FREE about the ownership guard: the SAME decision arrives with `state.authority` withheld, i.e. with the ownership guard inert", () => {
    // The reachable author mistake, reproduced. The fixture is a TEXTBOOK IDOR
    // setup — intruder session, OWNED resource, host stamp, authority graph
    // injected — and its only defect is a cross-tenant `tenantId`. A test that
    // asserted `refusal.code === "tenant_binding_violation"` here, believing it
    // had proved the IDOR conjunct, would be green with the ownership guard
    // DELETED: the two rows below are identical.
    const idorFixtureButCrossTenant = (row: Row, authority: boolean) =>
      drive({
        row,
        orderId: OWNED,
        stamped: true,
        authority,
        sessionId: "sess-INTRUDER",
        tenantId: OTHER_TENANT,
      });

    const measured = [rowFor(ORDER_ANCHOR), rowFor(PAYMENT_ANCHOR)].map((row) => [
      row.kind,
      idorFixtureButCrossTenant(row, true), // ownership guard LIVE
      idorFixtureButCrossTenant(row, false), // ownership guard INERT
    ]);
    const TENANT_REFUSAL = `REFUSE:${TENANT_STRING}:no-auth-basis`;
    expect(measured).toEqual([
      ["order.cancel", TENANT_REFUSAL, TENANT_REFUSAL],
      ["payment.refund.issue", TENANT_REFUSAL, TENANT_REFUSAL],
    ]);

    // CONTROL — the identical pair on the HOST tenant. Live-vs-inert must
    // DIFFER here, or "identical" above is a property of a drive that cannot
    // see the ownership guard rather than a property of the short-circuit.
    const control = [rowFor(ORDER_ANCHOR), rowFor(PAYMENT_ANCHOR)].map((row) => {
      const opts = {
        row,
        orderId: OWNED,
        stamped: true,
        sessionId: "sess-INTRUDER",
        tenantId: HOST_TENANT,
      };
      return [row.kind, drive({ ...opts, authority: true }), drive({ ...opts, authority: false })];
    });
    expect(control).toEqual([
      ["order.cancel", `REFUSE:order.ownership_denied:${IDOR_CONJUNCT}`, "EXECUTE"],
      [
        "payment.refund.issue",
        `REFUSE:payment.ownership_denied:${IDOR_CONJUNCT}`,
        "REQUEST_CONFIRMATION",
      ],
    ]);
  });

  it("the stand-in producer is EXTERNAL: the `tenant_binding_violation` refusal is authored by `@adjudicate/primitives`, not by any first-party guard", () => {
    // Why this matters, and why it is a pin rather than a comment: the shadowing
    // cannot be closed by renaming anything in this repo, because the producer
    // is upstream. These two literals exist ONLY in
    // @adjudicate/primitives/src/guards.ts (`requireTenantBinding`) — verified
    // by grep: neither appears anywhere in this repo's sources. If the external
    // guard's wording or behaviour ever changes, this test says so rather than
    // letting the shadowing quietly stop (or quietly start) mattering.
    const f = tenantGuardDrive(rowFor(ORDER_ANCHOR));
    expect(f.refusalDetail).toBe("actor is not bound to the tenant in state");
    expect(f.code).toBe(TENANT_STRING);

    // …and the first-party ownership guard authors a DIFFERENT refusal on the
    // same string, with its own pt-BR user-facing text. Two producers, one
    // string — which is the finding.
    const idor = idorDrive(rowFor(ORDER_ANCHOR));
    expect(idor.refusalDetail).not.toBe("actor is not bound to the tenant in state");
    expect(idor.reason).toBe(TENANT_STRING);
    expect(idor.code).not.toBe(TENANT_STRING);
  });
});
