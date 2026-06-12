# CLAUDE.md — AI Agent Guide for IbateXas

> Read these docs before writing any code.

| Need | Go to |
|------|-------|
| System diagrams, module map, "where is X?" | [docs/architecture/](docs/architecture/) |
| Full CLI reference (30 commands) | [docs/cli/reference.md](docs/cli/reference.md) |
| Deployment guide, CI/CD pipeline | [docs/setup/deployment.md](docs/setup/deployment.md) |
| Bounded contexts, entity ownership | [docs/architecture/design/bounded-contexts.md](docs/architecture/design/bounded-contexts.md) |
| Prisma schema, entities, NATS events | [docs/architecture/design/domain-model.md](docs/architecture/design/domain-model.md) |
| Agent tools — auth level, inputs, outputs (17 LLM-callable) | [docs/architecture/design/agent-tools.md](docs/architecture/design/agent-tools.md) |
| PIX charge lifecycle Pack (`@adjudicate/pack-payments-pix`) | [BrunoRodolpho/adjudicate](https://github.com/BrunoRodolpho/adjudicate/blob/main/packages/pack-payments-pix/README.md), ADR #13 |
| Kernel operations (always-on; no shadow / enforce / kill-switch) | [docs/ops/runbooks/kernel-operations.md](docs/ops/runbooks/kernel-operations.md) |
| Analytics events, PostHog dashboards | [docs/ops/analytics-dashboards.md](docs/ops/analytics-dashboards.md) |
| Redis key patterns, TTLs | [docs/ops/redis-memory.md](docs/ops/redis-memory.md) |
| Conversational turn pipeline (claustrum Conductor) | rule #9 below + `apps/api/src/claustrum-bootstrap.ts` |

---

## The One Rule

Use `ibx` for all dev operations. Run `ibx --help` or `ibx <command> --help` before writing code.
If a command does not exist for what you need, add it to `packages/cli/` first, then use it.

---

## Hard Rules — Never Break These

1. **Allergens:** always explicit array `[]` — never infer from product name or description
2. **Prices:** integer centavos (`8900` = R$89,00) — never floats
3. **Config:** always from `process.env` — never hardcode values in code
4. **User-facing text:** pt-BR only — product names, agent responses, error messages
5. **Auth:** Twilio Verify WhatsApp OTP — for both customers and staff. No Clerk, no passwords.
6. **`.env`:** never committed — update `.env.example` when adding new vars
7. **Redis keys:** always use `rk()` from `@ibatexas/tools` — never build raw key strings inline. This includes cache modules, session stores, and job schedulers.
8. **Analytics events:** add to `AnalyticsEvent` union in `apps/web/src/domains/analytics/events.ts` AND document in `docs/ops/analytics-dashboards.md`
9. **LLM Authority (IBX Intent-Gated Execution v3.0):** the LLM is a semantic parser with zero state-mutation authority. Every mutating tool call is captured as an `IntentEnvelope<kind, payload>` (`@adjudicate/core`) and adjudicated by the kernel (`adjudicate()` from `@adjudicate/core/kernel`). **The kernel is always authoritative** — no env-var gating, no shadow mode, no kill switch. Every decision is audited (console + NATS + Postgres via `@adjudicate/audit-postgres`). The execution ledger (`@adjudicate/audit` + Redis) is always-on and fail-closed — Redis unreachability surfaces as a refusal rather than a dedup bypass. System-driven mutations (subscribers, jobs, webhooks) MUST build a system-actor envelope (`actor.principal = "system"`) via `buildSystemEnvelope()` from `apps/api/src/subscribers/__shared__/`. **The conversational turn runs through the `@claustrum` Conductor**, NOT the deleted legacy `@ibatexas/llm-provider` brain (removed in the claustrum-on-dev cutover). The Conductor composition root is `apps/api/src/claustrum-bootstrap.ts` (process-wide; opens a per-turn `Capsule`); the chat + WhatsApp routes call `getConductor()` from it. The LLM sees exactly one mutating tool (`express_intent`) and never an internal tool id — the production planner is `createIbatexasPlanner` in `apps/api/src/claustrum/ibatexas-planner.ts`. Tool visibility per state is controlled by the `CapabilityPlanner` and `ToolClassification` contracts in `@adjudicate/core/llm`, implemented by each Pack's exported `*CapabilityPlanner` (e.g. `ordersCapabilityPlanner` from `@ibatexas/pack-orders`); never add mutating tools to a planner's visible list. The 17 LLM-callable tool definitions are assembled by the registry in `apps/api/src/tools/register-ibatexas-tool-packs.ts` (`listIbatexasToolPacks()`), keyed by `capability := intentKind` — the `toolRosterDrift()` gate (run fail-closed at boot in `claustrum-bootstrap.ts`) keeps that invariant. **PIX charge lifecycle** lives in `@adjudicate/pack-payments-pix` (the lighthouse Pack); `order-policy-bundle.ts` composes its `createPixPendingDeferGuard` factory. New PIX-pending consumers MUST import constants and the guard factory from `@adjudicate/pack-payments-pix`, never re-declare them. **Source-of-truth for `@adjudicate/*` packages is the platform repo** ([BrunoRodolpho/adjudicate](https://github.com/BrunoRodolpho/adjudicate)), published to npm; `@claustrum/*` likewise ([BrunoRodolpho/claustrum](https://github.com/BrunoRodolpho/claustrum)). IbateXas consumes them as registry deps with pinned versions. To upgrade: bump the version in the consuming `package.json` and `pnpm install`. **First-time setup:** `ibx bootstrap` provisions every schema layer — Medusa, domain (Prisma), the kernel audit-postgres schema, AND the `@claustrum` memory + grounding (pgvector) schema; `ibx db provision` re-applies the kernel + claustrum layers idempotently (`ibx kernel migrate` / `ibx claustrum migrate` for one layer each). See ADRs #9 + #13 + #14 + [docs/ops/runbooks/kernel-operations.md](docs/ops/runbooks/kernel-operations.md).
10. **Redis locks:** always use UUID lock values with Lua conditional release. Never use plain `redis.del()` to release a lock — use the ownership-checking Lua script pattern. See `apps/api/src/whatsapp/session.ts` for reference.

---

## Naming Conventions

| What | Convention | Example |
|------|-----------|---------|
| Interfaces/Types | PascalCase | `Product`, `CustomerProfile` |
| Constants | UPPER_SNAKE_CASE | `CATEGORIES`, `DEFAULT_SERVICES` |
| Enums | PascalCase | `ReservationStatus`, `ProductType` |
| Product/category handles | kebab-case, ASCII only | `costela-bovina-defumada` |
| CLI commands | lowercase | `dev`, `svc`, `api`, `db`, `intel` |
| NATS events | `domain.action` | `cart.abandoned`, `order.placed`, `payment.status_changed`, `payment.method_changed` |

**NATS specifics:**
- Subjects use `ibatexas.{domain}.{action}` — pass short form to `publishNatsEvent()`, the client adds the prefix. Never pass the full prefixed form.
- Test assertions: assert short-form (`"cart.abandoned"`) since tests mock at the caller boundary.

---

## Module System

- `packages/*`: ESM (`"type": "module"`), use `.js` extensions on local imports
- `packages/eslint-config`: CJS (standard for ESLint configs)
- `apps/commerce`: Medusa v2 handles its own build (`medusa develop` / `medusa build`), not `tsc`
- TypeScript strict mode globally — no implicit `any`
- Tests: Vitest + v8 coverage. No DB or network — mock everything external.
- `@ibatexas/tools` has the widest blast radius — depended on by 5 packages/apps (cli, commerce, web, admin, api)

> Port assignments source of truth: `packages/cli/src/services.ts`

---

## Agent Behavior

- Skip `npm run build` verification after changes
- Do not visually inspect or screenshot UI changes
- Only run tests when explicitly requested
- Do not start dev servers to verify changes
- When spawning teammates, use in-process mode: `claude --teammate-mode in-process`
