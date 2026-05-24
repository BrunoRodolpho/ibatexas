# H2 — Wrapper auditSink dep-cycle resolution

**Status:** 🚧 GATED on G1 architectural decision. Do NOT spawn implementation agent before decision.
**Severity:** P0-4 residue from audit-2026-05-24.
**Closes:** CLAUDE.md rule #9 ("every decision is audited") for cart-tool + WhatsApp-client egress paths.
**Unblocks:** T2 (AuditSink wrapper-call conformance suite).

---

## Objective

Resolve the `@ibatexas/tools` → `@ibatexas/llm-provider` dep-cycle that prevents wrapper call sites in `packages/tools/src/cart/*` and the whatsapp client from supplying `auditSink: getAuditSink()` to wrapper meta. Then make `auditSink` a **required** field on wrapper meta so the audit-trail hole cannot regress.

## Live state (verified 2026-05-24 post-R3)

All four wrappers still declare `auditSink` as optional:
- `packages/tools/src/twilio/adjudicated.ts:381` — `readonly auditSink?: AuditSink`
- `packages/tools/src/stripe/adjudicated.ts:355` — same
- `packages/tools/src/medusa/store-adjudicated.ts:539` — same
- `packages/tools/src/medusa/adjudicated.ts:501` — same

Wrapper sites passing auditSink today (verified by grep): only `apps/api/src/routes/order-actions.ts` (5 sites — works because `apps/api/` can import from `@ibatexas/llm-provider`).

Wrapper sites NOT passing auditSink (verified by grep — empty result for `auditSink` in `packages/tools/src/cart/` and `apps/api/src/whatsapp/client.ts`):
- `packages/tools/src/cart/{add-to-cart, apply-coupon, remove-from-cart, update-cart, get-or-create-cart, create-checkout, amend-order, regenerate-pix, _stripe-helpers}.ts` — 12 sites
- `apps/api/src/whatsapp/client.ts` — 2 sites (`sendSingleMessage`, `sendMedia`)

**14 wrapper-call sites currently emit zero audit records.**

The deliberate-cycle-avoidance comment lives at `packages/tools/src/cart/_shared.ts:18-26`.

## Architectural options (G1)

### Option A — Extract `getAuditSink` to a leaf package (recommended)

**Mechanism:** New workspace package `@ibatexas/audit-sink` containing `AuditSink` interface, `getAuditSink()` factory, and (if needed) the persistent buffered sink + multi-sink composition. Both `@ibatexas/tools` and `@ibatexas/llm-provider` depend on the leaf — no cycle.

**Steps:**
1. `pnpm create` new workspace package `packages/audit-sink/`
2. Move `AuditSink` interface and `getAuditSink` (+ minimal transitive deps) from `@ibatexas/llm-provider` into the leaf
3. Re-export from `@ibatexas/llm-provider` for back-compat (one release cycle, then remove)
4. Add `@ibatexas/audit-sink` as a dep of `@ibatexas/tools` (and `@ibatexas/llm-provider`)
5. Make `auditSink` required on all 4 wrapper meta types
6. Update all 14 wrapper-call sites to pass `auditSink: getAuditSink()`
7. Update `packages/tools/src/cart/_shared.ts:18-26` comment to reflect closure
8. Land T2 conformance test (see [hardening-conformance-followup.md](./hardening-conformance-followup.md))

**Effort:** 4-6h (~2h package extract + 2h call-site sweep + 1-2h tests).

### Option B — DI via module-scoped default

**Mechanism:** A module-level `__setDefaultAuditSink(sink)` registered at app boot; wrappers fall back to it when `meta.auditSink` is undefined.

**Trade-offs:**
- Pro: zero call-site changes (the wrapper just gets a non-undefined sink at runtime).
- Con: introduces module-scoped state — risks test-pollution between suites, makes the "audited by construction" claim harder to enforce.
- Con: cannot make `auditSink` required at the TYPE level — only at runtime. T2 conformance must inspect runtime behavior, not call-site shape.

**Effort:** 3-4h.

### Option C — Caller-emits-audit pattern

**Mechanism:** Remove `auditSink` from wrapper meta entirely. Wrapper returns the unemitted `AuditRecord`; caller is responsible for emitting it.

**Trade-offs:**
- Pro: clean separation; wrapper is purely "policy + dispatch."
- Con: inverts the "audited by construction" contract — easy to forget to emit.
- Con: every caller must import `AuditSink`, breaking the same cycle in the opposite direction.

**Effort:** 4-6h.

## Acceptance criteria (regardless of option)

- All 14 wrapper-call sites either pass `auditSink` (A) or receive it via DI (B) or emit themselves (C).
- All 4 wrapper meta types have `auditSink` typed as **required** (A) — not just optional.
- T2 conformance suite added under `apps/api/src/__tests__/audit-2026-05-24/audit-sink-wrapper-conformance.test.ts` (or `bypass-detection/` if static-grep based).
- Existing wrapper tests still pass; new tests assert that an audit record was emitted for at least one Stripe / Twilio / Medusa-store wrapper call.
- `packages/tools/src/cart/_shared.ts:18-26` comment updated to reflect closure (or removed if no longer load-bearing).
- One commit per logical sub-step; commit messages follow the repo convention (`fix(tools,api,audit-2026-05-24-H2-...): ...`).

## Required tests

- Unit tests for the leaf-package factory (Option A) covering get / cache / clear semantics.
- Integration test: spy on `getAuditSink()` and assert a Stripe wrapper call produces an `emit` invocation with a record of `kind = "stripe.payment_intent.confirm"` (or equivalent for Twilio / Medusa-store).
- T2 conformance suite (per spec in [hardening-conformance-followup.md](./hardening-conformance-followup.md)).

## Observability

- No new metrics required; existing `getAuditSink()` instrumentation captures the path.
- Operator note: post-deployment, query Postgres `intent_audit` for `kind LIKE 'stripe.%' OR kind LIKE 'twilio.%' OR kind LIKE 'medusa.store.%'` to confirm rows are now landing. Should rise from ~zero to nominal traffic levels.

## Rollback

- Option A: revert the requirement-flip on wrapper meta (make `auditSink` optional again) — emit holes return but no breaking type errors at call sites; emit holes are observable.
- Option B: clear the default via `__setDefaultAuditSink(undefined)` — wrappers immediately stop emitting.
- Option C: re-add the meta field; callers continue to emit redundantly (no harm).

## Dependencies

- None on current code.
- Blocks T2 conformance suite (must land after this).
- T2 in turn protects future regressions.

## Ready-to-spawn sub-agent prompt

> You are the H2 audit-sink architecture agent. The Bucket H2 (P0-4 wrapper auditSink dep-cycle) decision is **Option A** (extract `getAuditSink` to a new leaf package `@ibatexas/audit-sink`). Implement per `docs/adjudicate-migration/audit-2026-05-24/tasks/h2-wrapper-audit-sink-architecture.md` §"Option A". Hard requirements: (1) make `auditSink` REQUIRED at the type level on all 4 wrappers (twilio, stripe, medusa, medusa-store); (2) all 14 wrapper-call sites enumerated in the task file must pass `auditSink: getAuditSink()`; (3) add the T2 conformance suite per [hardening-conformance-followup.md](./hardening-conformance-followup.md). Repo conventions: ESM `.js` extensions on local imports, vitest, no comments unless WHY is non-obvious, commit per logical sub-step. Skip `npm run build`; do NOT run dev servers. Run typecheck via `pnpm typecheck` for api + tools + audit-sink. Run `pnpm test` only on the new T2 suite + the wrapper unit tests you change. Report back with: (a) file diff list, (b) commit hashes, (c) verification that the 14 call sites no longer skip emit (grep evidence), (d) any surprise findings outside the scope of the task file. **If you uncover a fifth wrapper or a 15th call site not listed in the task file, STOP and report up — do not silently expand scope.**

*Substitute "Option B" or "Option C" if the user picks differently; update §"Hard requirements" accordingly.*

## Risk classification

- **Blast radius:** medium (audit-trail surface, not request-handling path)
- **Reversibility:** high (revert the type-flip + call-site sweep)
- **Replay impact:** improves replay coverage for cart + whatsapp egress
- **Deployment risk:** low (no schema, no NATS, no Redis changes)
