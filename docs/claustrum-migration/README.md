# Claustrum Migration — ibatexas record

> 1-page overview of the cutover from `@ibatexas/llm-provider` to the standalone
> `@claustrum/*` runtime spine. This folder is the operator's history of what
> changed, why, and what remains. Read this first.

---

## What changed

ibatexas no longer ships its own conversational-AI runtime. The 4-layer
Hybrid State-Flow pipeline that used to live in `packages/llm-provider/` is
gone; ibatexas now **consumes** `@claustrum/*` packages from a sibling repo
(`/Users/thaisrodolpho/projects/claustrum/`) the same way it consumes
`@adjudicate/*`.

Per-request flow is now:

1. ibatexas's HTTP route opens a `Capsule` via `conductor.openCapsule()`
2. `conductor.handleTurn(capsule, message)` runs claustrum's cognitive loop
   (`perceive → understand → plan → submit → act → synthesize → observe`)
3. Every mutation flows through `Adjudicator.adjudicate()` (wraps
   `@adjudicate/core`) before any tool fires
4. Channel driver (`WhatsAppChannel` or `WebChannel`) renders the response

ibatexas's only job is to register **domain tools** as `ToolPack`s and provide
**tenant policy**. Claustrum owns prompts, the cognitive loop, channel
adapters, memory, and grounding.

## Why

Three-pillar architecture: **apps → runtime → kernel**, separated by
evolution rate.

- `@adjudicate/*` (kernel) — slowest-evolving. Every mutation is gated here.
- `@claustrum/*` (runtime) — medium-evolving. Cognitive loop, prompts,
  channels. Now standalone so other adopters (healthcare, scheduling, etc.)
  can use it without taking on ibatexas's commerce domain.
- ibatexas (app) — fastest-evolving. Commerce-specific entities, tools,
  business rules.

Before the cutover, runtime and app were entangled inside ibatexas. The
runtime was leaking into commerce concerns (`order-machine.ts`, cart
guards), and adopters had no way to reuse it.

## File inventory

### New (added in commit `4b6cb68`)

| Path | Purpose |
|---|---|
| `apps/api/src/claustrum-bootstrap.ts` | Composition root. Instantiates `Conductor` with provider impls, registers ToolPacks, resolves tenant policy. Runs once at process start. |
| `apps/api/src/tools/register-ibatexas-tool-packs.ts` | First-pass: registers 3 domain tools as `ToolDefinition` (cart.addItem, cart.checkout, order.cancel). Full 25-tool roster is incremental work. |
| `apps/api/src/routes/__shared__/customer-intent-gateway.ts` | Preserves the `CustomerEnvelope` narrowing + `detectForgery()` + Decision-handling switch from PART X.1 §9 — now routing through `conductor.adjudicator`. |
| `apps/api/src/routes/chat.ts` | Rewritten (291 → ~210 LOC). POST opens capsule, runs `handleTurn`, streams to SSE; GET unchanged. |
| `apps/api/src/routes/whatsapp-webhook.ts` | Rewritten (586 → ~165 LOC). Preserves Twilio signature, idempotency, rate-limit; delegates to claustrum. |

### Pending deletion (deferred until real Twilio smoke test passes)

| Path | Replaced by |
|---|---|
| `packages/llm-provider/` (entire package) | `@claustrum/core` + `@claustrum/anthropic` |
| `apps/api/src/plugins/kernel-bootstrap.ts` | `apps/api/src/claustrum-bootstrap.ts` |
| `apps/api/src/plugins/kernel-metrics-sink.ts` | `TelemetryPort` (provided to Conductor) |
| `apps/api/src/whatsapp/{session,client}.ts` | `@claustrum/channel-whatsapp` |
| `packages/domain/src/services/__shared__/with-adjudicate.ts` | `Capsule.adjudicator` |
| `apps/api/src/subscribers/__shared__/system-actor-envelope.ts` | Claustrum's planner emits envelopes |

The 6 files still exist on `feat/claustrum-cutover` so a smoke regression can
roll back via `git checkout pre-claustrum-cutover -- <path>`. They will be
deleted in a follow-up commit after the user runs an end-to-end Twilio turn.

### Pending deletion in `apps/api/package.json`

The `@ibatexas/llm-provider` workspace dep is still declared. Remove it
once the package directory is deleted.

## Related docs

- [`ADR-16-DRAFT.md`](./ADR-16-DRAFT.md) — DRAFT ADR #16 (Claustrum cutover).
  User has not yet appended this to `docs/architecture/decisions.md`. Do
  NOT auto-merge.
- [`CUTOVER-STATUS.md`](./CUTOVER-STATUS.md) — operator's record of cutover
  signals C-01..C-11 (CLOSED / PENDING / DEFERRED).
- [`lessons-learned.md`](./lessons-learned.md) — anti-patterns mined from
  the old `packages/llm-provider/` via the `pre-claustrum-cutover` tag.
- [`ibatexas-as-adopter.md`](./ibatexas-as-adopter.md) — adopter reference.
  How ibatexas now consumes `@claustrum/*`.
- `docs/architecture/decisions.md` — ADRs #1-15 (user owns; ADR #16 still
  in draft form here pending user approval).

## Recovery boundary

The local git tag `pre-claustrum-cutover` is the snapshot of the codebase
immediately before the Phase 6 cutover commit (`4b6cb68`). To recover any
deleted file:

```bash
cd /Users/thaisrodolpho/projects/ibatexas
git show pre-claustrum-cutover:packages/llm-provider/src/agent.ts > /tmp/agent.ts.bak
# inspect, then if needed:
git checkout pre-claustrum-cutover -- packages/llm-provider/
```

To roll the cutover back entirely:

```bash
git checkout pre-claustrum-cutover    # detached HEAD
git checkout -b emergency-rollback    # if you need a branch
```

The tag is local-only and has NOT been pushed. Preserve it on this machine.
