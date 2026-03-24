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
ibx dev web                # start only the Next.js web app
ibx dev api                # start only the Fastify API
ibx dev admin              # start only the Next.js admin panel
ibx dev all                # start all available services (commerce + api + web + admin)
ibx dev --skip-docker      # skip docker compose (infra already running)
ibx dev --no-wait          # start without polling health endpoints

ibx dev start              # explicit alias for ibx dev
ibx dev start web          # explicit alias for ibx dev web

ibx dev stop               # stop all processes + docker compose down
ibx dev stop web           # stop only the web process (keeps Docker up)
ibx dev stop api           # stop only the API process (keeps Docker up)
ibx dev stop admin         # stop only the admin process (keeps Docker up)

ibx dev restart            # kill + respawn all services (no Docker restart)
ibx dev restart web        # kill + respawn only the web process
ibx dev restart api        # kill + respawn only the API process
ibx dev restart admin      # kill + respawn only the admin process

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

ibx svc logs               # tail Docker compose logs for all infra services
ibx svc logs postgres      # tail only Postgres logs
ibx svc logs redis         # tail only Redis logs
ibx svc logs -n 100        # show last 100 lines (default: 50)
```

### API — `ibx api`

```bash
# Product catalog (Medusa admin)
ibx api products list          # list all products from Medusa
ibx api products list -l 100   # show up to 100 products
ibx api products add           # interactively create a new product

# Search (Typesense)
ibx api search "costela"                    # fast direct Typesense search
ibx api search "costela" --full             # full pipeline: cache → embedding → Typesense
ibx api search "costela" --available-now    # filter to products available now
ibx api search "costela" --tags popular     # filter by tags
ibx api search "costela" --exclude-allergens gluten,lactose

# Agent chat (Step 4 — requires ibx dev api to be running)
ibx api chat "tem costela defumada?"             # new session, stream agent response
ibx api chat "e a de 1kg?" --session <uuid>      # continue an existing session
ibx api chat "cardápio do almoço" --channel web  # specify channel (web | whatsapp | instagram)
```

### Database — `ibx db`

```bash
ibx db migrate             # run pending Medusa migrations (Medusa must NOT be running)
ibx db migrate:domain      # run Prisma migrations for ibx_domain schema
ibx db seed                # seed products into Medusa (Medusa must be running)
ibx db seed:domain         # seed domain tables (DeliveryZone, Table, TimeSlot)
ibx db seed:homepage       # seed customers + reviews for homepage sections (Medusa must be running)
ibx db seed:delivery       # seed delivery zones, customer addresses, and dietary preferences
ibx db seed:orders         # seed order history + reservations (Medusa must be running)
ibx db clean               # ⚠️  delete all domain data (keeps schema + Medusa products)
ibx db clean --all         # also delete Medusa products + Typesense index
ibx db clean --force       # skip confirmation prompt
ibx db reset               # ⚠️  drop + migrate + reseed (destructive)
ibx db reset --force       # skip confirmation prompt (for CI)
ibx db reindex             # reindex Typesense from Medusa catalog
ibx db reindex --fresh     # drop + recreate Typesense collection, then reindex
ibx db status              # show migration status for both Medusa and domain schemas
```

### Config — `ibx env`

```bash
ibx env check              # verify required vars are set (Step 1 by default)
ibx env check --step 2     # check up to Step 2 vars (ANTHROPIC_API_KEY, OPENAI_API_KEY)
ibx env check --step 4     # check up to Step 4 vars (+ MEDUSA_PUBLISHABLE_KEY)
ibx env show               # show all vars, secrets masked
ibx env show --reveal      # show full values (be careful!)
ibx env gen                # generate a 32-byte base64 secret
ibx env gen 64             # generate a 64-byte secret
```

Generate secrets manually: `openssl rand -base64 32`

### Testing — `ibx test`

```bash
ibx test seed                  # full seed pipeline: products → reindex → domain → reviews → intel
ibx test seed --from=seed-homepage   # start from a specific task (skip earlier ones)
ibx test seed --skip=intel     # skip tasks matching pattern(s), comma-separated
ibx test seed --dry-run        # print the pipeline without executing
ibx test integration           # seed for UI ↔ API testing (skips product seed if exists)
ibx test e2e                   # ⚠️  full clean + reseed (destructive, requires confirmation)
ibx test e2e --force           # skip confirmation prompt
ibx test status                # dashboard — what's seeded and ready for each UI section
```

`ibx test seed` runs 9 steps in sequence:
1. Seed Medusa products
2. Reindex products into Typesense
3. Seed domain tables (Table + TimeSlots)
4. Seed customers + reviews (60 reviews across 15 products)
5. Seed delivery zones + addresses
6. Seed order history + reservations
7. Sync review stats to Typesense
8. Rebuild co-purchase matrix
9. Rebuild global product scores

`ibx test status` checks all UI data dependencies:
- Products (Typesense), Reviews, Recommendations, Co-purchase
- PitmasterPick (chef_choice tags), Em Alta (popular tags)
- Reservations, Delivery Zones, Tables, Customers

### Tags — `ibx tag`

```bash
ibx tag add <handle> <tag>     # add a tag to a product (triggers Typesense reindex)
ibx tag remove <handle> <tag>  # remove a tag from a product
ibx tag list                   # list all products that have tags
ibx tag list <handle>          # show tags for a specific product
```

**Allowed tags:** `popular`, `chef_choice`, `sem_gluten`, `sem_lactose`, `vegano`,
`vegetariano`, `novo`, `congelado`, `defumado`, `exclusivo`, `edicao_limitada`, `kit`

Invalid tags are blocked with an error showing the full list.

### Intelligence — `ibx intel`

```bash
ibx intel copurchase-reset              # delete all co-purchase Redis sorted sets
ibx intel copurchase-rebuild            # rebuild co-purchase sets from CustomerOrderItem history
ibx intel copurchase-rebuild --reset    # delete existing keys, then rebuild
ibx intel global-score-rebuild          # rebuild global product popularity sorted set
ibx intel global-score-rebuild --reset  # delete + rebuild
ibx intel scores-inspect                # show top products by global score
ibx intel scores-inspect <productId>    # show co-purchase scores for a product
ibx intel scores-inspect --top 20       # show top N results (default: 10)
ibx intel cache-stats                   # Redis memory usage for intelligence keys
```

### Scenarios — `ibx scenario`

YAML-driven state testing. Loads scenario files from `packages/cli/scenarios/*.yml`.

```bash
ibx scenario list                         # discover *.yml files, grouped by category
ibx scenario homepage                     # run full pipeline: lock → cleanup → setup → tags → rebuilds → verify
ibx scenario homepage --dry-run           # preview steps without executing
ibx scenario homepage --verify-only       # only run verify checks (no setup/tags/rebuilds)
ibx scenario homepage --skip=intel        # skip tasks matching pattern(s), comma-separated
ibx scenario homepage --no-cache          # bypass step cache
ibx scenario homepage --force             # override scenario lock
ibx scenario homepage --file ./custom.yml # load from a custom file path
```

Execution order: **lock → load YAML → resolve dependency DAG → cleanup → setup → tags → rebuilds → verify → unlock**

Available scenarios:
| Scenario | Category | Description |
|----------|----------|-------------|
| `base-products` | ui | Seed + reindex products |
| `base-customers` | ui | Seed customers, reviews, delivery, orders (depends: base-products) |
| `homepage` | ui | Homepage renders all merchandising sections |
| `search` | ui | Search browse mode — Pitmaster, Em Alta, Mais Pedidos |
| `recommendations` | intel | Full intelligence layer (depends: base-customers) |
| `customer` | customer | Customer data — profiles, addresses, preferences, order history |

Adding a new scenario = creating a `.yml` file in `packages/cli/scenarios/`.

### Debug — `ibx debug`

Infrastructure-level inspection (raw Redis keys, Typesense docs, customer profiles).

```bash
# Redis
ibx debug redis                        # key group summary (copurchase, global scores, search, etc.)
ibx debug redis "copurchase:*"         # inspect keys matching pattern (type, TTL, size), limit 20
ibx debug redis --ttl                  # add TTL column to group summary

# Typesense
ibx debug typesense                    # collection document count + field count
ibx debug typesense "costela"          # raw search with results
ibx debug typesense --schema           # full collection schema (fields, types, indexing)
ibx debug typesense --id <productId>   # single document by ID (full JSON dump)

# Customer profile
ibx debug profile <customerId>         # full dump: addresses, preferences, orders, reviews, reservations
```

### Inspect — `ibx inspect`

Business-level state inspection — what the UI sees, not raw infrastructure.

```bash
# System dashboard (default)
ibx inspect                            # data counts, tags, intelligence state, scenario lock

# Product deep-dive
ibx inspect product brisket-americano  # tags, rating, price, orders, global score, copurchase, reviews

# UI section state
ibx inspect page homepage              # which homepage sections are ready (Em Alta, Pitmaster, etc.)
ibx inspect page search                # which search sections are ready

# Cross-system consistency
ibx inspect integrity                  # Medusa ↔ Typesense count, customer completeness, copurchase validity
```

`ibx inspect page homepage` checks exact UI thresholds from the codebase:
- **Em Alta**: ≥1 product with `popular` tag
- **Pitmaster Recomenda**: ≥1 product with `chef_choice` tag
- **Mais Pedidos**: ≥1 product in global score ZSET
- **Reviews**: ≥1 review with rating≥4 + comment
- **Recommendations**: copurchase + global scores ready

### Doctor — `ibx doctor`

Comprehensive system diagnostics. CI gate command.

```bash
ibx doctor                             # full system check (infrastructure + data + intel + UI)
ibx doctor --fix                       # attempt auto-fixes (reindex, rebuild intel, sync reviews)
ibx doctor --ci                        # exit code 1 on any error-severity failure (for CI pipelines)
```

Checks run in order:
1. **Infrastructure** — Postgres, Redis, Typesense connectivity
2. **Data Integrity** — product count (Medusa = Typesense), reviews, order items
3. **Intelligence** — global scores, copurchase relations
4. **UI Contracts** — popular tags, chef_choice tags

`--fix` mode auto-repairs: reindexes Typesense if counts mismatch, rebuilds intelligence if empty, syncs review stats if stale.

### Matrix — `ibx matrix`

Combinatorial state testing. Generates 2^N state combinations from binary variables and verifies UI expectations.

```bash
ibx matrix list                            # list matrices with variable/state counts
ibx matrix homepage                        # run all 32 states (5 variables)
ibx matrix homepage --state=12             # run a specific state by index
ibx matrix homepage --random               # run a random state
ibx matrix homepage --corners              # corner cases: all-OFF, all-ON, each single-ON
ibx matrix states homepage                 # list all states (index, binary, active vars)
ibx matrix states homepage --corners       # list only corner case states
ibx matrix homepage --snapshot             # save results as snapshots
ibx matrix homepage --verify               # verify against saved snapshots (detect drift)
ibx matrix homepage --corners --snapshot   # save corner case snapshots
ibx matrix homepage --force                # override scenario lock
```

Available matrices:
| Matrix | Variables | States | Description |
|--------|-----------|--------|-------------|
| `homepage` | 5 | 32 | popularProducts, chefChoiceProducts, reviewsPresent, ordersPresent, copurchasePresent |
| `search` | 4 | 16 | popularProducts, chefChoiceProducts, ordersPresent, productsIndexed |
| `product` | 4 | 16 | reviewsPresent, copurchasePresent, globalScorePresent, tagsPresent |
| `intel` | 4 | 16 | ordersPresent, copurchaseBuilt, globalScoreBuilt, reviewStatsSync |

Each variable has `apply()` and `remove()` functions. The engine cleans all variables, applies only active ones, then evaluates expectations.

Snapshots are stored in `packages/cli/snapshots/<matrix>/state-<n>.json` and should be committed to git for drift detection.

### Simulate — `ibx simulate`

Generate realistic commerce behavior using seeded PRNG. Deterministic: same seed → same output.

```bash
ibx simulate full                          # full: 40 customers, 30 days, 15 orders/day, seed 42
ibx simulate full --days=60 --per-day=25   # custom parameters
ibx simulate full --scale=medium           # preset: 500 customers, 50 orders/day, 30 days
ibx simulate full --seed=123               # different seed = different data
ibx simulate full --no-rebuild             # skip intelligence rebuild
ibx simulate orders                        # orders only, no reviews
ibx simulate profiles                      # list behavior profiles + scale presets
```

Behavior profiles:
| Profile | Frequency | Basket | Avg Spend | Categories |
|---------|-----------|--------|-----------|------------|
| `pitmaster` | Weekly | 3 items | R$150 | carnes-defumadas |
| `family` | Bi-weekly | 5 items | R$120 | sanduiches, acompanhamentos, sobremesas |
| `casual` | Monthly | 2 items | R$45 | sanduiches, bebidas |
| `congelados` | 3 weeks | 2 items | R$80 | congelados |
| `superfan` | 10 days | 4 items | R$200 | carnes, kits, camisetas |

Scale presets:
| Preset | Customers | Orders/day | Days |
|--------|-----------|-----------|------|
| `small` | 20 | 5 | 30 |
| `medium` | 500 | 50 | 30 |
| `large` | 10000 | 500 | 30 |

Simulation can also be triggered from YAML scenarios with a `simulate:` block:

```yaml
simulate:
  customers: 40
  days: 30
  ordersPerDay: 15
  seed: 42
  behavior:
    pitmaster: 0.15
    family: 0.35
    casual: 0.50
  reviews:
    probability: 0.35
    ratingAvg: 4.3
```

### Network — `ibx tunnel`

```bash
ibx tunnel                 # expose local API (port 3001) via ngrok
ibx tunnel -p 3000         # expose a different port
```

Starts an ngrok tunnel and prints:
1. The public HTTPS URL
2. The full webhook URL (`<ngrok>/api/webhooks/whatsapp`)
3. Setup instructions for `.env` and Twilio Console

Use this for testing WhatsApp webhooks locally. Requires `ngrok` (`brew install ngrok`).

### Dependencies — `ibx deps`

```bash
ibx deps audit              # detect unused, non-deterministic, or drifted overrides
ibx deps drift              # check for undocumented override changes vs main
ibx deps radar              # check upstream packages for override removal opportunities
ibx deps check              # full dependency health check (audit + drift + radar)
```

`ibx deps audit` classifies each pnpm override as UNUSED, NON-DETERMINISTIC, VERSION DRIFT, or ACTIVE.
Exits with code 1 if any issues found.

`ibx deps drift` compares overrides against `origin/main`. Fails if new overrides are added without
a corresponding entry in `pnpm.overrideNotes`.

`ibx deps radar` checks latest published versions of prisma, @medusajs/medusa, vite, and posthog-js
against installed versions. Highlights when upstream upgrades could unblock override removal.

`ibx deps check` runs all three in sequence and reports a combined pass/fail.

### Infrastructure — `ibx infra`

```bash
# Bootstrap (fresh AWS account → ready for terraform)
ibx infra init                         # create S3 state bucket + DynamoDB lock table (idempotent)
ibx infra init --region us-east-1      # override default region (sa-east-1)

# Terraform operations
ibx infra plan                         # terraform plan with state safety check
ibx infra plan --out plan.tfplan       # save plan to file
ibx infra apply                        # terraform apply + display key outputs
ibx infra apply --plan plan.tfplan     # apply a saved plan
ibx infra apply --env staging          # target a different environment

# Secrets management
ibx infra secrets                      # interactive prompt for 17 Secrets Manager entries
ibx infra secrets --force              # re-prompt even for populated secrets
ibx infra secrets --from-env           # non-interactive: read from environment variables (CI)
ibx infra secrets --env staging        # target a different environment

# GitHub CI/CD secrets
ibx infra github                       # set repo secrets (OIDC role ARN, DB URLs, SONAR_TOKEN)

# Status and diagnostics
ibx infra status                       # deployment health dashboard
ibx infra status --json                # machine-readable output for CI
ibx infra checklist                    # numbered 12-step deployment checklist
ibx infra explain                      # diagnose why a deploy is failing (root cause chain)
ibx infra doctor                       # deep diagnostics (ECR, CloudWatch, Cloud Map, SGs)

# Operations
ibx infra logs api                     # tail CloudWatch logs for a service
ibx infra logs nats --lines 100        # tail with custom line count
ibx infra deploy                       # push current branch to dev
ibx infra deploy --target main         # push to main (production)
ibx infra deploy --watch               # push + poll status + health check
ibx infra deploy --watch --timeout 20m # custom timeout for first deploy
ibx infra destroy                      # ⚠  destroy all infrastructure (requires typing env name)
```

`ibx infra init` creates the S3 bucket for Terraform state and DynamoDB table for state locking.
Verifies AWS account identity and region before creating resources. Idempotent — safe to re-run.

`ibx infra secrets` validates each secret (URL format, key prefixes, minimum length) and runs
cross-validation after all inputs (e.g., DATABASE_URL vs DIRECT_DATABASE_URL host mismatch).

`ibx infra status` shows a deployment health confidence summary (HEALTHY / PARTIALLY HEALTHY / NOT READY)
plus grouped checks for AWS, Terraform, ECS services, image freshness, secret staleness, and GitHub secrets.

`ibx infra explain` follows the deployment dependency chain to find the root cause of failures:
GitHub Actions → ECR images → ECS services → application startup → secrets. Suggests a fix command.

For the full deployment guide, see [docs/setup/deployment.md](../setup/deployment.md).

### Auth — `ibx auth`

```bash
ibx auth flush [phoneHash]   # clear OTP rate-limit and brute-force keys for a phone
ibx auth status [phoneHash]  # show OTP send count and failure count for a phone
```

Useful for debugging OTP issues during development. The `phoneHash` is the first 12
characters of the SHA-256 hash of the E.164 phone number.

### VCS — `ibx git`

```bash
ibx git status             # branch + staged/unstaged/untracked summary
ibx git log                # recent commits + open PR link
```

---

## Local URLs (when running)

| Service         | URL                              |
|-----------------|----------------------------------|
| Medusa API      | http://localhost:9000           |
| Medusa Admin    | http://localhost:9000/app       |
| Web (Next.js)   | http://localhost:3000           |
| API (Fastify)   | http://localhost:3001           |
| API Swagger UI  | http://localhost:3001/docs      |
| Admin (Next.js) | http://localhost:3002/admin     |
| Typesense       | http://localhost:8108           |
| NATS Monitor    | http://localhost:8222           |
| PostHog         | https://app.posthog.com         |

**Admin credentials:** definidos pelas variáveis `MEDUSA_ADMIN_EMAIL` e `MEDUSA_ADMIN_PASSWORD` no `.env`

---

## Service Registry

`ibx dev` is service-aware. The registry lives in `packages/cli/src/services.ts`.

| Service key | Port | Available | Default? |
|-------------|------|-----------|----------|
| `commerce`  | 9000 | ✅        | Yes      |
| `api`       | 3001 | ✅        | No       |
| `web`       | 3000 | ✅        | No       |
| `admin`     | 3002 | ✅        | No       |

> **Note:** The agent orchestrator (`runAgent`) is a library (`packages/llm-provider`) used by `apps/api` — it is not a separate service.

To start specific services alongside Medusa:
```bash
ibx dev api      # start Docker + Medusa + Fastify API
ibx dev admin    # start Docker + Medusa + Admin panel
ibx dev all      # start all available services (commerce + api + web + admin)
```

---

## Adding a New Scenario

Create a `.yml` file in `packages/cli/scenarios/`. The engine discovers all YAML files at runtime.

```yaml
name: my-scenario
description: What this scenario sets up
category: ui                    # ui | intel | customer
estimatedTime: 10               # optional, in seconds

depends:                        # optional — other scenarios to run first (DAG resolved)
  - base-products

cleanup:                        # optional — runs BEFORE setup for deterministic state
  - reset-tags                  # remove all tags from all products
  # also: clear-reviews, clear-orders, clear-intel, clear-all

setup:                          # seed steps to run
  - seed-products
  - reindex
  - seed-domain
  - seed-homepage
  - seed-delivery
  - seed-orders

tags:                           # product handle → tag values to apply
  brisket-americano: [chef_choice]
  pulled-pork: [popular]

rebuilds:                       # intelligence steps to run after setup + tags
  - sync-reviews
  - intel-copurchase
  - intel-global-score

verify:                         # validation rules (all must pass)
  products:
    min: 20
  tag:popular:
    min: 6
  global-score:
    min: 1
  copurchase:
    exists: true
```

Available step names: `seed-products`, `reindex`, `seed-domain`, `seed-homepage`, `seed-delivery`, `seed-orders`, `sync-reviews`, `intel-copurchase`, `intel-global-score`

Available verify keys: `products`, `reviews`, `tag:<value>`, `global-score`, `copurchase`, `customers`, `addresses`, `preferences`, `order-items`, `reservations`, `tables`, `delivery-zones`

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
pnpm --filter @ibatexas/commerce dev         # use: ibx dev
pnpm --filter @ibatexas/admin dev            # use: ibx dev admin
docker compose up -d                         # use: ibx dev
docker compose down                          # use: ibx dev stop
pnpm --filter @ibatexas/commerce db:migrate  # use: ibx db migrate
```
