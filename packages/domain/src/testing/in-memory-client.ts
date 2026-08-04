// @ibatexas/domain/testing — the canonical in-memory prisma-shaped client.
//
// ── What this is ──────────────────────────────────────────────────────────────
//
// A row store with Prisma's QUERY semantics, published as part of this package's
// test surface so every consumer shares ONE double instead of hand-rolling a
// `vi.fn()` per delegate per test file. Pass it where a service takes a client:
//
//     const db = createInMemoryDomainClient({ seed: { customer: [{ id: "c1", phone: "+5511…" }] } })
//     const svc = createCustomerService({ client: db.client })
//     await svc.updateProfile("c1", { name: "Ana" })
//     expect(db.rows("customer")[0]!.name).toBe("Ana")
//
// R5-S1 scope: the five model delegates `createCustomerService` reads and writes
// (`customer`, `customerPreferences`, `customerOrderItem`, `review`, `address`)
// plus the array form of `$transaction`. Later slices extend `MODELS` — they do
// not fork this file.
//
// ── Never benign-empty ────────────────────────────────────────────────────────
//
// Everything unimplemented THROWS `UnroutedDomainClientCall`, naming the exact
// path that was reached. That covers an unknown model (`client.orderProjection`),
// an unknown delegate method (`review.updateMany`), an unsupported `where`
// operator, an unsupported argument, a `where` that is not a declared unique on
// a unique-only method, and a column absent from the model's declared schema. A
// double that answers `undefined` or `[]` to a call it cannot honour makes a
// test pass for the wrong reason; this one fails loudly instead.
//
// Two behaviours mirror real Prisma failures rather than inventing softer ones:
// `update` against a missing row and `findUniqueOrThrow` against a missing row
// both throw `InMemoryRecordNotFound` (real Prisma: P2025).
//
// ── Explicitly NOT emulated (W4 RULE 3) ───────────────────────────────────────
//
//   • `$queryRaw` / `$executeRaw` — raw SQL. There is no honest in-memory
//     execution of a SQL string, so it throws instead of returning a plausible
//     shape. A test needing `findDormantCustomers` belongs on a real database.
//   • Interactive `$transaction(async (tx) => …)` — no rollback, no isolation.
//     The array form is supported because it is only a batched read here.
//   • Redis, Lua/EVAL, and any atomicity policy. That contract belongs to the
//     redis testcontainer harness; this adapter is prisma-shaped only.
//   • Referential integrity, cascades, and constraint enforcement. Seeding an
//     orphan row is the seeder's business.

import type { CustomerServiceClient } from "../services/customer.service.js"

// ── Errors ───────────────────────────────────────────────────────────────────

/**
 * Thrown when a call reaches a path this adapter does not implement. The
 * message names the path so the failure reads as "extend the adapter" rather
 * than "the code under test is broken".
 */
export class UnroutedDomainClientCall extends Error {
  constructor(path: string, detail?: string) {
    super(
      `[in-memory-client] unrouted call: ${path}` +
        (detail ? ` — ${detail}` : "") +
        ". This adapter throws rather than answering with undefined/[]; add the" +
        " missing support to packages/domain/src/testing/in-memory-client.ts.",
    )
    this.name = "UnroutedDomainClientCall"
  }
}

/** Stands in for Prisma's P2025 (`RecordNotFound`) on update / findUniqueOrThrow. */
export class InMemoryRecordNotFound extends Error {
  constructor(model: string, where: unknown) {
    super(
      `[in-memory-client] no ${model} row matches ${JSON.stringify(where)}` +
        " (real Prisma raises P2025 here)",
    )
    this.name = "InMemoryRecordNotFound"
  }
}

// ── Declared schema ──────────────────────────────────────────────────────────
//
// Mirrors packages/domain/prisma/schema.prisma for the models in scope. It
// exists so a create can fill the same defaults the database would (nullable →
// null, list → [], `@default(now())`, `@updatedAt`) and so a write naming a
// column the model does not have fails loudly instead of storing a typo.

interface ColumnSpec {
  /** `@id @default(cuid())` — filled with a synthetic id when omitted. */
  readonly generatedId?: boolean
  /** Nullable scalar — filled with `null` when omitted on create. */
  readonly nullable?: boolean
  /** List column — filled with `[]` when omitted on create. */
  readonly list?: boolean
  /** `@default(now())` — stamped on create. */
  readonly defaultNow?: boolean
  /** `@updatedAt` — stamped on create AND on every update. */
  readonly updatedAt?: boolean
  /** Literal `@default(...)`. */
  readonly literalDefault?: unknown
}

/** Models this adapter can serve. Anything else throws on property access. */
export type ModelName =
  | "customer"
  | "customerPreferences"
  | "customerOrderItem"
  | "review"
  | "address"

interface RelationSpec {
  readonly model: ModelName
  /** Row field on THIS model that the related rows point at. */
  readonly localField: string
  /** Field on the RELATED model holding the pointer. */
  readonly foreignField: string
  readonly cardinality: "one" | "many"
}

interface ModelSpec {
  readonly columns: Readonly<Record<string, ColumnSpec>>
  /** Single-column uniques (`@id` / `@unique`). */
  readonly uniques: readonly string[]
  /**
   * `@@unique([a, b])` compound keys, addressed the way Prisma names them:
   * `where: { orderId_customerId: { orderId, customerId } }`.
   */
  readonly compoundUniques?: Readonly<Record<string, readonly string[]>>
  readonly relations?: Readonly<Record<string, RelationSpec>>
}

const MODELS: Readonly<Record<ModelName, ModelSpec>> = {
  customer: {
    columns: {
      id: { generatedId: true },
      phone: {},
      name: { nullable: true },
      email: { nullable: true },
      cpf: { nullable: true },
      medusaId: { nullable: true },
      source: { nullable: true },
      firstContactAt: { nullable: true },
      createdAt: { defaultNow: true },
      updatedAt: { updatedAt: true },
    },
    uniques: ["id", "phone", "medusaId"],
    relations: {
      preferences: {
        model: "customerPreferences",
        localField: "id",
        foreignField: "customerId",
        cardinality: "one",
      },
    },
  },
  customerPreferences: {
    columns: {
      id: { generatedId: true },
      customerId: {},
      dietaryRestrictions: { list: true },
      allergenExclusions: { list: true },
      favoriteCategories: { list: true },
      updatedAt: { updatedAt: true },
    },
    uniques: ["id", "customerId"],
  },
  customerOrderItem: {
    columns: {
      id: { generatedId: true },
      customerId: { nullable: true },
      medusaOrderId: {},
      productId: {},
      variantId: {},
      quantity: {},
      priceInCentavos: {},
      orderedAt: {},
    },
    uniques: ["id"],
  },
  review: {
    columns: {
      id: { generatedId: true },
      orderId: {},
      productIds: { list: true },
      productId: { nullable: true },
      customerId: {},
      rating: {},
      comment: { nullable: true },
      channel: {},
      createdAt: { defaultNow: true },
      updatedAt: { updatedAt: true },
    },
    uniques: ["id"],
    compoundUniques: { orderId_customerId: ["orderId", "customerId"] },
  },
  address: {
    columns: {
      id: { generatedId: true },
      customerId: {},
      street: {},
      number: {},
      complement: { nullable: true },
      district: {},
      city: {},
      state: {},
      cep: {},
      isDefault: { literalDefault: false },
    },
    uniques: ["id"],
  },
}

const MODEL_NAMES = Object.keys(MODELS) as readonly ModelName[]

// ── Rows ─────────────────────────────────────────────────────────────────────

export type Row = Record<string, unknown>

/**
 * Property names that must answer `undefined` instead of throwing: awaiting or
 * inspecting the client would otherwise explode on the thenable/inspection
 * probe rather than on the call the test actually made.
 */
const PASSTHROUGH_PROPS: ReadonlySet<string> = new Set([
  "then",
  "catch",
  "finally",
  "constructor",
  "toJSON",
  "inspect",
  "nodeType",
  "$$typeof",
])

// ── Query core ───────────────────────────────────────────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Date)
  )
}

function sameScalar(left: unknown, right: unknown): boolean {
  if (left instanceof Date && right instanceof Date) {
    return left.getTime() === right.getTime()
  }
  return left === right
}

// ── Validation ───────────────────────────────────────────────────────────────
//
// Every argument is validated BEFORE any row is touched, for the reason the R5
// review keeps running into: a check that only fires while iterating rows is
// vacuous on an empty store. An unsupported operator would then silently WIDEN
// the query to "match everything" and the test would pass on `[]`. Validation
// is also where real Prisma rejects a bad query — ahead of execution, and
// regardless of what the table holds.

const SUPPORTED_FILTER_OPERATORS: ReadonlySet<string> = new Set([
  "equals",
  "in",
  "not",
  "gt",
  "gte",
  "lt",
  "lte",
  "contains",
  "mode",
])

function validateFilter(path: string, filter: unknown): void {
  if (!isPlainObject(filter)) return
  for (const [key, operand] of Object.entries(filter)) {
    if (!SUPPORTED_FILTER_OPERATORS.has(key)) {
      throw new UnroutedDomainClientCall(
        `${path}.${key}`,
        "unsupported filter operator",
      )
    }
    if (key === "in" && !Array.isArray(operand)) {
      throw new UnroutedDomainClientCall(`${path}.in`, "expects an array")
    }
    if (key === "mode" && operand !== "insensitive" && operand !== "default") {
      throw new UnroutedDomainClientCall(`${path}.mode`, String(operand))
    }
  }
}

function validateWhere(
  model: ModelName,
  where: Row | undefined,
  path: string,
): void {
  if (where === undefined) return
  if (!isPlainObject(where)) {
    throw new UnroutedDomainClientCall(path, "expects an object")
  }
  const spec = MODELS[model]
  for (const [key, condition] of Object.entries(where)) {
    if (key === "OR") {
      if (!Array.isArray(condition)) {
        throw new UnroutedDomainClientCall(`${path}.OR`, "expects an array")
      }
      for (const branch of condition) {
        validateWhere(model, branch as Row, `${path}.OR`)
      }
      continue
    }
    if (key === "AND" || key === "NOT") {
      throw new UnroutedDomainClientCall(`${path}.${key}`)
    }
    const compound = spec.compoundUniques?.[key]
    if (compound) {
      if (!isPlainObject(condition)) {
        throw new UnroutedDomainClientCall(
          `${path}.${key}`,
          "compound unique expects an object of its fields",
        )
      }
      for (const field of compound) {
        validateFilter(`${path}.${key}.${field}`, condition[field])
      }
      continue
    }
    if (!(key in spec.columns)) {
      throw new UnroutedDomainClientCall(
        `${model}.where.${key}`,
        "no such column in the declared schema",
      )
    }
    validateFilter(`${path}.${key}`, condition)
  }
}

function validateSelect(model: ModelName, select: unknown): void {
  if (!isPlainObject(select)) {
    throw new UnroutedDomainClientCall(`${model}.select`, "expects an object")
  }
  for (const [field, flag] of Object.entries(select)) {
    if (flag !== true) {
      throw new UnroutedDomainClientCall(
        `${model}.select.${field}`,
        "only `true` is supported (no nested select)",
      )
    }
    if (!(field in MODELS[model].columns)) {
      throw new UnroutedDomainClientCall(`${model}.select.${field}`)
    }
  }
}

function validateInclude(model: ModelName, include: unknown): void {
  if (!isPlainObject(include)) {
    throw new UnroutedDomainClientCall(`${model}.include`, "expects an object")
  }
  for (const [name, flag] of Object.entries(include)) {
    if (flag !== true) {
      throw new UnroutedDomainClientCall(
        `${model}.include.${name}`,
        "only `true` is supported (no nested include/select)",
      )
    }
    if (!MODELS[model].relations?.[name]) {
      throw new UnroutedDomainClientCall(`${model}.include.${name}`)
    }
  }
}

function validateDistinct(model: ModelName, fields: unknown): void {
  if (!Array.isArray(fields)) {
    throw new UnroutedDomainClientCall(`${model}.distinct`, "expects an array")
  }
  for (const field of fields as readonly unknown[]) {
    if (typeof field !== "string" || !(field in MODELS[model].columns)) {
      throw new UnroutedDomainClientCall(`${model}.distinct.${String(field)}`)
    }
  }
}

/** Validate every read-shaping argument this adapter understands, up front. */
function validateReadArgs(model: ModelName, args: Row): void {
  validateWhere(model, args["where"] as Row | undefined, `${model}.where`)
  if (args["select"] !== undefined && args["include"] !== undefined) {
    throw new UnroutedDomainClientCall(
      model,
      "select and include cannot both be set",
    )
  }
  if (args["select"] !== undefined) validateSelect(model, args["select"])
  if (args["include"] !== undefined) validateInclude(model, args["include"])
  if (args["distinct"] !== undefined) validateDistinct(model, args["distinct"])
}

/**
 * Validate a write payload against the declared columns. Runs BEFORE the row
 * lookup so a typo'd column fails on its own terms rather than being masked by
 * a P2025 from a store that happens to be empty.
 */
function validateWriteData(
  model: ModelName,
  method: string,
  data: unknown,
): void {
  if (!isPlainObject(data)) {
    throw new UnroutedDomainClientCall(
      `${model}.${method}.data`,
      "expects an object",
    )
  }
  for (const [key, value] of Object.entries(data)) {
    if (!(key in MODELS[model].columns)) {
      throw new UnroutedDomainClientCall(
        `${model}.${method}.data.${key}`,
        "no such column in the declared schema",
      )
    }
    if (isPlainObject(value)) {
      throw new UnroutedDomainClientCall(
        `${model}.${method}.data.${key}`,
        "atomic write operations (increment/set/push/…) are not implemented",
      )
    }
  }
}

/**
 * Prisma filter subset. Every operator is spelled out; an unrecognised one
 * throws rather than being ignored (an ignored filter silently WIDENS a query,
 * which is how a fake makes an over-broad read look correct).
 */
function matchesFilter(
  path: string,
  actual: unknown,
  filter: unknown,
): boolean {
  if (!isPlainObject(filter)) return sameScalar(actual, filter)

  const keys = Object.keys(filter)
  if (keys.length === 0) return true

  return keys.every((key) => {
    const operand = filter[key]
    switch (key) {
      case "equals":
        return sameScalar(actual, operand)
      case "in":
        if (!Array.isArray(operand)) {
          throw new UnroutedDomainClientCall(path, "`in` expects an array")
        }
        return operand.some((candidate) => sameScalar(actual, candidate))
      case "not":
        // SQL semantics, matching how Prisma compiles this: `not: null` is
        // IS NOT NULL, and `not: <value>` on a NULL column is NOT true.
        if (actual === null || actual === undefined) return false
        return operand === null ? true : !sameScalar(actual, operand)
      case "gt":
        return compareValues(actual, operand) > 0
      case "gte":
        return compareValues(actual, operand) >= 0
      case "lt":
        return compareValues(actual, operand) < 0
      case "lte":
        return compareValues(actual, operand) <= 0
      case "contains": {
        if (typeof actual !== "string" || typeof operand !== "string") {
          return false
        }
        const insensitive = filter["mode"] === "insensitive"
        return insensitive
          ? actual.toLowerCase().includes(operand.toLowerCase())
          : actual.includes(operand)
      }
      case "mode":
        // Consumed by `contains` above.
        if (operand !== "insensitive" && operand !== "default") {
          throw new UnroutedDomainClientCall(path, `mode: ${String(operand)}`)
        }
        return true
      default:
        throw new UnroutedDomainClientCall(
          `${path}.${key}`,
          "unsupported filter operator",
        )
    }
  })
}

function matchesWhere(
  model: ModelName,
  row: Row,
  where: Row | undefined,
  path: string,
): boolean {
  if (!where) return true
  const spec = MODELS[model]
  return Object.entries(where).every(([key, condition]) => {
    if (key === "OR") {
      if (!Array.isArray(condition)) {
        throw new UnroutedDomainClientCall(`${path}.OR`, "expects an array")
      }
      return condition.some((branch) =>
        matchesWhere(model, row, branch as Row, `${path}.OR`),
      )
    }
    if (key === "AND" || key === "NOT") {
      throw new UnroutedDomainClientCall(`${path}.${key}`)
    }
    const compound = spec.compoundUniques?.[key]
    if (compound) {
      if (!isPlainObject(condition)) {
        throw new UnroutedDomainClientCall(
          `${path}.${key}`,
          "compound unique expects an object of its fields",
        )
      }
      return compound.every((field) =>
        matchesFilter(`${path}.${key}.${field}`, row[field], condition[field]),
      )
    }
    if (!(key in spec.columns)) {
      throw new UnroutedDomainClientCall(
        `${model}.where.${key}`,
        "no such column in the declared schema",
      )
    }
    return matchesFilter(`${path}.${key}`, row[key], condition)
  })
}

/**
 * Comparator with Postgres ordering semantics for NULLs (last on ASC, first on
 * DESC — the caller flips the sign, so nulls sort high here).
 */
function compareValues(left: unknown, right: unknown): number {
  const leftNull = left === null || left === undefined
  const rightNull = right === null || right === undefined
  if (leftNull || rightNull) {
    if (leftNull && rightNull) return 0
    return leftNull ? 1 : -1
  }
  const a = left instanceof Date ? left.getTime() : left
  const b = right instanceof Date ? right.getTime() : right
  if (typeof a === "string" && typeof b === "string") return a.localeCompare(b)
  if (typeof a === "boolean" && typeof b === "boolean") {
    return Number(a) - Number(b)
  }
  if (typeof a === "number" && typeof b === "number") return a - b
  throw new UnroutedDomainClientCall(
    "orderBy",
    `cannot compare ${typeof a} with ${typeof b}`,
  )
}

type OrderByArg = Row | readonly Row[]

function applyOrderBy(model: ModelName, rows: Row[], orderBy: OrderByArg): Row[] {
  const terms = Array.isArray(orderBy) ? [...orderBy] : [orderBy as Row]
  for (const term of terms) {
    const entries = Object.entries(term)
    if (entries.length !== 1) {
      throw new UnroutedDomainClientCall(
        `${model}.orderBy`,
        "each term must name exactly one field",
      )
    }
    const [field, direction] = entries[0]!
    if (!(field in MODELS[model].columns)) {
      throw new UnroutedDomainClientCall(`${model}.orderBy.${field}`)
    }
    if (direction !== "asc" && direction !== "desc") {
      throw new UnroutedDomainClientCall(
        `${model}.orderBy.${field}`,
        `direction ${JSON.stringify(direction)}`,
      )
    }
  }
  // Stable multi-key sort: later terms break ties left by earlier ones, so we
  // walk the terms in reverse and rely on Array#sort being stable.
  const sorted = [...rows]
  for (const term of [...terms].reverse()) {
    const [field, direction] = Object.entries(term)[0]!
    const sign = direction === "desc" ? -1 : 1
    sorted.sort((a, b) => sign * compareValues(a[field], b[field]))
  }
  return sorted
}

function applyDistinct(model: ModelName, rows: Row[], fields: unknown): Row[] {
  if (!Array.isArray(fields)) {
    throw new UnroutedDomainClientCall(`${model}.distinct`, "expects an array")
  }
  const seen = new Set<string>()
  const kept: Row[] = []
  for (const row of rows) {
    const key = JSON.stringify(
      fields.map((field: unknown) => {
        if (typeof field !== "string" || !(field in MODELS[model].columns)) {
          throw new UnroutedDomainClientCall(
            `${model}.distinct.${String(field)}`,
          )
        }
        return row[field] ?? null
      }),
    )
    if (seen.has(key)) continue
    seen.add(key)
    kept.push(row)
  }
  return kept
}

function applySelect(model: ModelName, row: Row, select: Row): Row {
  const out: Row = {}
  for (const [field, flag] of Object.entries(select)) {
    if (flag !== true) {
      throw new UnroutedDomainClientCall(
        `${model}.select.${field}`,
        "only `true` is supported (no nested select)",
      )
    }
    if (!(field in MODELS[model].columns)) {
      throw new UnroutedDomainClientCall(`${model}.select.${field}`)
    }
    out[field] = row[field]
  }
  return out
}

// ── Delegate ─────────────────────────────────────────────────────────────────

interface Store {
  readonly rows: Map<ModelName, Row[]>
  readonly now: () => Date
  nextId: number
}

function knownArgs(
  model: ModelName,
  method: string,
  args: Row,
  allowed: readonly string[],
): void {
  for (const key of Object.keys(args)) {
    if (!allowed.includes(key)) {
      throw new UnroutedDomainClientCall(
        `${model}.${method}({ ${key} })`,
        "unsupported argument",
      )
    }
  }
}

/**
 * Reject a `where` that is not addressed by a declared unique. Prisma's
 * unique-only methods (`findUnique`, `update`, `upsert`, …) require one, and a
 * double that quietly accepts a non-unique filter here would let a test assert
 * a single-row read that the database would refuse to compile.
 */
function assertUniqueWhere(model: ModelName, method: string, where: Row): void {
  const spec = MODELS[model]
  const keys = Object.keys(where)
  if (keys.length !== 1) {
    throw new UnroutedDomainClientCall(
      `${model}.${method}`,
      `where must name exactly one unique, got [${keys.join(", ")}]`,
    )
  }
  const key = keys[0]!
  if (spec.uniques.includes(key)) return
  if (spec.compoundUniques && key in spec.compoundUniques) return
  throw new UnroutedDomainClientCall(
    `${model}.${method}`,
    `where.${key} is not a declared unique on ${model}`,
  )
}

function applyCreateDefaults(store: Store, model: ModelName, data: Row): Row {
  const spec = MODELS[model]
  for (const key of Object.keys(data)) {
    if (!(key in spec.columns)) {
      throw new UnroutedDomainClientCall(
        `${model}.create.data.${key}`,
        "no such column in the declared schema",
      )
    }
  }
  const row: Row = {}
  for (const [column, columnSpec] of Object.entries(spec.columns)) {
    if (column in data) {
      row[column] = data[column]
      continue
    }
    if (columnSpec.generatedId) {
      // Deliberately NOT cuid-shaped: a test that depends on the real id format
      // should fail here rather than read as production-faithful.
      store.nextId += 1
      row[column] = `${model}_${store.nextId}`
    } else if (columnSpec.defaultNow || columnSpec.updatedAt) {
      row[column] = store.now()
    } else if (columnSpec.list) {
      row[column] = []
    } else if ("literalDefault" in columnSpec) {
      row[column] = columnSpec.literalDefault
    } else if (columnSpec.nullable) {
      row[column] = null
    } else {
      throw new UnroutedDomainClientCall(
        `${model}.create.data.${column}`,
        "required column has no value and no schema default",
      )
    }
  }
  return row
}

function applyUpdateData(store: Store, model: ModelName, row: Row, data: Row): void {
  const spec = MODELS[model]
  for (const [key, value] of Object.entries(data)) {
    if (!(key in spec.columns)) {
      throw new UnroutedDomainClientCall(
        `${model}.update.data.${key}`,
        "no such column in the declared schema",
      )
    }
    if (isPlainObject(value)) {
      throw new UnroutedDomainClientCall(
        `${model}.update.data.${key}`,
        "atomic update operations (increment/set/push/…) are not implemented",
      )
    }
    row[key] = value
  }
  for (const [column, columnSpec] of Object.entries(spec.columns)) {
    if (columnSpec.updatedAt) row[column] = store.now()
  }
}

function resolveInclude(store: Store, model: ModelName, row: Row, include: Row): Row {
  const spec = MODELS[model]
  const out: Row = { ...row }
  for (const [name, flag] of Object.entries(include)) {
    if (flag !== true) {
      throw new UnroutedDomainClientCall(
        `${model}.include.${name}`,
        "only `true` is supported (no nested include/select)",
      )
    }
    const relation = spec.relations?.[name]
    if (!relation) {
      throw new UnroutedDomainClientCall(`${model}.include.${name}`)
    }
    const related = (store.rows.get(relation.model) ?? []).filter((candidate) =>
      sameScalar(candidate[relation.foreignField], row[relation.localField]),
    )
    out[name] =
      relation.cardinality === "one"
        ? (related[0] ?? null)
        : related.map((r) => ({ ...r }))
  }
  return out
}

function shapeRow(
  store: Store,
  model: ModelName,
  row: Row,
  args: Row,
): Row {
  if (args["select"] !== undefined && args["include"] !== undefined) {
    throw new UnroutedDomainClientCall(
      `${model}`,
      "select and include cannot both be set",
    )
  }
  if (args["select"] !== undefined) {
    return applySelect(model, row, args["select"] as Row)
  }
  if (args["include"] !== undefined) {
    return resolveInclude(store, model, row, args["include"] as Row)
  }
  return { ...row }
}

function readMany(store: Store, model: ModelName, args: Row): Row[] {
  const all = store.rows.get(model) ?? []
  let rows = all.filter((row) =>
    matchesWhere(model, row, args["where"] as Row | undefined, `${model}.where`),
  )
  if (args["orderBy"] !== undefined) {
    rows = applyOrderBy(model, rows, args["orderBy"] as OrderByArg)
  }
  if (args["distinct"] !== undefined) {
    rows = applyDistinct(model, rows, args["distinct"])
  }
  const skip = args["skip"]
  if (skip !== undefined) {
    if (typeof skip !== "number") {
      throw new UnroutedDomainClientCall(`${model}.skip`, "expects a number")
    }
    rows = rows.slice(skip)
  }
  const take = args["take"]
  if (take !== undefined) {
    if (typeof take !== "number" || take < 0) {
      throw new UnroutedDomainClientCall(
        `${model}.take`,
        "expects a non-negative number (negative take is not implemented)",
      )
    }
    rows = rows.slice(0, take)
  }
  return rows
}

function findUniqueRow(
  store: Store,
  model: ModelName,
  method: string,
  where: Row,
): Row | undefined {
  assertUniqueWhere(model, method, where)
  return (store.rows.get(model) ?? []).find((row) =>
    matchesWhere(model, row, where, `${model}.where`),
  )
}

function buildDelegate(store: Store, model: ModelName): Record<string, unknown> {
  const methods: Record<string, (args?: Row) => Promise<unknown>> = {
    async findUnique(args = {}) {
      knownArgs(model, "findUnique", args, ["where", "select", "include"])
      validateReadArgs(model, args)
      const row = findUniqueRow(store, model, "findUnique", args["where"] as Row)
      return row ? shapeRow(store, model, row, args) : null
    },

    async findUniqueOrThrow(args = {}) {
      knownArgs(model, "findUniqueOrThrow", args, ["where", "select", "include"])
      validateReadArgs(model, args)
      const where = args["where"] as Row
      const row = findUniqueRow(store, model, "findUniqueOrThrow", where)
      if (!row) throw new InMemoryRecordNotFound(model, where)
      return shapeRow(store, model, row, args)
    },

    async findMany(args = {}) {
      knownArgs(model, "findMany", args, [
        "where",
        "orderBy",
        "select",
        "include",
        "take",
        "skip",
        "distinct",
      ])
      validateReadArgs(model, args)
      return readMany(store, model, args).map((row) =>
        shapeRow(store, model, row, args),
      )
    },

    async count(args = {}) {
      knownArgs(model, "count", args, ["where"])
      validateWhere(model, args["where"] as Row | undefined, `${model}.where`)
      const all = store.rows.get(model) ?? []
      return all.filter((row) =>
        matchesWhere(
          model,
          row,
          args["where"] as Row | undefined,
          `${model}.where`,
        ),
      ).length
    },

    async create(args = {}) {
      knownArgs(model, "create", args, ["data", "select", "include"])
      validateWriteData(model, "create", args["data"])
      validateReadArgs(model, args)
      const row = applyCreateDefaults(store, model, args["data"] as Row)
      store.rows.get(model)!.push(row)
      return shapeRow(store, model, row, args)
    },

    async createMany(args = {}) {
      knownArgs(model, "createMany", args, ["data", "skipDuplicates"])
      if (args["skipDuplicates"] === true) {
        throw new UnroutedDomainClientCall(
          `${model}.createMany({ skipDuplicates: true })`,
          "this adapter enforces no uniqueness, so it cannot honour skipDuplicates",
        )
      }
      const data = args["data"]
      if (!Array.isArray(data)) {
        throw new UnroutedDomainClientCall(
          `${model}.createMany.data`,
          "expects an array (single-object form is not implemented)",
        )
      }
      for (const entry of data) {
        validateWriteData(model, "createMany", entry)
        store.rows.get(model)!.push(applyCreateDefaults(store, model, entry as Row))
      }
      return { count: data.length }
    },

    async update(args = {}) {
      knownArgs(model, "update", args, ["where", "data", "select", "include"])
      validateWriteData(model, "update", args["data"])
      validateReadArgs(model, args)
      const where = args["where"] as Row
      const row = findUniqueRow(store, model, "update", where)
      if (!row) throw new InMemoryRecordNotFound(model, where)
      applyUpdateData(store, model, row, args["data"] as Row)
      return shapeRow(store, model, row, args)
    },

    async upsert(args = {}) {
      knownArgs(model, "upsert", args, [
        "where",
        "create",
        "update",
        "select",
        "include",
      ])
      validateWriteData(model, "upsert.create", args["create"])
      validateWriteData(model, "upsert.update", args["update"])
      validateReadArgs(model, args)
      const where = args["where"] as Row
      const existing = findUniqueRow(store, model, "upsert", where)
      if (existing) {
        applyUpdateData(store, model, existing, args["update"] as Row)
        return shapeRow(store, model, existing, args)
      }
      const row = applyCreateDefaults(store, model, args["create"] as Row)
      store.rows.get(model)!.push(row)
      return shapeRow(store, model, row, args)
    },

    async deleteMany(args = {}) {
      knownArgs(model, "deleteMany", args, ["where"])
      validateWhere(model, args["where"] as Row | undefined, `${model}.where`)
      const all = store.rows.get(model)!
      const kept = all.filter(
        (row) =>
          !matchesWhere(
            model,
            row,
            args["where"] as Row | undefined,
            `${model}.where`,
          ),
      )
      const removed = all.length - kept.length
      all.length = 0
      all.push(...kept)
      return { count: removed }
    },

    async aggregate(args = {}) {
      knownArgs(model, "aggregate", args, ["where", "_avg", "_count", "_sum"])
      validateWhere(model, args["where"] as Row | undefined, `${model}.where`)
      const rows = (store.rows.get(model) ?? []).filter((row) =>
        matchesWhere(
          model,
          row,
          args["where"] as Row | undefined,
          `${model}.where`,
        ),
      )
      const out: Row = {}
      for (const aggregateKey of ["_avg", "_count", "_sum"] as const) {
        const fields = args[aggregateKey]
        if (fields === undefined) continue
        if (!isPlainObject(fields)) {
          throw new UnroutedDomainClientCall(
            `${model}.aggregate.${aggregateKey}`,
            "expects an object of field flags",
          )
        }
        const bucket: Row = {}
        for (const [field, flag] of Object.entries(fields)) {
          if (flag !== true || !(field in MODELS[model].columns)) {
            throw new UnroutedDomainClientCall(
              `${model}.aggregate.${aggregateKey}.${field}`,
            )
          }
          const values = rows
            .map((row) => row[field])
            .filter((value): value is number => typeof value === "number")
          if (aggregateKey === "_count") {
            bucket[field] = values.length
          } else if (aggregateKey === "_sum") {
            // Prisma returns null for _sum over an empty set.
            bucket[field] = values.length
              ? values.reduce((sum, value) => sum + value, 0)
              : null
          } else {
            bucket[field] = values.length
              ? values.reduce((sum, value) => sum + value, 0) / values.length
              : null
          }
        }
        out[aggregateKey] = bucket
      }
      return out
    },

    async groupBy(args = {}) {
      knownArgs(model, "groupBy", args, ["by", "where", "_count", "orderBy", "take"])
      validateWhere(model, args["where"] as Row | undefined, `${model}.where`)
      const by = args["by"]
      if (!Array.isArray(by) || by.length === 0) {
        throw new UnroutedDomainClientCall(
          `${model}.groupBy.by`,
          "expects a non-empty array",
        )
      }
      for (const field of by) {
        if (typeof field !== "string" || !(field in MODELS[model].columns)) {
          throw new UnroutedDomainClientCall(
            `${model}.groupBy.by.${String(field)}`,
          )
        }
      }
      const countFields = args["_count"]
      if (countFields !== undefined) {
        if (!isPlainObject(countFields)) {
          throw new UnroutedDomainClientCall(`${model}.groupBy._count`)
        }
        // Validated here, not inside the per-bucket loop: an empty store
        // produces no buckets, so a loop-local check would never run.
        for (const [field, flag] of Object.entries(countFields)) {
          if (flag !== true || !(field in MODELS[model].columns)) {
            throw new UnroutedDomainClientCall(`${model}.groupBy._count.${field}`)
          }
        }
      }
      const rows = (store.rows.get(model) ?? []).filter((row) =>
        matchesWhere(
          model,
          row,
          args["where"] as Row | undefined,
          `${model}.where`,
        ),
      )
      const buckets = new Map<string, { key: Row; members: Row[] }>()
      for (const row of rows) {
        const key: Row = {}
        for (const field of by as string[]) key[field] = row[field]
        const hash = JSON.stringify(by.map((field) => row[field as string] ?? null))
        const bucket = buckets.get(hash) ?? { key, members: [] }
        bucket.members.push(row)
        buckets.set(hash, bucket)
      }
      let grouped: Row[] = [...buckets.values()].map(({ key, members }) => {
        const entry: Row = { ...key }
        if (isPlainObject(countFields)) {
          const counts: Row = {}
          for (const [field, flag] of Object.entries(countFields)) {
            if (flag !== true || !(field in MODELS[model].columns)) {
              throw new UnroutedDomainClientCall(
                `${model}.groupBy._count.${field}`,
              )
            }
            counts[field] = members.filter(
              (member) => member[field] !== null && member[field] !== undefined,
            ).length
          }
          entry["_count"] = counts
        }
        return entry
      })

      const orderBy = args["orderBy"]
      if (orderBy !== undefined) {
        if (!isPlainObject(orderBy)) {
          throw new UnroutedDomainClientCall(
            `${model}.groupBy.orderBy`,
            "expects a single object",
          )
        }
        const entries = Object.entries(orderBy)
        if (entries.length !== 1) {
          throw new UnroutedDomainClientCall(
            `${model}.groupBy.orderBy`,
            "expects exactly one term",
          )
        }
        const [outerKey, outerValue] = entries[0]!
        if (outerKey !== "_count" || !isPlainObject(outerValue)) {
          throw new UnroutedDomainClientCall(
            `${model}.groupBy.orderBy.${outerKey}`,
            "only `_count` ordering is implemented",
          )
        }
        const innerEntries = Object.entries(outerValue)
        if (innerEntries.length !== 1) {
          throw new UnroutedDomainClientCall(
            `${model}.groupBy.orderBy._count`,
            "expects exactly one field",
          )
        }
        const [field, direction] = innerEntries[0]!
        if (direction !== "asc" && direction !== "desc") {
          throw new UnroutedDomainClientCall(
            `${model}.groupBy.orderBy._count.${field}`,
            `direction ${JSON.stringify(direction)}`,
          )
        }
        const sign = direction === "desc" ? -1 : 1
        grouped = [...grouped].sort((a, b) => {
          const left = (a["_count"] as Row | undefined)?.[field]
          const right = (b["_count"] as Row | undefined)?.[field]
          if (typeof left !== "number" || typeof right !== "number") {
            throw new UnroutedDomainClientCall(
              `${model}.groupBy.orderBy._count.${field}`,
              "field is not in the `_count` selection",
            )
          }
          return sign * (left - right)
        })
      }

      const take = args["take"]
      if (take !== undefined) {
        if (typeof take !== "number" || take < 0) {
          throw new UnroutedDomainClientCall(`${model}.groupBy.take`)
        }
        grouped = grouped.slice(0, take)
      }
      return grouped
    },
  }

  return new Proxy(methods, {
    get(target, prop) {
      if (typeof prop === "symbol") return undefined
      if (prop in target) return target[prop]
      if (PASSTHROUGH_PROPS.has(prop)) return undefined
      throw new UnroutedDomainClientCall(`${model}.${prop}`)
    },
  })
}

// ── Public surface ───────────────────────────────────────────────────────────

export interface InMemoryDomainClientOptions {
  /** Clock for `@default(now())` / `@updatedAt`. Defaults to `() => new Date()`. */
  readonly now?: () => Date
  /** Rows to load up front. Schema defaults are filled exactly as on `create`. */
  readonly seed?: Partial<Record<ModelName, readonly Row[]>>
}

export interface InMemoryDomainClient {
  /**
   * The prisma-shaped facade. Pass as `createCustomerService({ client })`.
   */
  readonly client: CustomerServiceClient
  /** Snapshot of a model's rows (copies — mutating them does not write back). */
  rows(model: ModelName): readonly Row[]
  /** Append rows, filling declared schema defaults. Returns the stored rows. */
  seed(model: ModelName, rows: readonly Row[]): readonly Row[]
  /** Drop every row and restart id generation. */
  reset(): void
}

/**
 * Build an in-memory prisma-shaped client.
 *
 * The returned `client` is cast to `CustomerServiceClient` at this one
 * boundary. That cast is the whole point of the file: the service keeps the
 * exact generated Prisma argument types (so a wrong `where` still fails `tsc`),
 * and the double absorbs the impedance instead of the production type loosening
 * to meet it. The cast is safe in the direction that matters — every path the
 * service can reach is implemented above, and anything else throws.
 */
export function createInMemoryDomainClient(
  options?: InMemoryDomainClientOptions,
): InMemoryDomainClient {
  const store: Store = {
    rows: new Map(MODEL_NAMES.map((model) => [model, [] as Row[]])),
    now: options?.now ?? (() => new Date()),
    nextId: 0,
  }

  const delegates = new Map<ModelName, Record<string, unknown>>(
    MODEL_NAMES.map((model) => [model, buildDelegate(store, model)]),
  )

  // Every client call answers with a promise and every failure is a REJECTION,
  // matching real Prisma (which rejects validation errors rather than throwing
  // synchronously). Only property access on an unknown model/method throws
  // synchronously — there is no promise to reject at that point.
  const root: Record<string, unknown> = {
    async $transaction(operations: unknown) {
      if (typeof operations === "function") {
        throw new UnroutedDomainClientCall(
          "$transaction(callback)",
          "interactive transactions have no in-memory semantics (no rollback," +
            " no isolation); use the array form or a real database",
        )
      }
      if (!Array.isArray(operations)) {
        throw new UnroutedDomainClientCall("$transaction", "expects an array")
      }
      return Promise.all(operations as readonly Promise<unknown>[])
    },
    async $queryRaw() {
      throw new UnroutedDomainClientCall(
        "$queryRaw",
        "raw SQL cannot be executed in memory — there is no honest answer to" +
          " return, so this throws instead of inventing rows",
      )
    },
  }

  const client = new Proxy(root, {
    get(target, prop) {
      if (typeof prop === "symbol") return undefined
      const delegate = delegates.get(prop as ModelName)
      if (delegate) return delegate
      if (prop in target) return target[prop]
      if (PASSTHROUGH_PROPS.has(prop)) return undefined
      throw new UnroutedDomainClientCall(
        `client.${prop}`,
        `this adapter covers [${MODEL_NAMES.join(", ")}]`,
      )
    },
  }) as unknown as CustomerServiceClient

  function seed(model: ModelName, rows: readonly Row[]): readonly Row[] {
    if (!store.rows.has(model)) {
      throw new UnroutedDomainClientCall(`seed(${String(model)})`)
    }
    const stored = rows.map((row) => applyCreateDefaults(store, model, row))
    store.rows.get(model)!.push(...stored)
    return stored.map((row) => ({ ...row }))
  }

  for (const [model, rows] of Object.entries(options?.seed ?? {})) {
    seed(model as ModelName, rows as readonly Row[])
  }

  return {
    client,
    rows(model) {
      const rows = store.rows.get(model)
      if (!rows) throw new UnroutedDomainClientCall(`rows(${String(model)})`)
      return rows.map((row) => ({ ...row }))
    },
    seed,
    reset() {
      for (const rows of store.rows.values()) rows.length = 0
      store.nextId = 0
    },
  }
}
