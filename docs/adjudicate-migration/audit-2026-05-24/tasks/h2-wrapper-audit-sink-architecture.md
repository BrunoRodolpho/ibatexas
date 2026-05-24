# H2 — Wrapper auditSink dep-cycle resolution

**Status:** 🚧 GATED on G1 architectural decision. Do NOT spawn implementation agent before decision.
**Severity:** P0-4 residue from audit-2026-05-24.
**Closes:** CLAUDE.md rule #9 ("every decision is audited") for cart-tool + WhatsApp-client egress paths.
**Unblocks:** T2 (AuditSink wrapper-call conformance suite).

---

## Objective

Resolve the `@ibatexas/tools` → `@ibatexas/llm-provider` dep-cycle that prevents wrapper call sites in `packages/tools/src/cart/*` and the whatsapp client from supplying `auditSink: getAuditSink()` to wrapper meta. Then make `auditSink` a **required** field on wrapper meta so the audit-trail hole cannot regress.

## Live state (verified 2026-05-24 post-R3 + corrected by H2-recon agent 2026-05-24 evening)

**Wrapper inventory.** Four wrappers; all still declare `auditSink` as optional:
- `packages/tools/src/twilio/adjudicated.ts:381` — `readonly auditSink?: AuditSink`
- `packages/tools/src/stripe/adjudicated.ts:355` — same
- `packages/tools/src/medusa/store-adjudicated.ts:539` — same
- `packages/tools/src/medusa/adjudicated.ts:501` — same

**Wrapper invocation counts (counted by H2-recon agent, NOT file-count).** Original task file undercounted: each cart-tool file can host multiple wrapper invocations.

| File | Invocations | In original scope? |
|---|---|---|
| `packages/tools/src/cart/add-to-cart.ts` | 1 | yes |
| `packages/tools/src/cart/apply-coupon.ts` | 1 | yes |
| `packages/tools/src/cart/remove-from-cart.ts` | 1 | yes |
| `packages/tools/src/cart/update-cart.ts` | 1 | yes |
| `packages/tools/src/cart/get-or-create-cart.ts` | 1 | yes |
| `packages/tools/src/cart/create-checkout.ts` | **7** | yes |
| `packages/tools/src/cart/amend-order.ts` | **9** | yes |
| `packages/tools/src/cart/regenerate-pix.ts` | 1 | yes |
| `packages/tools/src/cart/_stripe-helpers.ts` | 1 | yes |
| `packages/tools/src/cart/reorder.ts` | 2 | **NO — scope decision needed** |
| `packages/tools/src/cart/_shared.ts:54` (`createTooledOrderService` factory) | 1 | **NO — scope decision needed** |
| **Cart subtotal** | **26** | |
| `apps/api/src/whatsapp/client.ts` | 2 | yes |
| **Grand total** | **28** | |

**Already-passing sites (verified by grep — NOT a gap):** 18 sites across `apps/api/src/routes/cart.ts` (15), `apps/api/src/routes/stripe-webhook.ts` (4 — note count overlap with cart.ts since stripe-webhook.ts has 4 of its own), and `apps/api/src/routes/admin/products.ts` (1). Plus the 5 in `apps/api/src/routes/order-actions.ts`. All correctly thread `auditSink: getAuditSink()`.

**Architectural reality — corrects the original "Option A" premise:**
- `AuditSink` interface is ALREADY in `@adjudicate/audit` (registry-published leaf). Wrappers already import it from there. Nothing to extract for the interface itself.
- `getAuditSink()` lives in `packages/llm-provider/src/intent-audit-wiring.ts`. Its load-bearing deps include:
  - `getRedisClient` from `@ibatexas/tools` (Redis spill storage)
  - `rk()` from `@ibatexas/tools` (in sibling `redis-spill-storage.ts`)
  - `prisma` from `@ibatexas/domain` (Postgres sink)
  - `publishNatsEvent` from `@ibatexas/nats-client`
  - Sibling files `audit-redactor.ts`, `redis-spill-storage.ts`, `postgres-audit-writer.ts`, `logger.ts`

A naïve "extract to leaf package" would create the **inverse cycle** `@ibatexas/audit-sink → @ibatexas/tools` (via `getRedisClient`/`rk`). The cycle has to be broken either by DI (boot-time dep injection) or by relocating the adapters with type-only imports.

**Test-fixture impact:** ZERO. All 4 wrapper test files already pass `auditSink` in every meta literal (9, 12, 11, 13 sink-references respectively). Flipping `auditSink` to required at the type level is safe.

The cycle-avoidance comment at `packages/tools/src/cart/_shared.ts:18-26` is still load-bearing today.

## Architectural sub-options (G1 — choose one of A1 / A2 / A3)

### A1 — Pure builder, boot-time DI

**Mechanism:**
- New leaf package `@ibatexas/audit-sink` containing `getAuditSink` as a pure builder. It accepts injected dependencies via a `__setAuditSinkDependencies({redisClient, prismaWriter, natsPublisher, logger})` registration call at boot.
- The leaf has ZERO runtime deps on `@ibatexas/tools` or `@ibatexas/domain` — both are injected.
- `apps/api/src/index.ts` (or a new `audit-sink-bootstrap.ts`) calls `__setAuditSinkDependencies(...)` after the Redis + Prisma + NATS clients are constructed.
- `@ibatexas/llm-provider` re-exports `getAuditSink` from the leaf for one release cycle (back-compat).

**Pros:** cleanest layering; truly leaf-package; no cyclic anything.
**Cons:** introduces boot-order coupling; requires app-side initialization step before any envelope flows.
**Effort:** ~6-8h (leaf package + DI wiring + boot move + sweep 28 sites).
**Risk:** medium — boot-order bugs are subtle.

### A2 — Adapters move with leaf, type-only deps

**Mechanism:**
- New leaf package `@ibatexas/audit-sink` containing `getAuditSink`, redis-spill-storage, postgres-audit-writer adapters.
- Leaf depends on `@ibatexas/tools` ONLY for type-only imports (`import type { RedisListClient } from "@ibatexas/tools"`) — no runtime dep edge.
- Lazy-singleton fallback (current shape of `getAuditSink`) preserved; tools that need the sink get it without app-side initialization.

**Pros:** smaller behavioral delta from today; preserves the lazy-singleton ergonomics; type-only imports are TS-side only and don't create runtime cycles.
**Cons:** requires careful import discipline (linter rule + review); adapters move to a less-discoverable location.
**Effort:** ~5-7h (leaf package + adapter move + sweep 28 sites).
**Risk:** low-medium — TS type-only imports are well-understood.

### A3 — Thin interface leaf + app-side registration (RECOMMENDED)

**Mechanism:**
- New leaf package `@ibatexas/audit-sink` containing ONLY:
  - Re-export of `AuditSink` interface from `@adjudicate/audit`
  - A registration interface: `registerAuditSink(sink: AuditSink)` + `getAuditSink(): AuditSink`
- `getAuditSink` throws "audit sink not registered" if called before registration (fail-closed).
- `intent-audit-wiring.ts` STAYS in `@ibatexas/llm-provider` (no extraction). At app boot, it constructs the sink and calls `registerAuditSink(sink)` on the leaf.
- `@ibatexas/tools` imports `getAuditSink` from the leaf — gets the registered sink at runtime; no cyclic dep.

**Pros:** smallest blast radius; almost zero code movement; cleanest type-side enforcement; fail-closed by construction.
**Cons:** the leaf is small enough that someone might question why it exists vs. just registering via module-scoped state — but the package boundary is what enforces the no-cycle guarantee.
**Effort:** ~3-4h (leaf package + 1 wiring call + sweep 28 sites).
**Risk:** low — minimum surface area.

### Recommendation

**A3** — smallest blast radius, lowest risk, fastest. The other two (A1 / A2) buy more architectural purity but cost more hours for marginal gain over A3's strict-leaf-with-registration shape.

## Scope sub-decision: `reorder.ts` + `_shared.ts` factory in or out?

The 2 wrapper sites in `cart/reorder.ts` and the 1 factory wire in `cart/_shared.ts:54` (`createTooledOrderService`) were NOT in the original 14-site enumeration. They are real LLM-callable / system-actor mutation paths that should be audited.

**Default recommendation:** include both. The factory wire in `_shared.ts:54` may require threading `auditSink` into `createOrderService(domain)`'s `adminAdjudicated` parameter — verify the path; if it cascades into 3+ files in `@ibatexas/domain`, STOP and re-scope.

## Acceptance criteria (regardless of sub-option)

- All 28 wrapper-call sites (or 26 if reorder.ts + _shared.ts factory excluded by scope sub-decision) pass `auditSink: getAuditSink()` from the leaf.
- All 4 wrapper meta types have `auditSink` typed as **required** — not just optional.
- T2 conformance suite added under `apps/api/src/__tests__/bypass-detection/audit-sink-wrapper-conformance.test.ts` (static grep — every wrapper call has `auditSink:` in its meta literal).
- Existing wrapper tests still pass (they all already pass `auditSink` — verified zero-cascade).
- New integration test: spy on `getAuditSink()` and assert a Stripe / Twilio / Medusa-store wrapper call produces an `emit` invocation.
- `packages/tools/src/cart/_shared.ts:18-26` comment updated to reflect closure (or removed if no longer load-bearing).
- One commit per logical sub-step; commit messages follow the repo convention (`fix(audit-sink,tools,api,audit-2026-05-24-H2-...): ...`).

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

## Ready-to-spawn sub-agent prompt (FILL IN sub-option once G1 picks A1 / A2 / A3 and scope sub-decision)

> You are the H2 audit-sink architecture agent. The user's G1 decision is **{A1 | A2 | A3}** (default recommended: A3). The user's scope sub-decision is **{include | exclude}** `reorder.ts` (2 sites) and `_shared.ts:54` factory wire (1 site). Implement per `docs/adjudicate-migration/audit-2026-05-24/tasks/h2-wrapper-audit-sink-architecture.md` §"A{N}" and the scope decision. Hard requirements: (1) make `auditSink` REQUIRED at the type level on all 4 wrappers; (2) all {26|28} wrapper-call sites pass `auditSink: getAuditSink()`; (3) add the T2 conformance suite. Repo conventions: ESM `.js` extensions on local imports, vitest, no comments unless WHY is non-obvious, commit per logical sub-step. Skip `npm run build`; do NOT run dev servers. Run typecheck via `pnpm typecheck` for api + tools + audit-sink. Run `pnpm test` only on the new T2 suite + the wrapper unit tests you change. Report back with: (a) per-commit summary, (b) verification that all wrapper-call sites pass `auditSink` (grep evidence), (c) the T2 conformance suite's first run output, (d) any surprises. **If you uncover a 29th wrapper-call site or another file using `@adjudicate/audit`'s `AuditSink` interface outside the wrapper paths, STOP and report up — do not silently expand scope.**

## Risk classification

- **Blast radius:** medium (audit-trail surface, not request-handling path)
- **Reversibility:** high (revert the type-flip + call-site sweep)
- **Replay impact:** improves replay coverage for cart + whatsapp egress
- **Deployment risk:** low (no schema, no NATS, no Redis changes)
