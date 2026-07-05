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
| 3 | **Resolver-identity-carrying resume** — resume executes under the *resolver's* freshly-authenticated identity/role rather than the parked actor's, tying resume to an approve-and-execute step. | **Still deferred.** **AUT-017 (2026-07-04) shipped as Option 1, NOT Option 3** (§3d): the approve-and-execute loop keeps the parked PROPOSER as the envelope actor and records the approver as PROVENANCE (`Supersession.binding.approver` + the projection's `resolvedBy`), so it did NOT need the executor≠proposer actor-substitution Option 3 describes. Option 3 remains a future choice only if the audit/lineage model must change so the executor identity *replaces* the actor. |

---

## 3. Exact current coverage (no overstatement)

There are **four** resume/resolve surfaces in ibatexas today (§3a). None re-runs
`staffRoleGuard` over a role-gated **staff** envelope — and that is **sound**,
because no staff-plane kind can be parked in the first place: every DEFER-able
kind (§3b) is customer-plane / role-free. The findings:

### 3a. The four resume/resolve surfaces, and which bundle (if any) each re-adjudicates with

1. **PIX defer-resolver** (`subscribers/defer-resolver.ts` →
   `adjudicate(envelope, state, orderPolicyBundle)`) re-adjudicates the resumed
   envelope against `ordersPolicyBundle` imported directly from
   `@ibatexas/pack-orders` (aliased locally as `orderPolicyBundle`, widened to
   `PolicyBundle<string, unknown, OrderState>`). This is the **raw pack-local
   bundle** — its `authGuards` are `requireTenantBindingGuard`,
   `requireAuthenticated`, `enforceOrderOwnership`, `requireCheckoutEligibility`.
   It does **NOT** include `IBATEXAS_ADOPTER_AUTH_GUARDS`, and therefore **NOT**
   `staffRoleGuard`. (Contrast: the conductor's composed router `policyForKind()`
   **does** prepend `staffRoleGuard`; this resolver bypasses the router and uses
   the pack bundle directly.)

2. **Agent-approvals gateway** (`getAgentApprovalGateway().resolve` in
   `claustrum-bootstrap.ts`) re-adjudicates via `policyFor: (k) => policyForKind(k)`
   — the **composed** per-kind bundle, which **does** carry `staffRoleGuard`.
   However its only Stage-2 executing kind is the **agent-plane**
   `payment.pix.regenerate` (session `agent:…`, not `admin:…`), for which
   `staffRoleGuard` is **inert** by its `admin:` engagement predicate. So the
   role-carrying re-adjudication seam is present here but does not currently gate
   any staff role.

3. **Anonymize-grace-resolver** (`subscribers/anonymize-grace-resolver.ts`)
   resumes the parked `customer.anonymize` when its 24h grace elapses, by calling
   `anonymizeCustomer(...)` at module level — it does **NOT** re-adjudicate
   through any policy bundle at all. By design: the DEFER verdict was reached at
   park time and "the grace window expired without a cancel" IS the resume
   signal, so the destructive call does not re-enter the kernel (it emits a
   system-actor `EXECUTE` audit record with a `supersedes` link instead). **This
   is a live precedent of resume-WITHOUT-re-adjudication in ibatexas** — and it
   is sound here only because `customer.anonymize` is a customer-plane, role-free
   kind (no `actor.role`, never an `admin:` session).

4. **PIX-defer-timeout-resolver** (`subscribers/pix-defer-timeout-resolver.ts`)
   is audit/observability only: when a parked PIX checkout reaches its TTL
   without confirmation it emits **one** system-actor audit record and performs
   **no** re-adjudication and **no** state mutation (the DB-side
   `payment.status.transition` is owned by the separate `pix-expiry-checker`
   cron, which drives its own kernel-gated envelope). No role authority is
   involved.

### 3b. Which intent kinds can DEFER — can any of the seven staff kinds?

There are **three** DEFER-producing guards in the pack set (not one). All three
match a **customer-plane, role-free** kind; none matches a staff-plane kind:

1. **`createPixPendingDeferGuard`** (from `@adjudicate/pack-payments-pix`),
   composed in `pack-orders/policies.ts` (`pixPendingDeferBase` ~:496 wrapped as
   `deferOnPendingPix` ~:513). Matches **`order.checkout.create`**, and only when
   `state.ctx.paymentStatus != null` (an in-flight, non-null unconfirmed PIX — a
   fresh checkout with null status EXECUTEs). Proposed by customer / LLM; never
   carries `actor.role`; never an `admin:` session.

2. **`anonymizeGraceDeferBase`** (`createStateDeferGuard`), composed in
   `pack-customer-onboarding/policies.ts` (base ~:441, wrapped as
   `deferAnonymizeForGrace` ~:464, in the bundle ~:608). Matches
   **`customer.anonymize`** on the `CUSTOMER_ANONYMIZE_GRACE_SIGNAL` with a 24h
   timeout (skipped when `state.ctx.immediateErasure === true`, the authenticated
   immediate-erasure HTTP path). A customer-plane LGPD kind; role-free.

3. **`deferChargeCreate`** (`createStateDeferGuard`) in the installed
   `@adjudicate/pack-payments-pix` `pixPolicyBundle.business`. Matches
   **`pix.charge.create`** on `PIX_CONFIRMATION_SIGNAL` with a 15-min timeout —
   verified present in `node_modules/.../pack-payments-pix/dist/policies.js`
   (`paymentsPixPack` is installed into the kernel registry at boot via
   `installFirstPartyPacks` → `installPack`). **But it is unreached by any live
   ibatexas envelope today:** `paymentsPixPack` is NOT part of
   `IBATEXAS_COMPOSED_PACKS`, so the conductor router `policyForKind` never routes
   `pix.charge.create`; and no ibatexas surface ever constructs a
   `pix.charge.create` envelope (the wire vocabulary uses `order.checkout.create`
   plus the composed `createPixPendingDeferGuard` from producer #1 instead). It is
   in any case a customer-plane / role-free kind (UNTRUSTED, proposed by the
   customer/LLM, never `admin:`).

> **Every DEFER-able kind is customer-plane / role-free** —
> `order.checkout.create`, `customer.anonymize`, and the installed-but-unreached
> `pix.charge.create`. None carries `actor.role` (Part B threads role onto the
> seven staff kinds only) and none is proposed with an `admin:` session. **None
> of the seven staff-plane kinds can produce a `DEFER`** under any bundle. The
> census-intersection is provable: `{DEFER-able kinds} ∩ STAFF_PLANE_KINDS = ∅`
> (asserted by `defer-resume-staff-role-contract.test.ts`, §3 of that file).

**Consequence:** the PIX defer-resolver's use of a role-guard-free bundle (surface 1)
and the anonymize-grace-resolver's resume-without-re-adjudication (surface 3) are
not holes. Each only ever resumes a customer-plane, role-free kind, so there is no
role authority to re-establish on those paths. The role-carrying re-adjudication
seam (surface 2) is *unreachable for staff kinds today*, not *broken*.

### 3c. BKL-085 — the FIFTH surface: the ops-plane CONFIRM-resume (seam 1 made real)

> **Added by BKL-085 (2026-07-04).** The refunds-by-message verb introduces the
> first **CONFIRM-parkable staff-plane kind** — and it is resumed through a
> role-carrying bundle, so **§4 seam 1 is now LIVE**, not latent. This is a
> deliberate, documented activation; it does NOT loosen any assertion.

**Confirm-parking is not DEFER-parking.** The trigger-condition census (§3b, §6) and
`defer-resume-staff-role-contract.test.ts` track kernel **`DEFER`** decisions
(`decisionDefer` from a bundle's DEFER guard). BKL-085 adds an
**UNTRUSTED-taint refund CONFIRM overlay** to `pack-payments`' `refundMagnitudeGuard`
(`REQUEST_CONFIRMATION`, not `DEFER`), so `payment.refund.issue` becomes
**confirm-parkable** on the ops plane while `{DEFER-able kinds} ∩ STAFF_PLANE_KINDS`
stays **∅** (the drift test remains green — verified). Trigger condition (1) is about
DEFER and is **not** met.

**The resume surface + why it is sound.** A REQUEST_CONFIRMATION parked on the ops
conductor resumes via the `OpsSystemChannel.matchToParked` driver ("sim, confirma"
→ `capsule.resume`). `capsule.resume` re-adjudicates the VERBATIM parked envelope
(admin:`+role preserved) through the SAME composed router (`resolution.policy` =
`IBATEXAS_POLICY_ROUTER`) the ops turn used — which **carries `staffRoleGuard` + the
staff-role matrix** (prepended by `buildIbatexasPolicyPacks`). So on resume:
`staffRoleGuard` **re-runs against the parked `actor.role`** (an ATTENDANT-forged
refund REFUSEs on resume exactly as at first adjudication), the taint overlay
re-fires REQUEST_CONFIRMATION, and only the matching `confirmationReceipt`
(`intentHash`) flips it to EXECUTE. **This is exactly §4 seam 1 (verbatim
re-adjudication with a role-carrying bundle) — activated for the first time.**

**Resume-state note (BKL-085).** The shared adjudicator's resume-state enrichment
(`buildAdjudicator.resume` → `enrichResumeState`) re-projects per-envelope state via
the customer-scoped `resolveAndAssemble`, which is scoped to a real `customerId` —
the ops plane's `staff:<id>` owns no customer resources, so it would project
`exists:false` and REFUSE a legitimate confirm-resume. BKL-085 adds an **ops branch**
to `enrichResumeState`: an `admin:`-session `payment.refund.issue` re-projects its
`PaymentState` from the payment row read by the parked, DB-stamped `paymentId`
(`buildOpsRefundResumeState`). A FRESH read keeps it money-safe: a since-parked
terminal / partial refund still REFUSEs (terminal guard / the magnitude guard's
divergence check reads the live `refundedAmountCentavos`). The kernel re-runs every
guard; the receipt only satisfies the "ask first" threshold.

**Defer of a confirm-park.** `matchToParked` also accepts a pt-BR defer phrase
("amanhã"): the conductor re-parks the confirm envelope as **deferred**. The ops
plane has **no** background defer resolver (the four surfaces above are all
customer-plane), so a deferred ops refund **never auto-resumes** — it simply lapses
at TTL and the staff re-issues the command. No unauthorized EXECUTE path exists;
this is safe by construction (not a hole).

### 3d. AUT-017 — the SIXTH surface: the ESCALATE→OWNER-approve→executable-resume loop

> **Added by AUT-017 (2026-07-04).** The first surface that resumes an
> **ESCALATE**-parked staff-plane money intent. Built as **Option 1** (below), it
> re-adjudicates the VERBATIM parked envelope through the composed router — so
> **§4 seam 1 is exercised for ESCALATE too** — and adds a resolver-role gate
> (seam 2). Option 3 (resolver-identity-carrying resume) stays **deferred**: the
> parked PROPOSER remains the envelope actor; the approver is PROVENANCE only.

**Escalation-park is neither DEFER-park nor CONFIRM-park.** When an above-threshold
`payment.refund.issue` ESCALATEs, the adopter HandoffPort (`natsHandoff`, wired with
`parkDeps`) parks the FULL envelope in a NEW single-use Redis store
(`escalation:park:<token>`, `apps/api/src/escalation/escalation-park-store.ts`)
BEFORE the `support.handoff_requested` publish — the envelope payload itself NEVER
rides NATS (only an opaque `parkToken` + `intentHash` + a pt-BR summary do). This is
a THIRD park flavour alongside kernel DEFER and the taint-overlay CONFIRM; it does
**not** touch the kernel DEFER census, so `{DEFER-able kinds} ∩ STAFF_PLANE_KINDS`
stays **∅** and `defer-resume-staff-role-contract.test.ts` remains green (verified).

**The resume surface + why it is sound.** An OWNER approves from the escalações
surface (`POST /api/admin/escalations/:sessionId/intents/:token/resolve`,
`requireOwnerRole`). The approval engine
(`apps/api/src/escalation/escalation-approval.ts`) single-use CONSUMEs the park,
rebuilds the IDENTICAL envelope (same kind/payload/**actor.role**/taint/nonce → same
`intentHash`), re-projects the FRESH `PaymentState` (`enrichResumeState` →
`buildOpsRefundResumeState`, a live DB read; null ⇒ REFUSE), stamps a
`state.ctx.escalationApproval` marker (STATE, never payload → `intentHash` unchanged,
unforgeable from the wire), and re-adjudicates through the SAME composed router
(`policyForKind`, carrying `staffRoleGuard` + the staff-role matrix) with a
`confirmationReceipt`. On resume: `staffRoleGuard` **re-runs against the parked
`actor.role`** (an ATTENDANT-forged park REFUSEs); the pack's escalate-band overlay
sees the marker and returns REQUEST_CONFIRMATION; and only the matching receipt
(`intentHash`) flips THAT to EXECUTE (`confirmation_resolved` supersession with the
bound `approver`). Every state/taint/auth guard re-runs on the fresh state — a
since-parked terminal/partial refund REFUSEs (the magnitude guard's divergence check
reads the live `refundedAmountCentavos`). A receipt-less conversion stops at
REQUEST_CONFIRMATION — friction, never bypass; the overlay is MONOTONIC (it converts
only the escalate band's OWN ESCALATE, never rescues a REFUSE).

**Separation of duty (three gates).** (1) `requireOwnerRole` on the resolve route —
only an OWNER may resume; (2) the approval module refuses a self-approval
(`proposerId === approver.id`) WITHOUT burning the token (a different owner can still
approve); (3) the pack overlay's deepest structural gate — the escalate band converts
ONLY when `escalationApproval.approverId !== payload.actorId` (the DB-stamped proposer),
so even a slipped self-approval marker cannot flip the verdict.

**Provenance (Option 1).** The kernel receipt records no approver; provenance is the
`Supersession.binding.approver` (the confirmed `staff:<approverId>`, forensic) + the
escalation record's `pendingIntents[].resolvedBy` projection. The write's author is
the approver (the refund trio runs with `actorId = approver`). The envelope actor
stays the parked proposer — the kernel never substitutes a new actor.
`verifyEscalationApprovalLineage` ties it: an ESCALATE row + a resumed EXECUTE row for
the `intentHash` + an approved projection carrying `resolvedBy`.

---

## 4. The two adopter-side enforcement seams

1. **Verbatim re-adjudication with a role-carrying bundle.** When a resume path
   re-adjudicates the parked envelope through a bundle that contains
   `staffRoleGuard` (i.e. the composed router / `policyForKind`, not the raw pack
   bundle), the guard re-runs against the parked `actor.role`: an absent, unknown,
   or unpermitted role REFUSEs on resume exactly as at first adjudication. This
   seam is **latent-correct** — it activates automatically the first time a
   role-gated staff kind becomes DEFER-able **and** is resumed through the
   composed router. **As of BKL-085 (2026-07-04) this seam is LIVE** — the
   ops-plane `payment.refund.issue` CONFIRM-resume re-adjudicates through the
   composed router carrying `staffRoleGuard` (§3c). (It activated via
   CONFIRM-parking, not DEFER — the same seam, one turn earlier than the DEFER
   trigger in §6 anticipated.)

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

1. **The first staff-plane kind becomes DEFER-able.** Today the DEFER-able set is
   `{order.checkout.create, customer.anonymize, pix.charge.create}` (§3b — three
   producers across `pack-orders`, `pack-customer-onboarding`, and the installed
   `pixPolicyBundle`), all customer-plane / role-free. If any of the seven staff
   kinds (or any future `admin:`-session kind) is added to that set, a
   role-guard-free resume path could resume a role-gated staff envelope: the PIX
   defer-resolver (§3a surface 1, raw `ordersPolicyBundle`) or the
   anonymize-grace-style resume-without-re-adjudication (§3a surface 3). At that
   point §4 seam 1 must be made real — route the staff-kind resume through the
   composed router (`policyForKind`), or add `staffRoleGuard` to the resume
   bundle, or move role re-elevation into the kernel (Option 2). The drift-guard
   test (`defer-resume-staff-role-contract.test.ts`) fails if any staff kind
   becomes DEFER-able through its OWNING production bundle, and its
   census-intersection assertion fails if the maintained DEFER-able-kind const
   ever intersects `STAFF_PLANE_KINDS` — either trips before this precondition can
   ship silently.

2. ~~**AUT-017 approve-and-execute is built.**~~ **DONE (2026-07-04, §3d)** — built
   as **Option 1** (verbatim re-adjudication through the composed router + a
   resolver-role gate + approver-as-provenance), NOT the resolver-identity-carrying
   Option 3. Revisit Option 3 only if a future requirement makes the executor
   identity *replace* the parked actor in the audit/lineage model.

### Pre-deploy park note

Because no staff-plane kind can DEFER (§3b), a park created before a deploy and
resumed after it can only ever be one of the customer-plane, role-free DEFER-able
kinds (`order.checkout.create` or `customer.anonymize`; `pix.charge.create` is
installed but unreached). A migration hazard — a pre-deploy park of a role-gated
staff kind resumed by post-deploy code — is therefore **theoretical today**; it
can only arise once trigger condition (1) is met. When staff kinds do become
DEFER-able, treat in-flight parks across a role-model change as part of that
deploy's migration plan.
