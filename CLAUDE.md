# CLAUDE.md — AI Agent Guide for IbateXas

> Read this before writing any code.

---

## Build & Test & Plan Mode

- Skip `npm run build` verification after changes
- Do not attempt to visually inspect or screenshot UI changes
- Only run tests when explicitly requested
- Do not start dev servers to verify changes

## Agent Teams

- When spawning teammates, use in-process mode: `claude --teammate-mode in-process` — avoids tmux issues

## The One Rule

Use `ibx` for all dev operations. Run `ibx --help` or `ibx <command> --help` before writing code.
If a command does not exist for what you need, add it to `packages/cli/` first, then use it.

See **[docs/ibx-cli.md](docs/ibx-cli.md)** for the full command reference.

---

## Hard Rules — Never Break These

1. **Allergens:** always explicit array `[]` — never infer from product name or description
2. **Prices:** integer centavos (`8900` = R$89,00) — never floats
3. **Config:** always from `process.env` — never hardcode values in code
4. **User-facing text:** pt-BR only — product names, agent responses, error messages
5. **Auth:** Twilio Verify WhatsApp OTP — for both customers and staff. No Clerk, no passwords.
6. **`.env`:** never committed — update `.env.example` when adding new vars
7. **Redis keys:** always use `rk()` from `@ibatexas/tools` — never build raw key strings inline. This includes cache modules, session stores, and job schedulers.
8. **Analytics events:** add to `AnalyticsEvent` union in `apps/web/src/domains/analytics/events.ts` AND document in `docs/analytics-dashboards.md`

---

## Naming Conventions

- **Interfaces/Types:** PascalCase (`Product`, `SeedVariant`, `CustomerProfile`)
- **Constants:** UPPER_SNAKE_CASE (`CATEGORIES`, `SEED_PRODUCTS`, `DEFAULT_SERVICES`)
- **Enums:** PascalCase (`ReservationStatus`, `ProductType`)
- **NATS events:** `domain.action` (`cart.abandoned`, `order.placed`)
- **NATS subjects:** `ibatexas.{domain}.{action}` — pass short form to `publishNatsEvent()`, the client adds `ibatexas.` prefix automatically. Never pass the full prefixed form.
- **NATS test assertions:** assert the short-form subject (`"cart.abandoned"`) since tests mock `publishNatsEvent` at the caller boundary, before the client adds the prefix.
- **Product/category handles:** kebab-case, ASCII only (`costela-bovina-defumada`)
- **CLI commands:** lowercase (e.g., `dev`, `svc`, `api`, `db`, `intel`) — see `docs/ibx-cli.md` for the full list of 19 commands

---

## Where Things Live

| What | Where |
|------|-------|
| Storefront | `apps/web` (port 3000) — Next.js customer-facing app |
| API server | `apps/api` (port 3001) — Fastify backend |
| Commerce engine | `apps/commerce` (port 9000) — Medusa v2 |
| Admin panel | `apps/admin` (port 3002) — standalone Next.js app |
| CLI reference | [docs/ibx-cli.md](docs/ibx-cli.md) |
| Architecture & design | [docs/design/](docs/design/) |
| Project state | [docs/PROJECT_STATE.md](docs/PROJECT_STATE.md) — what works, what's broken, priorities |
| Architecture map | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — diagrams, module map, "where is X?" |
| Pre-launch backlog | [docs/backlog/TODO-BACKLOG.md](docs/backlog/TODO-BACKLOG.md) — remove items when done |
| Setup guide | [docs/setup/local-dev.md](docs/setup/local-dev.md) |
| Analytics & dashboards | [docs/analytics-dashboards.md](docs/analytics-dashboards.md) |
| Redis key patterns | [docs/ops/redis-memory.md](docs/ops/redis-memory.md) |

> Port assignments source of truth: `packages/cli/src/services.ts`

---

## Module System

- `packages/*`: ESM (`"type": "module"`), use `.js` extensions on local imports (exception: `packages/eslint-config` is CJS — standard for ESLint configs)
- `apps/commerce`: No `"type": "module"` in package.json (Medusa v2 handles its own build pipeline via `medusa develop` / `medusa build`). Source uses ESM syntax.
- TypeScript strict mode enabled globally — no implicit `any`
- Tests: Vitest with v8 coverage. Run via `ibx dev test` or `pnpm test`. No DB or network required — mock everything external

---

## Workspace Packages

| Package | Responsibility |
|---------|---------------|
| `packages/cli` | The `ibx` CLI — all dev operations |
| `packages/domain` | Prisma schema, DB client, domain services |
| `packages/tools` | AI agent tools, Redis utilities, search, cart logic |
| `packages/types` | Shared TypeScript types and Zod schemas |
| `packages/llm-provider` | Anthropic SDK wrapper, agent loop, tool registry |
| `packages/nats-client` | NATS pub/sub wrapper with outbox support |
| `packages/ui` | Shared React component library (atoms/molecules/organisms) |
| `packages/eslint-config` | Shared ESLint config (CJS) |

> `@ibatexas/tools` has the widest blast radius — depended on by `apps/api`, `apps/web`, `apps/admin`, `apps/commerce`, `packages/cli`, `packages/llm-provider`.

---

## Medusa v2 Commerce Engine

- Products are managed via Medusa's admin API and indexed to Typesense for search
- Medusa subscribers fire on product/price/variant changes
- `apps/commerce` uses `medusa develop` / `medusa build`, not standard `tsc` / `tsx`
- Local dev infrastructure (Postgres, Redis, Typesense, NATS) runs via `docker-compose.yml`, managed by `ibx dev` and `ibx svc`

---

## Design Docs — Read Before Building

| Doc | Read before |
|-----|------------|
| [bounded-contexts.md](docs/design/bounded-contexts.md) | Any domain logic |
| [domain-model.md](docs/design/domain-model.md) | Any entity or schema |
| [agent-tools.md](docs/design/agent-tools.md) | Any AI tool |
| [use-cases.md](docs/design/use-cases.md) | Any user-facing feature |
| [customer-intelligence.md](docs/design/customer-intelligence.md) | Recommendations or profiles |
| [analytics-dashboards.md](docs/analytics-dashboards.md) | Any analytics event or PostHog insight |
| [redis-memory.md](docs/ops/redis-memory.md) | Any Redis key usage |
| [architecture-decisions.md](docs/design/architecture-decisions.md) | System diagram, ADRs, cross-cutting patterns |
