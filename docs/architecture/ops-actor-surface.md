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

## Standing invariants this doc pins

- The ops plane's envelope actor is injected at composition from the authenticated JWT;
  no model output can influence `envelope.actor` on any plane.
- The customer/WhatsApp planes' envelope construction is byte-identical with the ops
  seam absent (hash-pinned regression tests).
- `product.availability.set` (and any future ops-pack kind) REFUSES non-`admin:`
  sessions at its own AUTH phase — staff-plane-only independent of the matrix guard.
- Ops mutations remain single-adjudication: composed-router gate → post-adjudication
  executor (never a second `*FromEnvelope` adjudication in the executor path).
