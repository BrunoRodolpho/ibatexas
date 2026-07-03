# DEFER-resume elevation contract (staff `actor.role`)

> **Status:** Accepted — BKL-069 Part D (2026-07-02). Governs how a role-gated
> staff-plane intent is authorized when it is parked by a kernel `DEFER` and
> later resumed. Companion to the Part B/C staff-role work
> (`apps/api/src/claustrum/staff-role-guard.ts`, `staff-role-matrix.ts`,
> `compose-policy-packs.ts`).

> The canonical `@adjudicate/*` / `@claustrum/*` design set is the upstream
> authority for kernel/adapter behaviour; this doc records the **adopter-side**
> (ibatexas) contract and its exact current coverage. On any conflict with the
> upstream kernel contract, surface it — do not silently resolve.

---

## 1. Context

`@adjudicate/core` 1.9.0 introduced `IntentActor.role`. Part B threads the
authenticated staff role onto `actor.role` for **exactly seven** staff-plane
kinds (`resolveActorRole` in `routes/admin/_shared-actions.ts`):

```
order.status.transition   payment.status.transition   payment.refund.issue
order.note.add            reservation.checkin         reservation.complete
reservation.cancel
```

Part C added an AUTH-phase `staffRoleGuard` (`createStaffRoleGuard` over
`STAFF_ROLE_CAPABILITY_MATRIX`) that fails closed on the staff plane: an
`admin:`-session envelope is authorized only when its kind is a known staff verb,
its `actor.role` is a known role, and that role is permitted for that kind. Part C
composes it into every pack's AUTH phase via `IBATEXAS_ADOPTER_AUTH_GUARDS`
(`buildIbatexasPolicyPacks` → the conductor's `composePolicyRouter` and the policy
manifest).

**The question this doc answers.** A kernel `DEFER` **parks** the proposed
envelope in Redis and resumes it later when a wire signal arrives. The kernel /
adapter resume path is deliberately role-free:

- `@adjudicate/adapter-core` `loop.ts` `resume()` builds a **new
  system-elevated** envelope (`principal: "system"`, taint `TRUSTED`, **no
  role** — it drops attestation and the original principal).
- The `@adjudicate/runtime` parked blob **preserves** `envelope.actorRole`;
  `verifyParkedEnvelopeHash` re-derives the hash **with** the role, so a
  role-carrying park round-trips without a false tamper verdict (adapter-core
  0.4.4 forwards `actorRole` at park time).

So `actor.role` survives *inside* the parked envelope, but the resume machinery
does not itself re-assert role authority. Who, then, guarantees a resumed
role-gated staff intent is still role-authorized at execute time?

---

## 2. Decision — Option 1

**Resume stays system-elevated / role-free at the kernel and adapter layer.** The
contract is that any surface which resumes or executes a parked, role-gated intent
MUST re-establish role authority **adopter-side**, by one of two seams (§4):

1. **Verbatim re-adjudication** of the parked envelope. Because `actor.role`
   rides inside the parked blob (and hashes clean), a role-aware guard re-runs on
   resume **iff the policy bundle used for the re-adjudication contains that
   guard**.
2. **Gating the resolver's role** at the resolve surface (an operator/staff must
   hold a sufficient role to trigger the resume/approval at all).

This keeps the kernel's park/resume primitive simple and role-agnostic, and puts
the staff-authorization obligation where the staff identity actually lives — the
adopter's HTTP + policy-composition layer.

### Options considered

| # | Option | Verdict |
|---|--------|---------|
| **1** | Resume role-free at kernel/adapter; re-establish role **adopter-side** (verbatim re-adjudication with a role-carrying bundle, and/or resolver-role gating). | **Chosen.** No kernel change; matches the existing adapter precedent; honest about current coverage (§3). |
| 2 | **In-kernel role re-elevation at resume** — the runtime re-derives and re-asserts `actor.role` from the parked blob and re-runs the role guard as part of `resume()`. | Deferred (future kernel work). Would make role enforcement intrinsic to resume rather than bundle-dependent, but requires an upstream `@adjudicate/runtime` + adapter-core change and a role-authority contract at the kernel boundary. |
| 3 | **Resolver-identity-carrying resume** — resume executes under the *resolver's* freshly-authenticated identity/role rather than the parked actor's, tying resume to an approve-and-execute step. | Deferred. Couples to **AUT-017** (approve-and-execute); changes the audit/lineage model (executor ≠ original proposer). Revisit when AUT-017 is built. |

---

## 3. Exact current coverage (no overstatement)

There are two resume/resolve paths in ibatexas today. Neither currently re-runs
`staffRoleGuard` over a role-gated **staff** envelope — and that is **sound**,
because no staff-plane kind can be parked in the first place. The findings:

### 3a. Which bundle does each resume path re-adjudicate with?

- **PIX defer-resolver** (`subscribers/defer-resolver.ts` →
  `adjudicate(envelope, orderState, orderPolicyBundle)`, ~:964) re-adjudicates
  against `ordersPolicyBundle` imported directly from `@ibatexas/pack-orders`
  (aliased locally as `orderPolicyBundle`, widened to
  `PolicyBundle<string, unknown, OrderState>`). This is the **raw pack-local
  bundle** — its `authGuards` are `requireTenantBindingGuard`,
  `requireAuthenticated`, `enforceOrderOwnership`, `requireCheckoutEligibility`.
  It does **NOT** include `IBATEXAS_ADOPTER_AUTH_GUARDS`, and therefore **NOT**
  `staffRoleGuard`. The resume path does not re-run the staff role guard.
  (Contrast: the conductor's composed router `policyForKind()` **does** prepend
  `staffRoleGuard`; the resolver bypasses the router and uses the pack bundle
  directly.)

- **Agent-approvals gateway** (`getAgentApprovalGateway().resolve` in
  `claustrum-bootstrap.ts`) re-adjudicates via `policyFor: (k) => policyForKind(k)`
  — the **composed** per-kind bundle, which **does** carry `staffRoleGuard`.
  However its only Stage-2 executing kind is the **agent-plane**
  `payment.pix.regenerate` (session `agent:…`, not `admin:…`), for which
  `staffRoleGuard` is **inert** by its `admin:` engagement predicate. So seam (i)
  is present here but does not currently gate any staff role.

### 3b. Which intent kinds can DEFER — can any of the seven staff kinds?

The **only** DEFER-producing guard anywhere in the pack set is
`createPixPendingDeferGuard` (from `@adjudicate/pack-payments-pix`), composed in
`pack-orders/policies.ts` as `deferOnPendingPix`, whose match predicate is:

```
matchesIntent: (kind) => kind === "order.checkout.create"    // and only when
                                                             // paymentStatus != null
```

No other pack (payments, reservations, whatsapp, customer-onboarding) returns a
`DEFER`. Therefore:

> **The only DEFER-able kind is `order.checkout.create`** — a *customer-plane*
> kind that never carries `actor.role` (Part B threads role onto staff kinds
> only) and is never proposed with an `admin:` session. **None of the seven
> staff-plane kinds can produce a `DEFER`** under any bundle used on the staff
> plane.

**Consequence:** the PIX defer-resolver's use of a role-guard-free bundle is not
a hole. The resolver only ever resumes `order.checkout.create` (customer, role-
free), so there is no role authority to re-establish on that path. Enforcement
seam (i) is *unreachable for staff kinds today*, not *broken*.

---

## 4. The two adopter-side enforcement seams

1. **Verbatim re-adjudication with a role-carrying bundle.** When a resume path
   re-adjudicates the parked envelope through a bundle that contains
   `staffRoleGuard` (i.e. the composed router / `policyForKind`, not the raw pack
   bundle), the guard re-runs against the parked `actor.role`: an absent, unknown,
   or unpermitted role REFUSEs on resume exactly as at first adjudication. This
   seam is **latent-correct** — it activates automatically the first time a
   role-gated staff kind becomes DEFER-able **and** is resumed through the
   composed router.

2. **Resolver-role gating at the resolve surface.** The staff HTTP resolve
   surface requires a sufficient role to trigger a resume at all. As of Part D,
   `POST /api/admin/agent-approvals/:token/resolve` carries a `requireManagerRole`
   preHandler (§5): resolving a parked agent intent is a MANAGER+ act
   (SCN-120 direction). This gates *who may resume*, independent of the parked
   actor's role.

---

## 5. Behaviour change in Part D — manager-gated agent-approval resolution

`POST /api/admin/agent-approvals/:token/resolve` previously inherited only the
admin guard (any authenticated staff — **including ATTENDANT** — or any
registry API key could resolve a parked agent intent). Part D adds a
`requireManagerRole` preHandler. This is the **one deliberate tightening** of the
BKL-069 build:

- Staff JWT: **OWNER / MANAGER** proceed; **ATTENDANT** → `403`.
- Registry API key: a key mapped to **OWNER / MANAGER** proceeds; an
  unmapped / bare key → `403` (fail-closed, via `requireManagerRole`'s API-key
  path).
- The `resolvedBy` audit shape is unchanged.

The `GET` list/detail routes are unchanged (read-only, no tightening).

---

## 6. Trigger conditions to revisit this decision

Revisit (and likely adopt Option 2 or 3) when **either** becomes true:

1. **The first staff-plane kind becomes DEFER-able.** If any of the seven staff
   kinds (or any future `admin:`-session kind) can produce a `DEFER`, the PIX-
   style resume path could resume a role-gated staff envelope through a bundle
   that lacks `staffRoleGuard`. At that point seam (i) must be made real — route
   the staff-kind resume through the composed router (`policyForKind`), or add
   `staffRoleGuard` to the resume bundle, or move role re-elevation into the
   kernel (Option 2). The drift-guard test
   (`defer-resume-staff-role-contract.test.ts`) fails if this precondition is
   introduced without revisiting this doc.

2. **AUT-017 approve-and-execute is built.** A resolver-identity-carrying resume
   (Option 3) changes the executor/lineage model and should be designed together
   with the approve-and-execute flow.

### Pre-deploy park note

Because no staff-plane kind can DEFER (§3b), a park created before a deploy and
resumed after it can only ever be an `order.checkout.create` (customer, role-
free). A migration hazard — a pre-deploy park of a role-gated staff kind resumed
by post-deploy code — is therefore **theoretical today**; it can only arise once
trigger condition (1) is met. When staff kinds do become DEFER-able, treat
in-flight parks across a role-model change as part of that deploy's migration
plan.
