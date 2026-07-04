# Ops-actor surface (NEW-032) — architecture decision

> Topic doc per `docs/architecture/decisions.md` convention. Decision of record for the
> ops-surface fork BKL-083 was blocked on. Owner-facing goal: "run the restaurant by
> message" — the owner/staff talk to the manager agent; every mutation is kernel-governed
> with role-aware authorization.

## The decision

**The LLM ops surface is the claustrum Conductor itself — a per-request-composed OPS
conductor plane — not a generic HTTP intent endpoint and not persona calls into the
per-action command services.**

Concretely:

1. **Envelope actor stamping (the security crux).** `createIbatexasPlanner` gains an
   optional, composition-time-injected `staffEnvelopeActor: { staffId, role }`. When
   present, `translateToolCalls` stamps every planned envelope's actor as
   `{ principal: "user", sessionId: "admin:${staffId}", role }` (the canonical
   `actorFor`/`principalFor` shape from `routes/admin/_shared-actions.ts`), keeping
   `taint: "UNTRUSTED"` (the payload is model-parsed; taint is payload provenance, and
   staff AUTHORITY is carried by `actor.role` + the `admin:` namespace, not by taint).
   When absent, behavior is byte-identical to today (`principal:"llm"`, conversation
   sessionId) — pinned by envelope-hash regression tests. The actor context is NEVER
   derived from model output or from `CognitiveState` text; it is a constant captured
   from the authenticated JWT at ingress and injected at conductor composition, following
   the proven per-trigger recomposition idiom of `live-agent-conductor.ts` (H1).

2. **Adjudication rides the conductor's existing composed router.** `handleTurn`'s
   SUBMIT stage already adjudicates via `IBATEXAS_POLICY_ROUTER` (the composed packs
   carrying `staffRoleGuard` + `paymentTransitionBandGuard` in every AUTH phase). With
   the `admin:`+role envelope from (1), the dormant staff guards become live, asserted
   gates on the LLM path — exactly the NEW-032 kernel goal. No second adjudication
   path is introduced; `runStaffOpsIntent` is NOT the LLM-path seam (it remains the
   guard-proof harness + available seam for future non-conversational ops callers).

3. **Ingress: `POST /api/admin/ops/chat`** behind `requireStaff` (JWT-only — no API-key
   conversational actor). The route captures `{staffId, staffRole}` from the JWT,
   composes the OPS conductor for the turn, opens the capsule with
   `actor: { principal: "user", role: "staff", sessionId: "admin:${staffId}", staffId }`
   and `conversationId = sessionId = "admin:${staffId}"`, and returns the turn reply
   synchronously (no SSE in v1). Role enforcement is layered: route preHandler
   (authentication) → capability planner (advertisement) → staffRoleGuard + matrix
   (kernel authorization) → per-kind pack guards.

4. **Ops tool-pack v1** (`@ibatexas/pack-ops` + an OPS-plane tool registry, separate from
   the chat registry so the chat roster/drift gates are untouched):
   - READ: `ops.snapshot.read` — the NEW-040 composition (alerts + incidents + kitchen +
     caixa) as a planner read tool, answering "como foi o dia? / como tá a cozinha?".
   - MUTATE: `product.availability.set` — NEW first-party governed kind (86-an-item /
     un-86; the NEW-001 unlock). Pack policy: payload `{productId, available, reason?}`,
     taint floor UNTRUSTED, and a pack AUTH guard that REFUSES any non-`admin:` session
     (staff-plane-only at the kernel regardless of surface — `staffRoleGuard`'s de-vacuum
     only covers `admin:` sessions, so the pack must fail-close the rest). Matrix row
     `{OWNER, MANAGER}` (mirrors the `PATCH /api/admin/products/:id` `requireManagerRole`
     band per the matrix's derivation rule). Executor = the same `medusaAdjudicated`
     PATCH the admin route uses (the egress wrapper is a distinct governance layer by
     design, D10 — not a duplicate intent adjudication).
   - MUTATE: `order.note.add` — existing matrixed kind (all 3 roles). Executor uses a
     new POST-adjudication domain write (`writeNote`-style, the executor body extracted
     from `addNoteFromEnvelope`, which now calls it too) — single write path, single
     adjudication, resolving the BKL-083 design fork as recommended (option b).
   - Everything else the model might emit is dropped by the planner allowlist, and
     REFUSEd by `staffRoleGuard`'s de-vacuum (`kind_not_in_staff_matrix`) or the packs'
     own guards if it somehow reaches the kernel. Money verbs, order transitions,
     reservations trio, alert/incident staff-plane promotion = registered follow-ups,
     not v1.

5. **Responder.** The ops plane reuses the responder port with an OPS persona; grounded
   facts come from executed read tools. The claims-not-prose invariant is a CUSTOMER-
   surface invariant (per CLAUDE.SDD.md scope); the ops channel is staff-facing. Any
   REQUEST_CONFIRMATION decision parks via the existing session port and the reply
   surfaces the kernel's own prompt honestly; conversational confirm-resume on the ops
   channel is a registered follow-up, not silently claimed.

## Why not the alternatives

- **(i) Generic `POST /api/admin/ops/intent` over `runStaffOpsIntent`:** redundant with
  the BKL-074-hardened per-action admin routes for every command-service-backed kind
  (a second HTTP mutation surface = drift), and it is not the LLM path — the conductor
  already owns adjudication for planned envelopes. BKL-083 is therefore resolved as
  WONT-BUILD-standalone; the seam file stays (tests prove the composed-bundle guard
  engagement end-to-end; future non-conversational ops automations may consume it).
- **(ii) LLM persona calling per-action command services:** the command services
  re-adjudicate against RAW bundles internally; driving them from a planner would either
  double-adjudicate every verb or bypass the composed router (losing the staff guards on
  the LLM path). It also fragments the ops surface per verb instead of one governed
  plane.

## WhatsApp ingress (BKL-086) — the owner runs the restaurant by message

The ops conductor plane is **ingress-agnostic**: only the ingress + identity
binding are per-channel. BKL-086 adds a SECOND ingress — WhatsApp — so the owner
types "acabou a picanha" and the AI manager acts, without the HTTP dashboard.

- **Fork placement.** In `handleMessageAsync` (the WhatsApp webhook async path),
  BEFORE `resolveWhatsAppSession` — the customer path auto-creates a Customer +
  welcome credit + LGPD opt-in, which an owner command must never trigger. The
  fork reuses the MessageSid idempotency + the phoneHash agent lock unchanged.
- **Allowlist = the Staff table.** `staffSvc.findByPhone(phone)` is re-read EVERY
  message (role + active — the STAFFREVOKE analog). No row OR `active:false` ⇒
  fall BACK to the customer path UNCHANGED (never ghost a demoted staffer, never
  mint an ops actor for a stranger's phone). The fall-back extends to a read
  ERROR: the fork runs for every inbound phone, so a Staff-table read failure
  fails OPEN to the customer path (`ops_wa.allowlist_read_failed`) rather than
  blacking out the customer channel — the phone gains no ops authority. This is
  scoped to the allowlist read only; a failure AFTER staff identity is
  established consumes with the honest ops apology.
- **Identity = the dashboard's.** conversationId `admin:{staffId}`, customerId
  `staff:{staffId}`, sessionKey `ops:{staffId}`, channel `"system"`, actor
  `{principal:"user", role:"staff", sessionId:"admin:{staffId}", staffId}` —
  IDENTICAL to `POST /api/admin/ops/chat`, so parks / history / confirm-resume are
  SHARED across ingresses (the ops-history thread is keyed by staffId alone).
- **The verb scope (the SIM-swap compensating control).** On WhatsApp the phone
  IS the identity (AUT-003); a signed message from a STOLEN owner phone is
  legitimate at every technical layer (Twilio signature, phone allowlist,
  `staff.active` re-check) — there is no second factor. So the WhatsApp scope
  keeps IRREVERSIBLE money / two-person verbs DASHBOARD-ONLY. `composeOpsConductor`
  takes an `opsVerbScope` (`"dashboard"` default | `"whatsapp"`); the `"whatsapp"`
  scope deterministically excludes a NAMED set (`WA_EXCLUDED_OPS_KINDS`, currently
  `payment.refund.issue`) at composition, in TWO places (defense in depth):
  1. `scopeCapabilityPlanner` removes the excluded kinds from the planner's
     `allowedIntents` — so they are NOT advertised AND are DROPPED if the model
     emits one anyway (the planner enforces the allowlist twice).
  2. `scopeResumeChannel` hides an out-of-scope PARKED envelope from
     `matchToParked` — so a money confirm parked from the dashboard can NEVER be
     resumed by an "sim" typed over WhatsApp (the dashboard still resumes it; the
     gate is scope-specific, not a blanket disable).
  `"dashboard"` excludes nothing ⇒ both filters are identity (the pre-BKL-086
  composition is byte-identical, pinned by tests). Money-over-WhatsApp is revisited
  only with a step-up factor (a daily ops PIN via the staff Twilio Verify infra —
  a registered v2 follow-up). Registered follow-ups: a dedicated ops WhatsApp
  number (`TWILIO_OPS_NUMBER`, to narrow the group/forward surface to a 1:1 line),
  the step-up PIN, and ops-channel media/interactive parsing.

## NEW-004 — price change by message (follow-on ops verb)

The owner types "aumenta o preço da picanha pra 95 reais" and the AI manager
re-prices the item — a new `@ibatexas/pack-ops`-OWNED kind `product.price.set`
(payload `{ productId, priceCentavos: integer, reason? }`, Hard Rule #2 integer
centavos only). It rides the SAME conductor plane, envelope-actor stamping, and
composed-router adjudication as `product.availability.set`; the deltas are:

- **Confirm-gated on taint (the BKL-085/PR #172 overlay shape).** A model-parsed
  price arrives `UNTRUSTED`, so the pack's business ladder ALWAYS
  REQUEST_CONFIRMATIONs it — a misparse would send a real price live. The prompt
  states the product NAME + old→new BRL ("Confirmar alteração de preço de
  Picanha: de R$ 89,00 para R$ 95,00?"). A TRUSTED/SYSTEM path (none exists yet)
  EXECUTEs per band — the overlay keys on `taint`. No ESCALATE band (price is
  reversible); a sanity REFUSE caps absurd values (> R$100.000,00, env
  `OPS_PRICE_MAX_CENTAVOS`; `<= 0` is caught structurally by the integer
  validator).
- **Matrix row `{OWNER, MANAGER}`** — the manager band, mirroring the admin
  products PATCH `requireManagerRole` precedent (the eleventh staff-plane kind).
- **REVERSIBLE ⇒ stays IN the WhatsApp verb scope** (NOT in
  `WA_EXCLUDED_OPS_KINDS`); since it CONFIRMs, the park/"sim" resume loop applies
  on BOTH ingresses (dashboard + WhatsApp), keyed by staffId — proven end-to-end
  in `ops-price-confirm-resume.e2e.test.ts`.
- **V1 variant contract.** Medusa v2 prices live per-variant; the shop DTO
  displays the LOWEST BRL variant price. Products carry a material mix of
  single-variant, multi-variant-uniform (P/M/G shirt all R$69), and
  multi-variant-DIVERGENT (500g R$89 / 1kg R$165). v1 sets EVERY BRL-priced
  variant to the confirmed price when they are UNIFORM (so the displayed price
  becomes the new price); it REFUSEs a product with DIFFERENTLY-priced variants
  ("preço por variação ainda não é suportado por mensagem") rather than guess
  which variation the owner meant.
- **Egress (D10).** The executor re-reads the product's BRL-priced variant ids
  and re-prices them via the SAME `medusaAdjudicated` admin call
  (`medusa.admin.product.update` → `POST /admin/products/:id` with a
  `variants[].prices[]` body; payload centavos → Medusa reais). No new egress
  kind; no route-layer side effect exists to reproduce (a price edit emits no
  NATS/event-log event today).

## Standing invariants this doc pins

- The ops plane's envelope actor is injected at composition from the authenticated JWT;
  no model output can influence `envelope.actor` on any plane.
- The customer/WhatsApp planes' envelope construction is byte-identical with the ops
  seam absent (hash-pinned regression tests).
- `product.availability.set` (and any future ops-pack kind) REFUSES non-`admin:`
  sessions at its own AUTH phase — staff-plane-only independent of the matrix guard.
- Ops mutations remain single-adjudication: composed-router gate → post-adjudication
  executor (never a second `*FromEnvelope` adjudication in the executor path).
