# CLAUDE.md — AI Agent Guide for IbateXas

> Read this before writing any code.

---

## The One Rule

Use `ibx` for all dev operations. Run `ibx --help` or `ibx <command> --help` before writing code.
If a command does not exist for what you need, add it to `packages/cli/` first, then use it.

```bash
ibx dev             # start Docker + Medusa
ibx dev stop        # stop Docker containers
ibx dev build       # build all packages
ibx dev test        # run all tests
ibx svc health      # check infra (Postgres, Redis, Typesense, NATS)
ibx svc health postgres  # detailed check for a specific service
ibx db seed         # seed products (Medusa must be running)
ibx db reset        # ⚠️  drop + migrate + reseed
ibx env check       # verify required env vars
ibx api products list  # inspect catalog
```

See **[docs/IBX-CLI.md](docs/IBX-CLI.md)** for the full command reference.

---

## Hard Rules — Never Break These

1. **Allergens:** always explicit array `[]` — never infer from product name or description
2. **Prices:** integer centavos (`8900` = R$89,00) — never floats
3. **Config:** always from `process.env` — never hardcode values in code
4. **User-facing text:** pt-BR only — product names, agent responses, error messages
5. **Auth:** Twilio Verify WhatsApp OTP — for both customers and staff. No Clerk, no passwords.
6. **`.env`:** never committed — update `.env.example` when adding new vars

---

## Naming Conventions

- **Interfaces/Types:** PascalCase (`Product`, `SeedVariant`, `CustomerProfile`)
- **Constants:** UPPER_SNAKE_CASE (`CATEGORIES`, `SEED_PRODUCTS`, `DEFAULT_SERVICES`)
- **Enums:** PascalCase (`ReservationStatus`, `ProductType`)
- **NATS events:** `domain.action` (`cart.abandoned`, `order.placed`)
- **NATS subjects:** `ibatexas.{domain}.{action}`
- **Product/category handles:** kebab-case, ASCII only (`costela-bovina-defumada`)
- **CLI commands:** lowercase (`dev`, `svc`, `api`, `db`)

---

## Where Things Live

| What | Where |
|------|-------|
| CLI reference | [docs/IBX-CLI.md](docs/IBX-CLI.md) |
| Architecture & design | [docs/design/](docs/design/) |
| Roadmap | [docs/next-steps.md](docs/next-steps.md) — remove items when done |
| Setup guide | [docs/setup/local-dev.md](docs/setup/local-dev.md) |

---

## Module System

- `packages/*`: ESM (`"type": "module"`), use `.js` extensions on local imports
- `apps/commerce`: CJS (Medusa constraint — do not change)
- TypeScript strict mode enabled globally — no implicit `any`
- Tests: no DB or network required — mock everything external

---

## Medusa v2 Conventions

```typescript
// ✅ Correct field names
category_ids: ["cat_123"]   // not categories: [{ id }]
tag_ids: ["tag_abc"]        // not tags: [{ id }]

// ✅ Link variant → price set via Remote Link
const remoteLink = container.resolve(ContainerRegistrationKeys.LINK)
await remoteLink.create([{
  [Modules.PRODUCT]: { variant_id: variantId },
  [Modules.PRICING]: { price_set_id: priceSet.id },
}])
```

---

## Design Docs — Read Before Building

| Doc | Read before |
|-----|------------|
| [bounded-contexts.md](docs/design/bounded-contexts.md) | Any domain logic |
| [domain-model.md](docs/design/domain-model.md) | Any entity or schema |
| [agent-tools.md](docs/design/agent-tools.md) | Any AI tool |
| [use-cases.md](docs/design/use-cases.md) | Any user-facing feature |
| [customer-intelligence.md](docs/design/customer-intelligence.md) | Recommendations or profiles |
