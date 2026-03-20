# CLAUDE.md Accuracy Check
> Post-audit verification -- Generated: 2026-03-19

---

## Accurate

### Build & Test & Plan Mode
All four directives are reasonable operational rules. No contradictions in codebase.

### Agent Teams
`claude --teammate-mode in-process` directive -- cannot verify runtime behaviour but the instruction is self-contained.

### The One Rule -- `ibx` CLI
- `ibx` exists at `packages/cli/`, built with Commander, bin entry `"ibx": "./dist/index.js"`.
- `docs/ibx-cli.md` exists and documents the full command reference.
- The instruction to add missing commands to `packages/cli/` first is sound.

### Hard Rule 1 -- Allergens explicit array
Confirmed. `apps/commerce/src/seed-data.ts` defines `allergens: string[]` on every product with explicit arrays (empty or populated). No inference from names.

### Hard Rule 2 -- Prices in integer centavos
Confirmed. Test fixtures use `price: 8900` (integer). Types define prices as numbers, used consistently as centavos.

### Hard Rule 3 -- Config from process.env
Confirmed. API config, Redis client, NATS client, LLM provider, Medusa config all read from `process.env`. No hardcoded secrets found.

### Hard Rule 4 -- User-facing text pt-BR only
Confirmed for product data and agent responses. Seed data is in Portuguese.

### Hard Rule 5 -- Auth: Twilio Verify WhatsApp OTP
Confirmed. `apps/api/src/routes/auth.ts` uses Twilio Verify. No Clerk dependency in code (only mentioned in CLAUDE.md and README as "No Clerk").

### Hard Rule 6 -- .env never committed
`.env.example` exists at root and `packages/cli/.env.example`. `.gitignore` presumably excludes `.env` (standard). Note: `packages/cli/.env` exists on disk -- not a CLAUDE.md issue but a local hygiene concern.

### Hard Rule 7 -- Redis keys via rk()
Confirmed. `rk()` is exported from `packages/tools/src/redis/key.ts`, prepends `${APP_ENV}:` prefix. Used throughout the codebase.

### Hard Rule 8 -- Analytics events in AnalyticsEvent union
Confirmed. `apps/web/src/domains/analytics/events.ts` defines the `AnalyticsEvent` type union with ~40 events. `docs/analytics-dashboards.md` exists.

### Naming -- Interfaces/Types PascalCase
Confirmed. `Product`, `SeedVariant`, `CustomerProfile`, `ReservationDTO` all PascalCase.

### Naming -- Constants UPPER_SNAKE_CASE
Confirmed. `CATEGORIES`, `SEED_PRODUCTS`, `DEFAULT_SERVICES`, `OUTBOX_EVENTS` all UPPER_SNAKE_CASE.

### Naming -- Enums PascalCase
Confirmed. `ReservationStatus`, `ProductType`, `AvailabilityWindow`, `Channel`, `TableLocation`, `SpecialRequestType` all PascalCase.

### Naming -- NATS subjects with ibatexas. prefix
Confirmed. `publishNatsEvent` prepends `ibatexas.` to the short-form event name (line 130 of `packages/nats-client/src/index.ts`).

### Naming -- NATS test assertions short-form
Mostly correct. In app/tool-level tests that mock `publishNatsEvent`, the short form is asserted (e.g., `"cart.abandoned"`, `"order.placed"`). The nats-client's own unit tests do assert the full `"ibatexas.*"` form, which is expected since they test the client's internal behaviour.

### Naming -- Product/category handles kebab-case ASCII
Confirmed in seed data (e.g., `costela-bovina-defumada`).

### Where Things Live -- most entries
All referenced paths exist:
- `docs/ibx-cli.md`
- `docs/design/` (contains 5 design docs)
- `docs/next-steps.md`
- `docs/setup/local-dev.md`
- `docs/analytics-dashboards.md`
- `docs/ops/redis-memory.md`
- `apps/admin` (port 3002 confirmed in `package.json`)
- `docs/audit/`

### Design Docs table
All 7 referenced docs exist at the claimed paths.

### Module System -- packages/* ESM with .js extensions
Confirmed. `packages/tools`, `packages/domain`, `packages/nats-client`, `packages/types`, `packages/llm-provider`, `packages/ui`, `packages/cli` all have `"type": "module"`. ESM imports use `.js` extensions (verified in `packages/tools/src/index.ts`).

### Module System -- TypeScript strict mode
Confirmed. `tsconfig.base.json` has `"strict": true`.

### Module System -- Tests mock everything external
Confirmed by CI workflow: no DB or network services in GitHub Actions, tests run with `pnpm test`.

---

## Inaccurate

### 1. Module System -- apps/commerce is NOT CJS

- **Section**: Module System
- **Claims**: `apps/commerce: CJS (Medusa constraint -- do not change)`
- **Reality**: `apps/commerce/package.json` has NO `"type"` field (defaults to CJS for Node.js resolution), but all source files use ESM `import`/`export` syntax. Zero `require()` or `module.exports` in `apps/commerce/src/`. Medusa v2 uses ESM natively. The `medusa-config.ts` uses `import { defineConfig }` and `export default`. The tsconfig extends `tsconfig.base.json` which sets `"module": "NodeNext"`.
- **Fix**: Replace with: `apps/commerce: No \`"type": "module"\` in package.json (Medusa handles its own build pipeline via \`medusa develop\` / \`medusa build\`). Source uses ESM syntax.`

### 2. Module System -- packages/* ESM has one exception

- **Section**: Module System
- **Claims**: `packages/*: ESM ("type": "module"), use .js extensions on local imports`
- **Reality**: 7 of 8 packages have `"type": "module"`. The exception is `packages/eslint-config` which uses CJS (`module.exports` in `index.js`, no `"type"` field).
- **Fix**: Add note: `(exception: packages/eslint-config is CJS -- standard for ESLint configs)`

### 3. Naming -- CLI commands list is incomplete

- **Section**: Naming Conventions
- **Claims**: `CLI commands: lowercase (dev, svc, api, db, intel)`
- **Reality**: The CLI has 17 command groups: `dev`, `svc`, `api`, `db`, `intel` (alias for `intelligence`), `test`, `tag`, `scenario`, `debug`, `inspect`, `matrix`, `simulate`, `doctor`, `auth`, `env`, `git`, `tunnel`. The listed 5 are just examples but the parenthetical phrasing implies they are exhaustive.
- **Fix**: Either list all commands or clarify these are examples: `CLI commands: lowercase (e.g., dev, svc, api, db, intel) -- see docs/ibx-cli.md for the full list`

### 4. Where Things Live table is missing apps/web and apps/api

- **Section**: Where Things Live
- **Claims**: Table lists 8 entries but omits the primary application services.
- **Reality**: `apps/web` (Next.js storefront, port 3000), `apps/api` (Fastify API, port 3001), `apps/commerce` (Medusa, port 9000) are the three core runtime services. Only `apps/admin` (port 3002) is mentioned.
- **Fix**: Add rows:
  ```
  | Storefront      | `apps/web` (port 3000) -- Next.js customer-facing app |
  | API server      | `apps/api` (port 3001) -- Fastify backend |
  | Commerce engine | `apps/commerce` (port 9000) -- Medusa v2 |
  ```

---

## Missing

### 1. Package registry -- 8 workspace packages not listed
CLAUDE.md never mentions the full set of internal packages. The monorepo has:
- `packages/cli` -- the `ibx` CLI
- `packages/domain` -- Prisma schema and DB client
- `packages/tools` -- AI agent tools, Redis utilities, search, cart logic
- `packages/types` -- shared TypeScript types and Zod schemas
- `packages/llm-provider` -- Anthropic SDK wrapper, agent loop
- `packages/nats-client` -- NATS pub/sub wrapper
- `packages/ui` -- shared React component library (atoms/molecules/organisms)
- `packages/eslint-config` -- shared ESLint config (CJS)

Agents frequently need to know which package owns which responsibility.

### 2. CI pipeline not described
The project has a GitHub Actions CI pipeline (`.github/workflows/ci.yml`) that runs: install, prisma generate, lint, test with coverage, security audit (non-blocking), build, SonarCloud scan. This is important context for agents working on CI-related tasks.

### 3. Docker infrastructure not mentioned
`docker-compose.yml` provides local dev infrastructure: Postgres, Redis, Typesense, NATS. `docker-compose.prod.yml` and Dockerfiles for `apps/api`, `apps/web`, `apps/admin` were added during the audit. The `ibx dev` and `ibx svc` commands manage these containers.

### 4. AUDIT-FIX comments throughout codebase
191 `AUDIT-FIX` and `AUDIT-REVIEW` comment markers exist across 80 files. Agents should know these are intentional audit-trail comments, not TODOs to be cleaned up. The 8 `AUDIT-REVIEW` items are deferred feature work documented in `docs/audit/REMEDIATION-COMPLETE.md`.

### 5. Medusa v2 as commerce engine
CLAUDE.md never explains that the commerce layer is Medusa v2. This affects how products are created (via Medusa admin API), how subscribers work (Medusa event system), and why `apps/commerce` has its own build/dev lifecycle (`medusa develop`, not `tsx`).

### 6. Infrastructure directory
`infra/terraform/` exists with `environments/` and `modules/` subdirectories. Currently minimal (provider-only config per audit report).

### 7. docs/features and docs/backlog directories
These directories exist but are not referenced in CLAUDE.md:
- `docs/features/` -- contains `wishlist.md`
- `docs/backlog/` -- contains `ARCHITECTURE-NOTES.md`, `AUDIT-INSIGHTS.md`, `TODO-BACKLOG.md`

### 8. Vitest as test runner
CLAUDE.md says "Tests: no DB or network required" but never names the test framework. The project uses Vitest with `vitest run`, configured in `vitest.config.ts` at root with v8 coverage provider.

---

## Suggested Additions

### 1. Service Ports quick-reference
Add to "Where Things Live" or as its own section:
```
| Service  | Port | Package           |
|----------|------|-------------------|
| Web      | 3000 | apps/web          |
| API      | 3001 | apps/api          |
| Admin    | 3002 | apps/admin        |
| Commerce | 9000 | apps/commerce     |
```

### 2. Package dependency note
The `@ibatexas/tools` package is the most-imported internal package (depended on by `apps/api`, `apps/web`, `apps/admin`, `apps/commerce`, `packages/cli`, `packages/llm-provider`). Changes here have wide blast radius.

### 3. Medusa section
A brief note explaining the Medusa v2 relationship:
- Products are managed via Medusa's admin API and indexed to Typesense
- Medusa subscribers fire on product/price/variant changes
- `apps/commerce` uses `medusa develop` / `medusa build`, not standard `tsc` / `tsx`

### 4. Test framework
Add to Module System section: `Tests: Vitest with v8 coverage. Run via \`ibx dev test\` or \`pnpm test\`. No DB or network required -- mock everything external.`

### 5. Audit markers policy
Add a note: `AUDIT-FIX: comments are intentional audit trail -- do not remove. AUDIT-REVIEW: marks deferred work items -- see docs/audit/REMEDIATION-COMPLETE.md.`
