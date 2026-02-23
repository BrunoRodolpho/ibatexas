# IBX CLI Reference

`ibx` is the official tool for all dev operations in the IbateXas monorepo.
Always prefer it over raw `pnpm`, `docker compose`, or `turbo` commands.

---

## Installation

After cloning, build and link once:

```bash
pnpm --filter @ibatexas/cli build
cd packages/cli && npm link
```

Verify:

```bash
ibx --help
```

---

## Command Reference

### SDLC — `ibx dev`

```bash
ibx dev                    # start Docker infra + Medusa (default)
ibx dev commerce           # same as above, explicit
ibx dev all                # start all available services
ibx dev --skip-docker      # skip docker compose (infra already running)
ibx dev --no-wait          # start without polling health endpoints

ibx dev stop               # stop all Docker containers
ibx dev build              # build all packages (turbo build)
ibx dev build @ibatexas/cli  # build a specific package
ibx dev test               # run all tests (turbo test)
ibx dev test @ibatexas/cli   # run tests for a specific package
```

`ibx dev` runs 4 steps:
1. `docker compose up -d --wait` — starts Postgres 5433, Redis 6379, Typesense 8108, NATS 4222
2. Health checks — verifies all 4 services respond
3. Starts `medusa develop` for `apps/commerce`
4. Polls `http://localhost:9000/health` until `OK`

After startup, a summary box shows all running services with addresses.

### Services — `ibx svc`

```bash
ibx svc health             # check all infra services (Postgres, Redis, Typesense, NATS)
ibx svc health postgres    # detailed Postgres check (version, connections, latency samples)
ibx svc health redis       # detailed Redis check (version, uptime, clients)
ibx svc health typesense   # detailed Typesense check (health, document count)
ibx svc health nats        # detailed NATS check (version, connections, messages)
ibx svc health -s postgres # flag variant (same as positional arg)

ibx svc status             # table of all services — address, status, latency
```

### API — `ibx api`

```bash
ibx api products list          # list all products from Medusa
ibx api products list -l 100   # show up to 100 products
ibx api products add           # interactively create a new product
```

### Database — `ibx db`

```bash
ibx db migrate             # run pending Medusa migrations (Medusa must NOT be running)
ibx db seed                # seed products into Medusa (Medusa must be running)
ibx db reset               # ⚠️  drop + migrate + reseed (destructive)
ibx db reset --force       # skip confirmation prompt (for CI)
```

### Config — `ibx env`

```bash
ibx env check              # verify required vars are set (Step 1 by default)
ibx env check --step 2     # check up to Step 2 vars (includes ANTHROPIC_API_KEY)
ibx env show               # show all vars, secrets masked
ibx env show --reveal      # show full values (be careful!)
ibx env gen                # generate a 32-byte base64 secret
ibx env gen 64             # generate a 64-byte secret
```

Generate secrets manually: `openssl rand -base64 32`

### VCS — `ibx git`

```bash
ibx git status             # branch + staged/unstaged/untracked summary
ibx git log                # recent commits + open PR link
```

---

## Local URLs (when running)

| Service | URL |
|---------|-----|
| Medusa API | http://localhost:9000 |
| Medusa Admin | http://localhost:9000/app |
| Web (Next.js) | http://localhost:3000 |
| API (Fastify) | http://localhost:3001 |
| Typesense | http://localhost:8108 |
| NATS Monitor | http://localhost:8222 |

**Admin credentials:** `REDACTED_EMAIL` / `REDACTED_PASSWORD`

---

## Service Registry

`ibx dev` is service-aware. The registry lives in `packages/cli/src/services.ts`.

| Service key | Step available | Default? |
|-------------|---------------|----------|
| `commerce`  | Step 1 ✅     | Yes      |
| `agent`     | Step 3        | No       |
| `api`       | Step 4        | No       |
| `web`       | Step 5        | No       |

---

## Adding a New `ibx` Command

1. Create `packages/cli/src/commands/<name>.ts`
2. Export `register<Name>Commands(group: Command)`
3. In `packages/cli/src/index.ts`:
   - For a new top-level group: create a `new Command("group")`, call your register function, then `program.addCommand(group)`
   - For adding to an existing group (e.g. `api`): add your subcommand inside the existing register function
   - Update `buildHelpText()` in `index.ts` to include the new command in the grouped help display
4. Rebuild: `pnpm --filter @ibatexas/cli build`
5. Re-link: `cd packages/cli && npm link`
6. Test: `ibx <name> --help`

All commands must:
- Read config from `process.env` (loaded via dotenv from root `.env`)
- Import `ROOT` from `../utils/root.js` — never recompute it inline
- Use `chalk` for color, `ora` for spinners, `execa` for subprocesses
- Exit with code 1 on failure (never silently fail)
- Have a `--help` description

---

## Adding a New Service to `ibx dev`

When a new app is ready (e.g. Step 4 — API):

1. Open `packages/cli/src/services.ts`
2. Set `available: true` on the matching service entry
3. Add `healthUrl` once the service has a `/health` endpoint
4. Rebuild + re-link (steps 4–5 above)

No changes to `dev.ts` — it reads everything from the service registry.

---

## Adding a New Medusa Seed Product

Edit `apps/commerce/src/seed-data.ts`. Never add to `seed.ts` (it only imports data).

```typescript
{
  title: "Nome em pt-BR",
  handle: "nome-em-kebab-case",        // unique, lowercase, ASCII only
  description: "Descrição em pt-BR",
  categoryHandle: "categoria",          // must exist in CATEGORIES
  tags: ["popular", "defumado"],        // see allowed tags below
  variants: [
    { title: "500g", price: 8900 }     // price in centavos
  ],
  metadata: {
    productType: "food",                // "food" | "frozen" | "merchandise"
    availabilityWindow: "almoco",       // "almoco" | "jantar" | "always" | "congelados"
    nutritionalInfo: {
      calories: 450, protein: 35, carbs: 5, fat: 28, sodium: 800
    },
    allergens: [],                      // ALWAYS explicit — [] means none
  }
}
```

**Allowed tags:** `popular`, `chef_choice`, `sem_gluten`, `sem_lactose`, `vegano`,
`vegetariano`, `novo`, `congelado`, `defumado`

After editing seed data, run tests first, then reseed:

```bash
pnpm --filter @ibatexas/cli test
ibx db reset
```

---

## Running Tests

```bash
ibx dev test                        # all tests via turbo
ibx dev test @ibatexas/cli          # CLI/seed tests only (no DB required)
pnpm --filter @ibatexas/cli test    # direct (same result)
```

Tests live in `packages/cli/src/__tests__/`. They are pure unit tests — no database, no network.

---

## Direct Database Access

```bash
psql postgresql://ibatexas:ibatexas@localhost:5433/ibatexas
```

PostgreSQL runs on port **5433** (not 5432) to avoid conflicts with macOS's local Postgres.
Always use `DATABASE_URL` from `.env` — never hardcode the port.

---

## Avoid These

```bash
# ❌ Use ibx equivalents instead
pnpm --filter @ibatexas/commerce dev       # use: ibx dev
docker compose up -d                       # use: ibx dev
docker compose down                        # use: ibx dev stop
pnpm --filter @ibatexas/commerce db:migrate  # use: ibx db migrate
```
