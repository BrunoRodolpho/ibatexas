# CLAUDE.md — AI Agent Guide for IbateXas

> Read these docs before writing any code.

| Need | Go to |
|------|-------|
| What works, what's broken, priorities | [docs/PROJECT_STATE.md](docs/PROJECT_STATE.md) |
| System diagrams, module map, "where is X?" | [docs/architecture/](docs/architecture/) |
| Pre-launch backlog (13 items) | [docs/backlog/TODO-BACKLOG.md](docs/backlog/TODO-BACKLOG.md) |
| Full CLI reference (20 commands) | [docs/cli/reference.md](docs/cli/reference.md) |
| Deployment guide, CI/CD pipeline | [docs/setup/deployment.md](docs/setup/deployment.md) |
| Bounded contexts, entity ownership | [docs/architecture/design/bounded-contexts.md](docs/architecture/design/bounded-contexts.md) |
| Prisma schema, entities, NATS events | [docs/architecture/design/domain-model.md](docs/architecture/design/domain-model.md) |
| 25 AI tools — auth level, inputs, outputs | [docs/architecture/design/agent-tools.md](docs/architecture/design/agent-tools.md) |
| ADRs, cross-cutting patterns | [docs/architecture/decisions.md](docs/architecture/decisions.md) |
| Zero-Trust LLM, tool classification, intent bridge | [docs/architecture/decisions.md](docs/architecture/decisions.md) (ADR #9) |
| Kernel rollout — 4-stage shadow → enforce playbook | [docs/ops/runbooks/](docs/ops/runbooks/) |
| Analytics events, PostHog dashboards | [docs/ops/analytics-dashboards.md](docs/ops/analytics-dashboards.md) |
| Redis key patterns, TTLs | [docs/ops/redis-memory.md](docs/ops/redis-memory.md) |
| Claude Code plugins — what's installed, usage | [docs/setup/plugins.md](docs/setup/plugins.md) |
| WhatsApp state machine, XState, prompt routing | [docs/architecture/design/hybrid-state-flow.md](docs/architecture/design/hybrid-state-flow.md) |

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
9. **LLM Authority (IBX Intent-Gated Execution v2.0):** the LLM is a semantic parser with zero state-mutation authority. Mutating tools are captured as `IntentEnvelope<kind, payload>` objects (`@adjudicate/core`), adjudicated by the kernel (`adjudicate()` from `@adjudicate/core/kernel`), and orchestrated via `@ibatexas/llm-provider` (`runOrchestrator`, `executeKernel`) which composes deadline helpers from `@adjudicate/runtime`. Tool visibility to the LLM is controlled by the `CapabilityPlanner` and `ToolClassification` contracts in `@adjudicate/core/llm`; never add mutating tools to the planner's visible list. Current implementations: `packages/llm-provider/src/capability-planner.ts`, `TOOL_CLASSIFICATION` in `packages/llm-provider/src/machine/types.ts`, intent-bridge in `packages/llm-provider/src/tool-registry.ts`. **Staged rollout** is gated per-intent-class via `IBX_KERNEL_SHADOW` and `IBX_KERNEL_ENFORCE` (parsed in `packages/core/src/kernel/enforce-config.ts`) — see [docs/ops/runbooks/](docs/ops/runbooks/) for the 4-stage playbook. **Execution dedup** is gated by `IBX_LEDGER_ENABLED` / `IBX_LEDGER_ENFORCE` / `IBX_LEDGER_FAIL_OPEN` (`@adjudicate/audit`). See ADR #9 and the `@adjudicate/{core,runtime,audit,audit-postgres}` package READMEs.
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
- `@ibatexas/tools` has the widest blast radius — depended on by 6 packages/apps

> Port assignments source of truth: `packages/cli/src/services.ts`

---

## Agent Behavior

- Skip `npm run build` verification after changes
- Do not visually inspect or screenshot UI changes
- Only run tests when explicitly requested
- Do not start dev servers to verify changes
- When spawning teammates, use in-process mode: `claude --teammate-mode in-process`
