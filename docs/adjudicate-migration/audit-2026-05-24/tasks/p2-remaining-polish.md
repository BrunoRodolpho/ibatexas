# P2 polish — 4 remaining items

**Status:** ✅ READY — parallel-safe; can spawn 2-3 sub-agents on disjoint file scopes. No user gate required.
**Closes:** the audit-2026-05-24 P2 backlog tail.
**Wall-clock:** ~3h serial, ~1.5h parallel across 2 agents.

---

## P2-4 — NATS subscriber queue group

**Severity:** P2 — operational hygiene; N-way handler inflation under multi-replica deploys.
**File:** NATS subscriber wiring (locate via `grep -rn "subscribeNatsEvent" apps/api/src/subscribers/`).
**Symptom:** Without a queue group, every replica's subscriber sees every message → N-fold handler inflation. Idempotent handlers absorb this today; not future-proof.
**Fix:** add a stable queue-group name to each `subscribeNatsEvent` call, e.g. `queueGroup: "anonymize-grace-resolver"` per subscriber.
**Acceptance:** each `subscribeNatsEvent` call has a `queueGroup` argument; one queue group per subscriber file; existing tests pass.
**Effort:** ~1h.

## P2-6 — Latent forgery: `actor.principal: "system"` mintable

**Severity:** P2 — defense-in-depth; not currently exploitable (HTTP-route inputs go through customer-intent-gateway which sets `principal: "customer"`) but the structural defense isn't in place.
**File:** `apps/api/src/...` customer-intent-gateway (locate via `grep -rn "buildCustomerEnvelope\|customer-intent-gateway" apps/api/src/`).
**Symptom:** the gateway accepts inputs that could theoretically mint `actor.principal = "system"` if the validator chain is bypassed.
**Fix:** assert at gateway entry that the incoming request CANNOT populate `actor.principal` — the gateway sets it itself to the literal `"customer"`. Compile-time guard via discriminated union; runtime fail-closed assertion.
**Acceptance:** gateway returns a 4xx if any input field tries to seed `actor.principal`; new test asserts the rejection.
**Effort:** ~2h.

## P2-7 — Latent forgery: `taint: "TRUSTED"` mintable

**Severity:** P2 — same defense-in-depth class as P2-6.
**File:** same customer-intent-gateway.
**Symptom:** customer HTTP routes could mint `taint: "TRUSTED"` if the input validator is bypassed.
**Fix:** same pattern as P2-6 — gateway sets `taint` itself based on its origin classification; refuses any input attempting to populate the field.
**Acceptance:** gateway returns a 4xx if any input field tries to seed `taint`; new test asserts.
**Effort:** ~1h.

**Bundling note:** P2-6 + P2-7 share the same file and the same fix shape — should be the same sub-agent + same commit.

## P2-8 — `medusa.store.cart.email.update` taxonomy mismatch

**Severity:** P2 — audit-record kind hygiene.
**File:** `packages/tools/src/medusa/store-adjudicated.ts` — the `carts.update` wrapper site.
**Symptom:** the kind `medusa.store.cart.email.update` is used for the `carts.update` wrapper even when the body is metadata-only (no email field present). The kind name leaks PII semantics into traces that don't actually carry PII.
**Fix:** split the kind — `medusa.store.cart.email.update` when payload has `email`; `medusa.store.cart.metadata.update` (or similar) otherwise. Per-kind redactor rules updated to match.
**Acceptance:** wrapper emits the email-bearing kind only when `email` is in payload; new test asserts both branches; redactor rules updated.
**Effort:** ~30min.

---

## Parallelization plan

| Sub-agent | Items | Files | Est. time |
|---|---|---|---|
| **Polish-A** | P2-4 | NATS subscriber wiring (multiple subscriber files) | 1h |
| **Polish-B** | P2-6 + P2-7 | customer-intent-gateway (one file) | 3h |
| **Polish-C** | P2-8 | `medusa/store-adjudicated.ts` (one file) | 30min |

All three sub-agents touch disjoint files — no merge conflicts.

## Ready-to-spawn sub-agent prompts

### Polish-A (P2-4)

> You are the P2-4 NATS queue-group agent. Per `docs/adjudicate-migration/audit-2026-05-24/tasks/p2-remaining-polish.md` §"P2-4". Find every call to `subscribeNatsEvent` under `apps/api/src/subscribers/` and add a `queueGroup` parameter. The queue-group name should be stable across deploys and unique per subscriber (e.g. `queueGroup: "anonymize-grace-resolver"` for the anonymize-grace-resolver). Update the `subscribeNatsEvent` signature in `@ibatexas/nats-client` if needed to accept `queueGroup`. Commit message: `fix(api,nats-client,audit-2026-05-24-P2-4): NATS subscriber queue groups`. Repo conventions per CLAUDE.md. Run `pnpm typecheck` for api + nats-client; run only the tests in files you touch.

### Polish-B (P2-6 + P2-7)

> You are the P2-6/P2-7 forgery-defense agent. Per `docs/adjudicate-migration/audit-2026-05-24/tasks/p2-remaining-polish.md` §"P2-6" and §"P2-7". Single file: customer-intent-gateway (locate via `grep -rn "customer-intent-gateway" apps/api/src/`). Add structural + runtime defenses so customer HTTP routes CANNOT mint `actor.principal = "system"` or `taint: "TRUSTED"`. The gateway sets both fields itself based on origin. Two new tests asserting 4xx rejection on forged inputs. Single commit `fix(api,audit-2026-05-24-P2-6+P2-7): customer-intent-gateway forgery defenses`. Repo conventions per CLAUDE.md. Run `pnpm typecheck` for api; run only the gateway tests.

### Polish-C (P2-8)

> You are the P2-8 medusa cart-update taxonomy agent. Per `docs/adjudicate-migration/audit-2026-05-24/tasks/p2-remaining-polish.md` §"P2-8". Single file: `packages/tools/src/medusa/store-adjudicated.ts` — the `carts.update` wrapper site. Split the emitted kind so `email`-bearing payloads use `medusa.store.cart.email.update` and metadata-only updates use a separate kind (suggest `medusa.store.cart.metadata.update`). Update the per-kind redactor rules in `packages/llm-provider/src/audit-redactor.ts` to match. Two new tests (one per branch). Single commit `fix(tools,llm-provider,audit-2026-05-24-P2-8): split medusa cart-update taxonomy`. Repo conventions per CLAUDE.md. Run `pnpm typecheck` for tools + llm-provider.

## Risk classification

- **Blast radius:** low (audit-record + subscriber wiring; no schema, no hot path)
- **Reversibility:** high (mechanical revert)
- **Replay impact:** P2-8 improves replay clarity; others neutral
- **Deployment risk:** low
