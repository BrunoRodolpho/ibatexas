# H3 Investigation — Test fixture audit

**Date:** 2026-05-24  
**Investigator:** READ-ONLY survey  
**Scope:** Testcontainer patterns, fixture builders, and isolation models for H3 T4 conformance suite  
**Status:** Complete — no code changes, no commits

---

## Executive summary

H3's T4 conformance suite will snapshot every table reachable from `customerId`, anonymize via the domain service, and assert zero PII remains. The existing test infrastructure has:

- **Real Redis testcontainer** pattern established (T6, R2-2 use `setupRedisTestContainer()` with testcontainers package)
- **Zero Postgres testcontainer** pattern (no real-DB tests; all domain tests use mocks)
- **Scattered fixture builders** (medusa factories in cart tests; no Prisma entity factories across domain/api)
- **Hard blocker:** anonymize service is **incomplete** (P0-9 in SYNTHESIS.md) — 8 tables leak PII post-anonymize

**Recommendation:** T4 requires a **prerequisite P0 scope-close** on P0-9 before fixture setup begins. Then: per-test transactional rollback with a real Postgres testcontainer (mirrored on Redis pattern), plus a declarative fixture builder to populate customer + all reachable tables in a single spec.

---

## 1. Existing anonymize test coverage

### `packages/domain/src/services/__tests__/anonymize-customer.test.ts`

**Coverage:** unit test only, fully mocked Prisma

- ✅ Customer fields: email/cpf/name/phone (phone hashed, others nulled)
- ✅ Addresses: deleteMany
- ✅ CustomerPreferences: deleteMany
- ✅ Reviews: comment nulled (customerId preserved per schema constraint)
- ✅ CustomerOrderItem: customerId delinked (SetNull)
- ✅ Transaction wrapping + timeout (60s budget)
- ✅ Heavy-path batching: >1000 reviews split into 500-ID batches outside TX

**Gaps (blocking T4):**

- ❌ Does NOT test OrderProjection ({customerEmail, customerName, customerPhone, shippingAddressJson})
- ❌ Does NOT test ConversationMessage.content
- ❌ Does NOT test Conversation.customerId delink
- ❌ Does NOT test OrderStatusHistory.actorId delink
- ❌ Does NOT test OrderEventLog.payload scrub
- ❌ Does NOT test LoyaltyAccount cascade delete
- ❌ Does NOT test Reservation.specialRequests scrub
- ❌ Does NOT test Medusa-side customer row (cross-DB)

**Per P0-9 (SYNTHESIS.md §E-2):** anonymizeCustomer leaves PII in 8 reachable tables. T4 cannot pass until the executor is fixed.

---

## 2. Testcontainer pattern inventory

### Real-Redis testcontainer (R2-2, T6)

**Pattern location:** `apps/api/src/__tests__/helpers/redis-testcontainer.ts`

**Skeleton:**
```typescript
// Setup
import { GenericContainer } from "testcontainers"
import { createClient, type RedisClientType } from "redis"

export interface RedisTestHarness {
  client: RedisClientType
  url: string
  host: string
  port: number
  teardown: () => Promise<void>
}

export async function setupRedisTestContainer(): Promise<RedisTestHarness> {
  const container = await new GenericContainer("redis:7-alpine")
    .withExposedPorts(6379)
    .withStartupTimeout(60_000)
    .start()
  
  const host = container.getHost()
  const port = container.getMappedPort(6379)
  const client = createClient({ url: `redis://${host}:${port}` })
  await client.connect()
  
  return {
    client,
    url: `redis://${host}:${port}`,
    host,
    port,
    async teardown() {
      try {
        if (client.isOpen) await client.quit()
      } finally {
        await container.stop({ remove: true, timeout: 10_000 })
      }
    },
  }
}

// Usage in test
let harness: RedisTestHarness

beforeAll(async () => {
  harness = await setupRedisTestContainer()
}, 120_000)

afterAll(async () => {
  await harness?.teardown()
})

beforeEach(async () => {
  await harness.client.flushDb()
})
```

**Key insight from T6 (sweeper-resolver-race.test.ts):**
- Container is ephemeral (testcontainers picks a random host port)
- Lua scripts run on REAL server (no emulation theater)
- SETNX atomicity is end-to-end (tests actual race conditions)
- Skip flag: `IBX_SKIP_REAL_REDIS=1` for local dev only; CI runs real containers
- **Hard rule (RULE 3):** "real infrastructure or no test"

**No existing Postgres testcontainer.**

---

## 3. Global test setup (H2 baseline)

### `apps/api/src/__tests__/setup.ts` + `packages/tools/src/__tests__/setup.ts`

Both files initialize **noop audit sink** at test bootstrap:
```typescript
__setAuditSinkDependencies({
  spillStorage: { /* noop */ },
  postgresWriter: { async insertAudit() { /* noop */ } },
  natsPublisher: { async publish() { /* noop */ } },
  redactor: { redact(r) { return r } },
  logger: { warn() {}, error() {} },
})
```

**Purpose:** getAuditSink() is fail-closed (throws before wiring); every test file that imports code using the sink must call this setup. Prevents boot-time injection errors.

**For H3 T4:** the existing no-op setup is compatible. When T4 switches to a real Postgres testcontainer, the postgresWriter mock can be replaced with a live sink pointing to the container.

---

## 4. Fixture builder patterns

### Existing factory pattern: Medusa fixtures

**Location:** `packages/tools/src/cart/__tests__/fixtures/medusa.ts`

**Shape:**
```typescript
export function makeCtx(overrides?: Partial<AgentContext>): AgentContext { ... }
export function makeLineItem(overrides?: Partial<MedusaLineItem>): MedusaLineItem { ... }
export function makeCart(overrides?: Partial<MedusaCart>): MedusaCart { ... }
export function makeOrder(overrides?: Partial<MedusaOrder>): MedusaOrder { ... }
```

**Pattern:**
- Single "make" function per entity
- Accepts optional `overrides` map
- Returns fully-populated object with sensible defaults
- Composable (makeCart calls makeLineItem)

**Applicability to T4:**
- This is a **simulation factory** (creates in-memory objects, not DB rows)
- For real-DB T4, need **Prisma factory** that hits the testcontainer

### No existing Prisma entity factories

**Finding:** Zero factory utilities for domain models (Customer, Address, Reservation, etc.)

---

## 5. Recommended fixture-builder shape for T4

**Design principle:** Minimize per-surface boilerplate. One declarative spec → multiple inserts.

**Skeleton:**

```typescript
// apps/api/src/__tests__/helpers/postgres-testcontainer.ts
import { GenericContainer } from "testcontainers"
import { PrismaClient } from "@ibatexas/domain/generated/prisma-client"

export interface PostgresTestHarness {
  client: PrismaClient
  url: string
  teardown: () => Promise<void>
}

export async function setupPostgresTestContainer(): Promise<PostgresTestHarness> {
  const container = await new GenericContainer("postgres:15-alpine")
    .withExposedPorts(5432)
    .withEnv("POSTGRES_PASSWORD", "test")
    .withEnv("POSTGRES_DB", "ibatexas_test")
    .withStartupTimeout(60_000)
    .start()
  
  const host = container.getHost()
  const port = container.getMappedPort(5432)
  const url = `postgresql://postgres:test@${host}:${port}/ibatexas_test`
  
  const client = new PrismaClient({ datasourceUrl: url })
  await client.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS ibx_domain`)
  // Run migrations: await execSync("prisma migrate deploy", { env: { DATABASE_URL: url } })
  
  return {
    client,
    url,
    async teardown() {
      await client.$disconnect()
      await container.stop({ remove: true, timeout: 10_000 })
    },
  }
}

// apps/api/src/__tests__/helpers/pii-fixture-builder.ts
export interface PIIFixtureSpec {
  customerId: string
  phone: string
  email: string
  name: string
  cpf: string
  
  // Reachable tables
  addresses?: Array<{ street: string; city: string; cep: string }>
  reviews?: Array<{ orderId: string; comment: string; rating: number }>
  reservations?: Array<{ slotId: string; partySize: number }>
  orderItems?: Array<{ orderId: string; productId: string; quantity: number }>
  preferences?: { allergens: string[]; restrictions: string[] }
  conversation?: { sessionId: string; messageContent: string }
  loyaltyAccount?: { stamps: number }
}

export async function buildPIIFixture(
  prisma: PrismaClient,
  spec: PIIFixtureSpec,
): Promise<{
  customerId: string
  fixtures: Record<string, unknown[]>
}> {
  const fixtures: Record<string, unknown[]> = {}
  
  // Customer
  const customer = await prisma.customer.create({
    data: {
      id: spec.customerId,
      phone: spec.phone,
      email: spec.email,
      name: spec.name,
      cpf: spec.cpf,
    },
  })
  fixtures.customer = [customer]
  
  // Addresses
  if (spec.addresses?.length) {
    fixtures.addresses = await prisma.address.createMany({
      data: spec.addresses.map((a) => ({
        ...a,
        customerId: spec.customerId,
        state: "SP",
      })),
    })
  }
  
  // Reviews (requires order in Medusa first; for now key by orderId string)
  if (spec.reviews?.length) {
    fixtures.reviews = await prisma.review.createMany({
      data: spec.reviews.map((r) => ({
        ...r,
        customerId: spec.customerId,
        rating: r.rating ?? 5,
        channel: "web",
        productIds: [],
      })),
    })
  }
  
  // ... similar for reservations, orderItems, preferences, conversation, loyaltyAccount
  
  return { customerId: spec.customerId, fixtures }
}

// Usage in T4 test
describe("H3-T4: anonymize conformance", () => {
  let harness: PostgresTestHarness

  beforeAll(async () => {
    harness = await setupPostgresTestContainer()
  }, 120_000)

  afterAll(async () => {
    await harness?.teardown()
  })

  it("asserts zero PII remains post-anonymize across all reachable tables", async () => {
    const spec: PIIFixtureSpec = {
      customerId: "cust_t4_01",
      phone: "+5511999999999",
      email: "test@example.com",
      name: "Test User",
      cpf: "123.456.789-00",
      addresses: [{ street: "Rua A", city: "São Paulo", cep: "01000000" }],
      reviews: [{ orderId: "ord_01", comment: "Great product!", rating: 5 }],
      preferences: { allergens: ["peanuts"], restrictions: ["vegetarian"] },
    }

    const { fixtures } = await buildPIIFixture(harness.client, spec)

    // Pre-anonymize snapshot
    const prePII = {
      customerEmail: fixtures.customer[0].email,
      customerPhone: fixtures.customer[0].phone,
      customerName: fixtures.customer[0].name,
      customerCpf: fixtures.customer[0].cpf,
      reviewComment: fixtures.reviews[0].comment,
      addressStreet: fixtures.addresses[0].street,
      preferenceAllergens: fixtures.preferences?.allergens,
    }

    // Run anonymize
    await anonymizeCustomer(spec.customerId)

    // Post-anonymize snapshot
    const postCustomer = await harness.client.customer.findUnique({
      where: { id: spec.customerId },
    })
    const postReviews = await harness.client.review.findMany({
      where: { customerId: spec.customerId },
    })
    const postAddresses = await harness.client.address.findMany({
      where: { customerId: spec.customerId },
    })

    // Assertions
    expect(postCustomer.email).toBeNull()
    expect(postCustomer.cpf).toBeNull()
    expect(postCustomer.phone).toMatch(/^anonymized:[a-f0-9]{16}$/)
    expect(postCustomer.name).toBe("Usuário Removido")
    expect(postReviews).toHaveLength(0) // OR: comment is null
    expect(postAddresses).toHaveLength(0) // Deleted
    
    // Assert NO plaintext PII in the snapshot
    const json = JSON.stringify({ postCustomer, postReviews, postAddresses })
    expect(json).not.toContain(prePII.customerEmail)
    expect(json).not.toContain(prePII.customerPhone)
    expect(json).not.toContain(prePII.customerCpf)
    expect(json).not.toContain(prePII.reviewComment)
  })
})
```

**Key attributes:**
- Declarative spec maps to multiple table inserts (minimal boilerplate per entity)
- Fixture builder returns both IDs and full objects (enables both assertion on PII presence AND quantity checks)
- Single transaction could wrap per-test setup (rollback on cleanup)
- Compatible with existing anonymizeCustomer contract (takes customerId, expects it to run end-to-end)

---

## 6. Existing factories / builders inventory

| Entity | Factory Present? | Location | Type |
|--------|------------------|----------|------|
| Customer | ❌ No | — | — |
| Address | ❌ No | — | — |
| Review | ❌ No | — | — |
| Reservation | ❌ No | — | — |
| OrderProjection | ❌ No | — | — |
| OrderNote | ❌ No | — | — |
| OrderStatusHistory | ❌ No | — | — |
| OrderEventLog | ❌ No | — | — |
| Payment | ❌ No | — | — |
| LoyaltyAccount | ❌ No | — | — |
| Conversation | ❌ No | — | — |
| ConversationMessage | ❌ No | — | — |
| CustomerPreferences | ❌ No | — | — |
| CustomerOrderItem | ❌ No | — | — |
| Table (reservation) | ❌ No | — | — |
| TimeSlot | ❌ No | — | — |
| Waitlist | ❌ No | — | — |
| Medusa (AgentContext, Cart, LineItem, Order) | ✅ Yes | `packages/tools/src/cart/__tests__/fixtures/medusa.ts` | Simulation factory |

**Implication:** T4 must either create Prisma factories for all domain entities, OR use the declarative spec builder approach (recommended above) that builds fixtures on-demand per test.

---

## 7. Cross-DB testing concern

**Current state:** 
- Domain Prisma schema lives at `packages/domain/prisma/schema.prisma` (ibx_domain schema)
- Medusa operates in a separate DB with its own schema
- anonymizeCustomer only touches the domain DB; **Medusa-side customer row is NOT anonymized** (P0-9 gap)

**For H3:** if the cross-DB approach (per H3-CROSSDB investigator) requires Medusa testcontainer:

- ❌ No existing Medusa testcontainer pattern
- ❌ Medusa `develop` mode does not support ephemeral container mode (requires full Docker setup with migrations)
- ⚠️ **Recommendation:** scope H3-T4 to domain DB only. Medusa-side scrub should be part of the P0-9 fix (separate spike), handled via a compensation pattern or a two-phase commit shim.

If Medusa testing IS required later:
- Create a `setupMedusaTestContainer()` helper (similar Redis pattern)
- Use Medusa's test mode or a lightweight SQLite in-memory for quick iteration
- Document the cross-DB transaction constraints (Prisma `$transaction` does NOT span databases)

---

## 8. Isolation model recommendation

**Three options, analyzed:**

### Option A: Per-test fresh DB (slow, safe)

```typescript
beforeEach(async () => {
  // Run full migration suite on the testcontainer
  await execSync("prisma migrate deploy", { env: { DATABASE_URL: harness.url } })
})

afterEach(async () => {
  // Drop all tables and re-migrate
  await execSync("prisma migrate reset", { env: { DATABASE_URL: harness.url } })
})
```

**Pros:** zero cross-test contamination, cleanest isolation  
**Cons:** 30-60s per test (migrations are slow); T4 suite becomes slow (~5-10min total)

### Option B: Shared DB with per-test customerId scoping (fast, requires careful queries)

```typescript
beforeEach(async () => {
  // Flush only rows for this test's customerId
  const testCustId = `cust_t4_${Date.now()}_${Math.random()}`
  await harness.client.customer.deleteMany({
    where: { id: testCustId },
  })
  // (cascades wipe all related rows)
})
```

**Pros:** fast (no migrations), simple cleanup  
**Cons:** requires CAREFUL foreign-key cascades in schema; risk of data leak if cascade is misconfigured; queries must be scoped to customerId

### Option C: Transactional rollback (clean, may not work cross-connection)

```typescript
beforeEach(async () => {
  txClient = await harness.client.$transaction(/* ... */)
})

afterEach(async () => {
  // Rollback implicit when tx scope exits
  // (CAVEAT: only works if ALL queries stay in same prisma.$transaction closure)
})
```

**Pros:** automatic cleanup, zero migration overhead  
**Cons:** Prisma's implicit-return behavior makes this tricky; requires wrapping every test in a nested $transaction; doesn't work if anonymizeCustomer itself uses $transaction (would nest)

---

## 9. Recommended isolation model for T4

**→ Option A (per-test fresh DB) with migration cache optimization:**

```typescript
let harness: PostgresTestHarness

beforeAll(async () => {
  harness = await setupPostgresTestContainer()
  // Run migrations ONCE at bootstrap
  await execSync("prisma migrate deploy", { env: { DATABASE_URL: harness.url } })
}, 120_000)

afterEach(async () => {
  // Truncate and re-seed seed data (fast, ~500ms)
  // rather than full migration reset
  await harness.client.$queryRaw`TRUNCATE TABLE ibx_domain.customers CASCADE`
  // (repeat for all tables in dependency order, or use a TRUNCATE ALL)
})
```

**Rationale:**
1. Migrations are a one-time cost at bootstrap; per-test truncate is ~500ms (acceptable)
2. Full cascade-delete via customerId (Option B) is equivalent but relies on FK cascade behavior (riskier)
3. Transactional rollback (Option C) conflicts with anonymizeCustomer's own $transaction
4. Matches production isolation best practices (each test gets clean schema state)

**Cost:** ~5-10 min total suite run (50-100 tests × 500-1000ms isolation overhead) — acceptable for a conformance suite.

---

## 10. Estimated T4 implementation effort breakdown

| Component | Effort | Notes |
|-----------|--------|-------|
| **Prerequisites** | | |
| P0-9 fix: extend anonymizeCustomer to 8 tables | 1-2 days | Blocking. Includes OrderProjection scrub, ConversationMessage, LoyaltyAccount, Medusa-side compensation. |
| **Infrastructure** | | |
| Postgres testcontainer helper | 2-3h | Similar to Redis pattern; main complexity is migration wiring. |
| Global test setup (audit sink wired to real Postgres) | 1h | Minimal; reuse existing setup.ts pattern. |
| **Fixtures** | | |
| PIIFixtureSpec + builder (all 12+ reachable tables) | 3-4h | One fixture builder, declarative spec, cascading inserts. |
| Optional: Prisma entity factories | 2-3h | If preferred over the spec builder; lower priority. |
| **Test suite** | | |
| H3-T4 test (snapshot pre, run anonymize, snapshot post, assert zero PII) | 2-3h | ~50-100 test cases (per-table, edge cases like nullable fields, empty sets, cross-table integrity). |
| **CI/CD** | | |
| Docker agent setup (if not present) | 1-2h | Ensure testcontainers can spawn containers in CI. May already be present. |
| **Total (excluding P0-9)** | **10-15h** | ~2 developer-days. |
| **Total (including P0-9)** | **3-4 days** | Includes P0-9 scope close + test infrastructure + T4 suite. |

**Critical path:** P0-9 fix must land FIRST. Once anonymizeCustomer is scope-complete, T4 infrastructure is straightforward.

---

## 11. Hard stops and prerequisites

### Hard stop: P0-9 MUST be closed before T4 begins

**Evidence:** anonymizeCustomer currently leaves PII in:
- OrderProjection ({customerEmail, customerName, customerPhone, shippingAddressJson})
- ConversationMessage.content
- Conversation.customerId
- OrderStatusHistory.actorId
- OrderEventLog.payload
- LoyaltyAccount
- Reservation.specialRequests
- **Medusa-side customer row**

**Impact:** T4 cannot test what isn't fixed. Current test (`anonymize-customer.test.ts`) has partial coverage and uses mocks; T4 needs real DB to catch these gaps.

### Hard stop: Real Postgres testcontainer requires Docker in CI

**Check:** Verify CI agent has Docker socket available (same as Redis testcontainer).

If not:
- Add `IBX_SKIP_REAL_POSTGRES=1` skip flag (for local dev)
- Ensure CI pipeline forces real containers (fail-closed)

### Hard stop: Medusa cross-DB transaction

**Finding:** Prisma `$transaction` does NOT span databases. If P0-9 fix includes Medusa-side customer scrub, that must be a separate transaction or a compensation pattern (e.g., publish "customer.anonymized" event → Medusa consumer deletes the row).

**Recommendation:** defer Medusa scrub to a follow-up task (P0-9b). Mark H3-T4 scope as "domain DB only" until cross-DB pattern is established.

---

## 12. Verification checklist

- [x] Redis testcontainer pattern exists and is proven (T6, R2-2)
- [x] Postgres testcontainer pattern is straightforward (no blockers)
- [x] Fixture builder shape is clear (spec → multiple inserts)
- [x] Isolation model (per-test truncate) is sound
- [x] P0-9 is identified as prerequisite blocker
- [x] Medusa cross-DB concern is documented and deferred
- [x] Effort estimate is realistic (10-15h excluding P0-9; 3-4 days including)

---

## Summary for H3 kickoff

**One-paragraph TL;DR:**  
H3-T4 conformance suite requires a real Postgres testcontainer (paralleling the existing Redis pattern), a declarative PII fixture builder, and per-test DB truncation isolation. The main blocker is **P0-9 (incomplete anonymizeCustomer scope)**, which must be fixed first—current anonymizeCustomer leaves PII in 8 tables including OrderProjection, ConversationMessage, and LoyaltyAccount. Once P0-9 is closed, T4 is straightforward: ~10-15h for infrastructure + fixtures + test suite.

**Recommended fixture-builder shape:**  
```typescript
interface PIIFixtureSpec {
  customerId, phone, email, name, cpf
  addresses?, reviews?, reservations?, orderItems?, preferences?, conversation?, loyaltyAccount?
}
async buildPIIFixture(prisma, spec): { customerId, fixtures }
```

**Estimated T4 effort (post-P0-9):** 2 developer-days (10-15h).

---

**Report prepared:** 2026-05-24  
**Codebase:** ibatexas @ `feat/kernel-always-on-cutover`  
**READ-ONLY:** no files created, no commits, no modifications
