# CLAUDE.md — AI Agent Guide for IbateXas

> Read this before writing any code.

---

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
7. **Redis keys:** always use `rk()` from `@ibatexas/tools` — never build raw key strings inline
8. **Analytics events:** add to `AnalyticsEvent` union in `apps/web/src/lib/analytics.ts` AND document in `docs/analytics-dashboards.md`

---

## Naming Conventions

- **Interfaces/Types:** PascalCase (`Product`, `SeedVariant`, `CustomerProfile`)
- **Constants:** UPPER_SNAKE_CASE (`CATEGORIES`, `SEED_PRODUCTS`, `DEFAULT_SERVICES`)
- **Enums:** PascalCase (`ReservationStatus`, `ProductType`)
- **NATS events:** `domain.action` (`cart.abandoned`, `order.placed`)
- **NATS subjects:** `ibatexas.{domain}.{action}`
- **Product/category handles:** kebab-case, ASCII only (`costela-bovina-defumada`)
- **CLI commands:** lowercase (`dev`, `svc`, `api`, `db`, `intel`)

---

## Where Things Live

| What | Where |
|------|-------|
| CLI reference | [docs/ibx-cli.md](docs/ibx-cli.md) |
| Architecture & design | [docs/design/](docs/design/) |
| Roadmap | [docs/next-steps.md](docs/next-steps.md) — remove items when done |
| Setup guide | [docs/setup/local-dev.md](docs/setup/local-dev.md) |
| Analytics & dashboards | [docs/analytics-dashboards.md](docs/analytics-dashboards.md) |
| Redis key patterns | [docs/ops/redis-memory.md](docs/ops/redis-memory.md) |

---

## Module System

- `packages/*`: ESM (`"type": "module"`), use `.js` extensions on local imports
- `apps/commerce`: CJS (Medusa constraint — do not change)
- TypeScript strict mode enabled globally — no implicit `any`
- Tests: no DB or network required — mock everything external

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
