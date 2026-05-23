# 06 — Runtime Config & Governance Plumbing

## Executive summary

**The kernel is dormant in production by accident, not by design.** All wiring is
in place — `intent-audit-wiring.ts`, `intent-ledger.ts`, and `llm-responder.ts`
correctly call `isShadowed()`, `isEnforced()`, `getAuditSink()`, and
`getIntentLedger()` on every mutating intent — but the env vars that gate those
calls (`IBX_KERNEL_SHADOW`, `IBX_KERNEL_ENFORCE`, `IBX_LEDGER_*`) are unset in
every environment file in the repo. With `IBX_KERNEL_SHADOW` / `IBX_KERNEL_ENFORCE`
both falsy, `llm-responder.ts:329-332` takes the "pure legacy" branch and
returns `EXECUTE` without invoking `adjudicate()`. The kernel is referenced but
never consulted.

Additionally, the framework's two opinionated boot hooks — `installPack()` and
`validateEnforceConfig()` from `@adjudicate/core/kernel` — are **never called at
any startup site** in ibatexas. This means:

1. No `MetricsSink` is installed → all `recordDecision`/`recordRefusal`/
   `recordShadowDivergence` calls vanish into the no-op sink. PostHog dashboards
   shown in the Stage 1 runbook (events `audit_kernel_shadow_diverged_basis/kind/rewrite`)
   show ZERO data because nothing is recording.
2. No `LearningSink` is installed.
3. No Pack conformance check runs against the order PolicyBundle.
4. No typo guard fires when an operator misspells an intent kind in
   `IBX_KERNEL_SHADOW`.
5. No `withBasisAudit` wrap → refusal-code drift is invisible.

The shadow-divergence events ARE typed in `apps/web/src/domains/analytics/events.ts:107-114`
but no code path posts them to PostHog. Until a real `MetricsSink` is wired,
the staged rollout playbook in `docs/ops/runbooks/` is non-executable.

**Estimated effort to flip the switch:** ~1 dev-day. The bulk is writing one
~80-line `apps/api/src/plugins/kernel-bootstrap.ts` module + env-var additions
+ a PostHog/Sentry-backed `MetricsSink` implementation. No new framework code
needed; the framework hooks exist.

---

## Env var surface

All env-var references that gate Adjudicate runtime behavior. "Used in" is the
in-repo call site that reads the var (most live in the sibling `@adjudicate/*`
packages but are imported by ibatexas).

| Var | Used in (file:line) | Default | Effect when set | Currently set in repo? |
|---|---|---|---|---|
| `IBX_KERNEL_SHADOW` | `adjudicate/packages/core/src/kernel/enforce-config.ts:36`, consumed by `ibatexas/packages/llm-provider/src/llm-responder.ts:318` via `isShadowed(intentKind, process.env)` | `undefined` → no kinds shadowed | Comma-separated list of intent kinds (or `*`) that run `adjudicateWithShadow()` alongside the legacy "always-EXECUTE" path. Legacy stays authoritative; divergence is reported via `setShadowTelemetrySink` (which fires `recordShadowDivergence` only if a `MetricsSink` was installed). | **No.** Absent from `.env`, `.env.example`, `docker-compose.yml`, `docker-compose.prod.yml`, `process-compose.yaml`, `infra/secrets.env`, `infra/terraform/environments/dev/*.tf`, `infra/terraform/environments/production/*.tf`. The SSM secret list in `infra/terraform/environments/dev/secrets.tf:14-29` does not include it. |
| `IBX_KERNEL_ENFORCE` | `adjudicate/packages/core/src/kernel/enforce-config.ts:37`, consumed by `ibatexas/packages/llm-provider/src/llm-responder.ts:316` via `isEnforced(intentKind, process.env)` | `undefined` → no kinds enforced | Comma-separated list of intent kinds (or `*`) where `adjudicate(envelope, state, orderPolicyBundle)` is authoritative. Non-`EXECUTE` decisions short-circuit the mutating tool. | **No.** Same gap as above. |
| `IBX_LEDGER_ENABLED` | `adjudicate/packages/audit/src/feature-flag.ts:12`, consumed by `ibatexas/packages/llm-provider/src/intent-ledger.ts:95` via `isLedgerEnabled()` | `false` | Enables Redis ledger shadow writes via `recordExecution()`. Without enforcement, the kernel records but does not dedup. | **No.** |
| `IBX_LEDGER_ENFORCE` | `adjudicate/packages/audit/src/feature-flag.ts:18`, consumed in `ibatexas/packages/llm-provider/src/intent-ledger.ts:95` and `ibatexas/packages/llm-provider/src/llm-responder.ts:33,263` | `false` | When true, a `checkLedger()` hit short-circuits the intent dispatch as `already_processed`. Backed by `recordExecution(...)` writes — replay protection. | **No.** |
| `IBX_LEDGER_FAIL_OPEN` | `ibatexas/packages/llm-provider/src/intent-ledger.ts:39` | `false` (fail-safe) | `true` → on Redis circuit-breaker trip, log + return null (no dedup, allow). `false` → throw `LedgerUnavailableError` → caller emits `SECURITY/ledger_unavailable` refusal. | **No.** Default is fail-safe, which means ledger outages will surface as refusals in the financial-mutations stage — that may or may not be the desired posture in production. |
| `IBX_KILL_SWITCH` | `adjudicate/packages/core/src/kernel/enforce-config.ts:164` (`killSwitchEnvActive`) | `false` | Pre-seeds the global kill switch active. `adjudicate()` returns `SECURITY/kill_switch_active` for every intent. Runtime overrides via `setKillSwitch()` take precedence after first toggle. | **No.** Never set anywhere. Also: `setKillSwitch()` and `isKilled()` are NEVER called from any ibatexas file (verified by grep across `apps/` and `packages/`). |
| `AGENT_MAX_TURNS` | `packages/llm-provider/src/llm-responder.ts:40` | `5` | LLM conversation turns per session. | Documented in `.env.example:9`, value `10`. Not strictly governance — included because it's the only "kernel-adjacent" env that IS plumbed. |
| `AGENT_MAX_TOOL_RETRIES` | `packages/llm-provider/src/llm-responder.ts:41` | `3` | Per-tool retry budget. | `.env.example:10`. |
| `AGENT_MAX_CONVERSATION_RETRIES` | `packages/llm-provider/src/llm-responder.ts:42` | `10` | Conversation-level retry cap. | `.env.example:12`. |
| `AGENT_SESSION_TOKEN_BUDGET` | `packages/llm-provider/src/llm-responder.ts:45` | `100000` | Per-session daily token cap. | `.env.example:13`. |
| `AGENT_TOKEN_BUDGET_TTL` | `packages/llm-provider/src/llm-responder.ts:46` | `86400` | Token budget reset window. | `.env.example:14`. |

**Conspicuously absent from the source tree** (referenced in runbooks/docs as
hypothetical future controls, no implementation yet):

- `IBX_KERNEL_BYPASS` / `IBX_BYPASS_KERNEL` — no emergency "skip-the-kernel"
  hatch exists. The only way to disable the kernel in code today is to leave
  both `IBX_KERNEL_SHADOW` and `IBX_KERNEL_ENFORCE` unset, which is the current
  state.
- Per-tool kill switch — no `IBX_TOOL_BLOCKLIST` or similar; the kernel
  treats every intent kind uniformly via the SHADOW/ENFORCE comma-lists.
- Defer-quota override — `DEFAULT_DEFER_QUOTA_PER_SESSION=16` is hardcoded in
  `adjudicate/packages/runtime/src/defer-park.ts:19`; no env override on the
  call site.

---

## App boot sequences

### apps/api (Fastify)

**Files:** `apps/api/src/index.ts` (process bootstrap) → `apps/api/src/server.ts`
(Fastify instance).

`index.ts` startup order:

1. Sentry init from `SENTRY_DSN` (lines 15-20)
2. `process.on("unhandledRejection")` / `"uncaughtException"` (lines 25-34)
3. `buildServer()` from `server.ts` (line 39) — registers Helmet, CORS, Cookie,
   JWT, Sensible, Swagger, RateLimit, ErrorHandler, Routes
4. SIGTERM/SIGINT shutdown handlers (lines 51-52)
5. `server.listen()` (line 55)
6. `seedFromEnv()` schedule (lines 57-62)
7. `initWhatsAppSender()` (line 65)
8. NATS subscribers + outbox writer + BullMQ workers (lines 67-83)
9. **Nothing adjudicate-related.** No `installPack(orderPolicyBundle)`. No
   `validateEnforceConfig(knownIntents)`. No `setMetricsSink(...)`. No
   `setLearningSink(...)`. No `import "@adjudicate/core/kernel"` at all.

**Where the LLM provider is initialized:** lazily, on the first chat or
WhatsApp message. `apps/api/src/routes/chat.ts:12` and
`apps/api/src/routes/whatsapp-webhook.ts:22` both `import { runOrchestrator }
from "@ibatexas/llm-provider"`. The Anthropic SDK client is also lazy
(`llm-responder.ts:53` `_client ??= new Anthropic(...)`).

**Where `installPack` would belong:** in `apps/api/src/index.ts` after Sentry
init (so registration errors hit Sentry), before `buildServer()` so the
PolicyBundle assertion failures crash the process before serving traffic. The
canonical adopter pattern is:

```
import { installPack, validateEnforceConfig } from "@adjudicate/core/kernel"
import { orderPolicyBundle } from "@ibatexas/llm-provider"
// + PIX pack
const { pack } = installPack(orderPolicyBundle, { ... })
validateEnforceConfig(new Set([...knownIntentKinds]))
```

A new module like `apps/api/src/plugins/kernel-bootstrap.ts` (~80 lines) would
own this and would be the natural home for the `MetricsSink` + `LearningSink`
adapters (PostHog + Sentry breadcrumbs).

**Where `validateEnforceConfig` would belong:** same module, called once after
`installPack` returns and before `server.listen()` so a typo in
`IBX_KERNEL_SHADOW` surfaces as a console.warn during boot, not silently at
first traffic.

### apps/web (Next.js storefront)

**Files:** `apps/web/instrumentation.ts`, `apps/web/sentry.server.config.ts`,
`apps/web/src/middleware.ts`, app router pages.

`grep -rn "@ibatexas/llm-provider\|@adjudicate/" apps/web/src/` returns nothing
under `src/`. The web app DOES declare adjudicate-related analytics events in
`apps/web/src/domains/analytics/events.ts:106-114`:

```
| 'audit_kernel_shadow_diverged_basis'
| 'audit_kernel_shadow_diverged_kind'
| 'audit_kernel_shadow_diverged_rewrite'
| 'audit_decision_executed'
| 'audit_decision_refused'
| 'audit_ledger_hit'
| 'audit_nats_sink_failed'
| 'audit_replay_divergence'
```

…but no code path emits any of them (grep across `apps/`, `packages/` returns
zero call sites). The union is decorative right now.

The web app does NOT directly call the kernel. All adjudication happens
server-side in `apps/api` via `runOrchestrator`. **No installPack hook
needed in `apps/web`** — but the PostHog `MetricsSink` to be installed in
`apps/api` should emit events with names matching this union so the
storefront-side dashboards work.

### apps/admin (Next.js admin panel)

Same shape as `apps/web`. `apps/admin/instrumentation.ts` only imports Sentry.
No adjudicate or llm-provider references in `apps/admin/src/` (grep returns
zero). No bootstrap hook needed; admin does not adjudicate anything.

### apps/commerce (Medusa v2)

Medusa builds itself (`medusa develop`/`medusa build`) and is a separate
process (port 9000). `apps/commerce/src/` contains seed scripts and
subscribers; no LLM or adjudicate code. **No bootstrap hook needed.**

`apps/api` calls Medusa as an upstream service via `@ibatexas/tools` →
`packages/tools/src/medusa/client.ts`. The kernel never executes inside the
commerce process.

---

## Audit sink wiring

**File:** `packages/llm-provider/src/intent-audit-wiring.ts` (53 lines).

```typescript
// loadSink() composes:
//   - createConsoleSink({ prefix: "[ibx-audit]" })  // dev visibility
//   - createNatsSink({ publisher: { publish(subject, payload) → publishNatsEvent(subject, payload) } })
// multiSink(console, nats) — Promise.allSettled, both run, neither blocks
// _sink is a singleton; getAuditSink() returns it
```

Key observations:

1. **The audit sink is ALWAYS active** — there is no env-var gate. As soon as
   `getAuditSink()` is called, NATS gets `ibatexas.audit.intent.decision.v1`
   events. (`publishNatsEvent` prepends `ibatexas.` per `nats-client` convention.)
2. **But it is only called when an intent envelope exists** —
   `llm-responder.ts:335-354` only calls `getAuditSink().emit(record)` when
   `result.kind === "intent"`. With `IBX_KERNEL_SHADOW`/`ENFORCE` unset, the
   intent is still wrapped (the bridge in `tool-registry.ts` runs unconditionally)
   so the audit record IS emitted today — but `decision = legacyDecisionAsKernelDecision({ kind: "EXECUTE" })`
   from line 331, i.e. every record has `decision.kind = EXECUTE`. There is no
   real audit content beyond "an intent was proposed."
3. **No NATS consumer is subscribed** to `ibatexas.audit.intent.decision.v1`
   anywhere in `apps/api/src/subscribers/`. `cart-intelligence`, `handoff-subscriber`,
   `conversation-archiver`, `payment-lifecycle`, `defer-resolver` are the only
   subscribers. So the audit subject is published but never read or persisted.
4. **No Postgres audit sink** is wired. `@adjudicate/audit-postgres` is a
   sibling package in `adjudicate/packages/audit-postgres/`, but ibatexas does
   not depend on it (not in any `package.json`).
5. **Console sink prefix is hardcoded** (`[ibx-audit]`) — fine for dev,
   noisy for prod logs unless filtered downstream.

**Verdict:** the audit sink wiring is structurally complete but functionally
shallow without (a) a real consumer on the NATS subject and (b) actual
non-`EXECUTE` decisions being produced (which requires flipping shadow
or enforce flags).

---

## Intent ledger wiring

**File:** `packages/llm-provider/src/intent-ledger.ts` (160 lines).

```typescript
export async function getIntentLedger(): Promise<Ledger | null> {
  if (!isLedgerEnabled() && !isLedgerEnforced()) return null
  const inner = loadLedger()
  return wrapWithFailOpenPolicy(inner)
}
```

Semantics:

| `IBX_LEDGER_ENABLED` | `IBX_LEDGER_ENFORCE` | `IBX_LEDGER_FAIL_OPEN` | Effect |
|---|---|---|---|
| unset (default) | unset (default) | n/a | `getIntentLedger()` returns `null` → ledger step skipped entirely in `llm-responder.ts:260`. **Current production state.** |
| `true` | unset | irrelevant | Shadow writes only. `checkLedger()` runs and records metrics but `isLedgerEnforced()` is false so a hit doesn't short-circuit (`llm-responder.ts:263` `if (hit && isLedgerEnforced())`). `recordExecution()` runs. |
| any | `true` | `true` | Enforcement on; on Redis circuit-open, log + return null (allow + no dedup). |
| any | `true` | `false`/unset | Enforcement on; on Redis circuit-open, throw `LedgerUnavailableError` → caller surfaces `SECURITY/ledger_unavailable` refusal. **Fail-safe — recommended for financial mutations.** |

**Redis backing service:** `intent-ledger.ts:54-77` uses `createRedisLedger`
from `@adjudicate/audit`. The Redis client comes from `@ibatexas/tools`'s
`safeRedis("critical", ...)` wrapper, which trips a circuit-breaker on
repeated failures (env-tunable via `REDIS_CB_FAILURE_THRESHOLD=5`,
`REDIS_CB_RESET_TIMEOUT_MS=30000` — both ARE in `.env.example:56-57`). The
ledger uses `rk()` namespacing so keys are `ibatexas:<env>:...` per the
project's `APP_ENV` namespace convention (Hard Rule #7).

Ledger TTL / key format: defined inside `@adjudicate/audit`'s
`createRedisLedger`. Not exposed via env in ibatexas, not overridable.

**Per-op metrics:** `recordLedgerOp` is invoked at `intent-ledger.ts:106-117`
on every check (hit/miss/error) and every record. As with all the metrics
calls, this goes to the no-op default sink today.

---

## Kill switches (existing and missing)

**Implemented in `@adjudicate/core/kernel/enforce-config.ts:137-225` but NOT
wired or used in ibatexas:**

| Switch | Type | Where | Status in ibatexas |
|---|---|---|---|
| Global kill switch (env-seeded) | `IBX_KILL_SWITCH=1` at boot | `enforce-config.ts:170-180` (`ensureKillSwitchSeeded`) | **NOT set.** |
| Global kill switch (runtime) | `setKillSwitch(true, reason)` API call | `enforce-config.ts:190` | **Never called from any ibatexas source file.** No admin endpoint exposes it. |
| State accessor | `getKillSwitchState()` / `isKilled()` | `enforce-config.ts:202-215` | **Never called from ibatexas.** |
| Audit on toggle | `getKillSwitchAuditEvent()` (mentioned in `adjudicate/packages/core/src/kernel/...`) | n/a | Not wired. |

**Missing from the codebase entirely:**

| Switch | Use case | What's needed |
|---|---|---|
| **Per-tool kill switch** | "Suspend `add_to_cart` for 1h while we debug" | No primitive exists. The closest analog is omitting a kind from `IBX_KERNEL_ENFORCE`, but that puts it on the legacy-EXECUTE path, not a "refuse all" path. Would need either (a) a refusal-only PolicyBundle layer per tool, or (b) a new `IBX_KERNEL_BLOCK` env var parsed alongside ENFORCE/SHADOW. |
| **Shadow-only mode** | Already exists via `IBX_KERNEL_SHADOW=*` with `IBX_KERNEL_ENFORCE` empty. The four-stage rollout assumes this for the soak period. | Just need the env var to be SET somewhere — even pre-set to `*` in `.env.example` so dev/staging instances default to shadow-on. |
| **Bypass mode (emergency)** | "Roll back to v1.0 stub behavior fast" | Today, removing both env vars achieves bypass. There is no explicit `IBX_KERNEL_BYPASS=1` flag — operators must know to clear both lists. The runbooks (e.g. `01-stage-read-mutations.md:90-91`) document the procedure: `IBX_KERNEL_ENFORCE=` then `ibx svc restart api`. |
| **Per-tenant override** | Multi-tenant futures | `enforce-config.ts:368-370` documents `shadowEnvVar`/`enforceEnvVar` options for custom env var names (e.g. `IBX_KERNEL_SHADOW_TENANT_FOO`) but ibatexas is single-tenant and does not exercise this. |

---

## Telemetry / metrics wiring

**Framework primitives** (`adjudicate/packages/core/src/kernel/metrics.ts`):

- `recordLedgerOp` — called from `intent-ledger.ts:106-117`
- `recordDecision` — called from `@adjudicate/core/kernel/adjudicate.ts`
- `recordRefusal` — called when `adjudicate()` produces a `REFUSE`
- `recordSinkFailure` — called from `validateEnforceConfig()` (typo guard) and
  audit sink failures
- `recordShadowDivergence` — called by the `setShadowTelemetrySink` glue when
  shadow-mode produces a diverged outcome (four classes: `BASIS_ONLY`,
  `DECISION_KIND`, `PAYLOAD_REWRITE`, plus one resource-limit signal)
- `recordResourceLimit` — defer-quota exceedance, etc.

All of the above invoke `_sink.<method>(event)`. `_sink` defaults to `noopSink()`
(`metrics.ts:96, 146-155`). The sink is replaced via `setMetricsSink(sink)`
(`metrics.ts:99-130`) which ALSO wires the shadow telemetry sink as a side
effect.

**In ibatexas:** `grep -rn "setMetricsSink\|createConsoleMetricsSink\|setLearningSink"
ibatexas/` returns ZERO matches in source code (excluding adjudicate's own
`node_modules`). The only place `MetricsSink` is named in ibatexas is via
re-export of types in `@adjudicate/core/kernel`. The no-op sink is the
production sink.

**Consequence:** every `recordDecision` / `recordRefusal` /
`recordShadowDivergence` call in the kernel returns immediately without
emitting anywhere. The PostHog event names declared in
`apps/web/src/domains/analytics/events.ts:107-114` (`audit_kernel_shadow_diverged_*`,
`audit_decision_executed`, `audit_decision_refused`, `audit_ledger_hit`,
`audit_nats_sink_failed`, `audit_replay_divergence`) and the Sentry alerts
the runbooks rely on (`kernel_shadow_diverged_kind > 0.1%`) have no producer.

**No OpenTelemetry wiring:** `@adjudicate/observability` exists as a sibling
package (`adjudicate/packages/observability/src/{exporter,metrics,audit-spans}.ts`)
exposing OTLP exporters, but ibatexas does not depend on it (not in any
`package.json` under `apps/` or `packages/`). Sentry IS configured in
`apps/api/src/plugins/sentry.ts` for HTTP error reporting, but no `Sentry.metrics.*`
or `Sentry.addBreadcrumb` from the kernel surface.

---

## CLAUDE.md rules vs code reality

### Rule #9 — LLM Authority (IBX-IGE v2.0)

The rule text (`CLAUDE.md:43`) makes five governance claims; here is how each
fares against the implementation:

| Claim | Code reality |
|---|---|
| "Mutating tools are captured as `IntentEnvelope<kind, payload>`" | TRUE. `tool-registry.ts` (`executeTool` flow with `buildEnvelope`) does this for every mutating tool. |
| "Adjudicated by the kernel (`adjudicate()` from `@adjudicate/core/kernel`)" | PARTIALLY TRUE. `llm-responder.ts:316-332` calls `adjudicate()` only when `isEnforced()` or `isShadowed()` is true for the intent kind. With both env vars unset, the `else` branch at line 329 produces a synthetic legacy `EXECUTE` decision; `adjudicate()` is never invoked in production today. |
| "Orchestrated via `@ibatexas/llm-provider` (`runOrchestrator`, `executeKernel`)" | TRUE. Both routes use `runOrchestrator`. |
| "Composes deadline helpers from `@adjudicate/runtime`" | TRUE. `orchestrator.ts:13` imports `deadlinePromise`. |
| "Tool visibility controlled by `CapabilityPlanner` and `ToolClassification`" | TRUE. `capability-planner.ts` filters out MUTATING tools per state. |
| "**Staged rollout** is gated per-intent-class via `IBX_KERNEL_SHADOW` and `IBX_KERNEL_ENFORCE` (parsed in `@adjudicate/core/kernel`'s `enforce-config`)" | TRUE structurally, but **neither env var is actually set in any environment file** (`.env`, `.env.example`, `docker-compose*.yml`, `process-compose.yaml`, `infra/secrets.env`, terraform `secrets.tf`). So staged rollout is not deployed — the staged-rollout runbooks (`docs/ops/runbooks/01..05`) are operator instructions that have not been executed yet. |
| "**Execution dedup** is gated by `IBX_LEDGER_ENABLED` / `IBX_LEDGER_ENFORCE` / `IBX_LEDGER_FAIL_OPEN` (`@adjudicate/audit`)" | TRUE structurally; same env-var gap. Dedup is dormant. |

**Conclusion:** Rule #9 documents the architecture correctly but the staged
rollout it cites is not yet engaged. The kernel adjudication branch is
structurally in place, dormant by virtue of unset config — not by any code-level
"feature flag off" toggle.

### Other CLAUDE.md hard rules touched by this audit

- **Rule #3 (`process.env` only)** — kernel config is all `process.env`-driven,
  consistent with the rule. No hardcoded defaults in source.
- **Rule #6 (`.env` never committed)** — the `.env` file IS in the repo
  contrary to the rule (committed Apr 11, see `git log .env`). Not directly an
  enforcement concern but worth noting as a related governance gap.
- **Rule #7 (`rk()` for Redis keys)** — `intent-ledger.ts:75` uses `rk(suffix)`
  correctly. `llm-responder.ts:391` for `defer:pending:{sessionId}` uses `rk`
  correctly.
- **Rule #8 (analytics events documented)** — the kernel events are typed in
  the union and documented in `docs/ops/analytics-dashboards.md:329-356`, but
  no producer emits them. The documentation describes a feature that does not
  yet exist in runtime.

---

## Plumbing gaps that block enforce mode (P0)

Numbered in suggested fix order; each is a hard blocker for flipping any of
the runbooks' "Stage N" sections.

1. **P0-1: env vars not set anywhere.** Until `IBX_KERNEL_SHADOW`,
   `IBX_KERNEL_ENFORCE`, `IBX_LEDGER_ENABLED`, `IBX_LEDGER_ENFORCE`, and
   `IBX_LEDGER_FAIL_OPEN` are templated in `.env.example`, set in `.env`,
   propagated through `docker-compose.prod.yml`'s `env_file: .env`, included
   in `infra/terraform/environments/dev/secrets.tf` SSM list, and pushed via
   `ibx infra secrets:push`, the kernel cannot transition out of dormant
   state.

2. **P0-2: no boot-time `installPack(orderPolicyBundle)`.** Without this,
   (a) PolicyBundle conformance is not asserted (e.g. a `default: "EXECUTE"`
   regression goes unnoticed), and (b) `withBasisAudit` is not applied so
   refusal-code vocabulary drift is invisible. `installPack` lives in
   `adjudicate/packages/core/src/install.ts:73`.

3. **P0-3: no boot-time `validateEnforceConfig(knownIntents)`.** Without this,
   a typo like `IBX_KERNEL_ENFORCE=cart.ad,review.submit` silently leaves
   `cart.ad[d]` on the legacy path with no warning. The typo guard exists at
   `adjudicate/packages/core/src/kernel/enforce-config.ts:94`.

4. **P0-4: no `MetricsSink` installed.** All `recordDecision`,
   `recordRefusal`, `recordShadowDivergence`, `recordLedgerOp`,
   `recordSinkFailure` calls go to the no-op sink. The Stage 1–4 runbooks
   each call out PostHog events (`audit_kernel_shadow_diverged_*`,
   `kernel_authoritative_decision`) and Sentry alerts as their go/no-go
   gating criteria; without a producer, those gates are uncheckable.

5. **P0-5: no consumer subscribed to `ibatexas.audit.intent.decision.v1`.** The
   NATS audit sink publishes but nobody listens. For durable trail and
   replay tooling, either (a) wire `@adjudicate/audit-postgres` (already a
   sibling package), or (b) write a `apps/api/src/subscribers/audit-archiver.ts`
   that writes to a domain `AuditRecord` table.

6. **P0-6: no LearningSink.** Lower priority than the metrics sink but called
   out in `installPack`'s opinionated bootstrap — basis-drift learning data
   is lost. `installPack` will wire `createConsoleLearningSink()` as a
   default if not configured, which is at least better than nothing.

7. **P0-7: kill switch wired in framework, never reachable in ibatexas.**
   No admin endpoint, no CLI command, and `IBX_KILL_SWITCH` is unset.
   Operators have no in-band way to engage the global stop. Suggested
   minimum: an admin route `POST /api/admin/kernel/kill` calling
   `setKillSwitch(true, reason)`.

8. **P0-8: per-tool kill switch primitive missing.** Not implementable
   without a new framework primitive OR a per-intent override list parsed
   in ibatexas. Out of scope to design here, but flagged.

---

## Gaps and recommendations

### Required to make the kernel "flip-the-switch ready"

1. Add env-var stanza to `.env.example` (under a new `# ─── Adjudicate Kernel ─` section):
   ```
   IBX_KERNEL_SHADOW=                        # comma-separated intent kinds (or *) — shadow mode
   IBX_KERNEL_ENFORCE=                       # comma-separated intent kinds (or *) — authoritative mode
   IBX_LEDGER_ENABLED=false                  # shadow writes to Redis execution ledger
   IBX_LEDGER_ENFORCE=false                  # ledger short-circuits replays
   IBX_LEDGER_FAIL_OPEN=false                # fail-safe by default; flip to true only in non-financial paths
   IBX_KILL_SWITCH=                          # set to 1 to pre-seed global kill switch active
   ```
2. Add the same six names to `infra/terraform/environments/dev/secrets.tf:14-29`
   (or pre-seed via the user_data refresh script so they're not "secrets" per se).
3. Create `apps/api/src/plugins/kernel-bootstrap.ts` containing:
   - `installPack(orderPolicyBundle, { warn: server.log.warn.bind(server.log) })`
   - PostHog-backed `MetricsSink` implementing all five methods, mapped to the
     event names already declared in `apps/web/src/domains/analytics/events.ts:107-114`
   - Sentry breadcrumb on every `recordRefusal` and `recordSinkFailure`
   - `validateEnforceConfig(new Set([...intentKinds]))` where `intentKinds` is
     the union of guards exercised by `orderPolicyBundle` + the PIX Pack
4. Call `bootstrapKernel(server)` from `apps/api/src/index.ts` after Sentry
   init, before `buildServer()`.
5. Write `apps/api/src/subscribers/audit-archiver.ts` subscribing to
   `audit.intent.decision.v1` and persisting via `@adjudicate/audit-postgres`
   or a domain table.

### Optional but valuable

6. Admin endpoint `POST /api/admin/kernel/kill` calling
   `setKillSwitch(true, reason)`, gated by `ADMIN_API_KEY`. Audit the toggle
   via `getKillSwitchAuditEvent()`.
7. CLI command `ibx svc kernel:status` printing `getKillSwitchState()`,
   parsed shadow/enforce sets, and last 100 decisions from the audit
   archive — for on-call triage during a stage rollout.
8. Stop committing `.env` (rule #6 violation). Audit-fix.

### Effort estimate

- Env-var plumbing (steps 1, 2): **~30 min**
- `kernel-bootstrap.ts` with PostHog `MetricsSink` (step 3): **~3-4 hours**
  including a `__tests__/kernel-bootstrap.test.ts` asserting `installPack`
  was called and `validateEnforceConfig` warns on typos.
- Wire it into `index.ts` (step 4): **~15 min**.
- Audit archiver subscriber (step 5): **~2-3 hours** depending on whether the
  team wants Postgres or a NATS-only KV store.
- Admin kill-switch endpoint (step 6): **~1-2 hours**.
- CLI `kernel:status` (step 7): **~2 hours**.

**Total to flip-the-switch ready (steps 1-4): ~5 hours of focused work, ~1
dev-day with review and testing.**
