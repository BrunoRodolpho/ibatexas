// Single source of truth for every Postgres table the `ibx db` lifecycle manages.
//
// One shared DATABASE_URL holds four logical layers; this registry lists each
// table exactly once so `db clean`, `db provision`, and `db status` never drift
// from the schema again. A drift-guard test (__tests__/db-tables.drift.test.ts)
// fails CI when a table is added to the Prisma schema or a SQL migration without
// being registered here — the root-cause fix for the original hardcoded list.
//
//   domain  — @ibatexas/domain Prisma models (this DB)
//   kernel  — @adjudicate/audit-postgres raw-SQL tables (same DB)
//   memory  — @claustrum/* raw-SQL tables (same DB)

/**
 * Prisma domain delegates in FK-safe (children → parents) deletion order.
 * Business + observability/projection data — wiped by a default `db clean`.
 * Names are Prisma client accessors (camelCase), used as `prisma[name]`.
 */
export const DOMAIN_DELETE_ORDER = [
  "reservationTable",
  "waitlist",
  "reservation",
  "review",
  "customerOrderItem",
  "address",
  "customerPreferences",
  "paymentStatusHistory",
  "payment",
  "orderNote",
  "orderStatusHistory",
  "orderEventLog",
  "agentRun",
  "conversationMessage",
  "conversation",
  // W1 incident log (no FK to any domain table — soft sessionId/conversationId
  // correlations only). Incident/observability data, wiped by a default clean.
  "conversationIncident",
  // NEW-025 ops-alert plane (no FK — restaurant-global operational alerts raised
  // by deterministic watchdogs). Ops telemetry, wiped by a default clean.
  "opsAlert",
  // NEW-016 staff scheduling (escala) — one row per assigned work shift. FK →
  // staff(id) (a reference table, deleted later / ON DELETE CASCADE), no children
  // of its own. Operational schedule data, wiped by a default clean; listed before
  // its parent `staff` (in DOMAIN_REFERENCE) for child-first FK-safety.
  "staffShift",
  "orderProjection",
  // Observability/telemetry tables (no FK to other domain tables). Registered
  // here to close the pre-existing db-tables drift their models (AgentRedTeamRun,
  // LlmTokenUsage) left open when they merged without a registry entry.
  "agentRedTeamRun",
  "llmTokenUsage",
  "loyaltyAccount",
  "customer",
  "timeSlot",
  "table",
  "deliveryZone",
] as const

/**
 * Operational config/reference tables — preserved by a routine `db clean` so it
 * never nukes staff accounts or schedules. Wiped only with `--reference` /
 * `--all`. Listed children → parents for FK-safety.
 */
export const DOMAIN_REFERENCE = [
  "staff",
  "weeklySchedule",
  "holiday",
  "scheduleOverride",
  // NEW-003 raw-ingredient inventory (stock slice) — the restaurant's catalog of
  // raw ingredients + on-hand stock + low-stock thresholds. Operational
  // reference/config data (like `staff` and the schedule templates): a routine
  // `db clean` must NOT nuke the ingredient catalog and force re-entering every
  // flour/meat row + threshold. No FK to any other domain table and no children,
  // so its position within this group is FK-irrelevant. Mutable stock lives on the
  // row, but the row's IDENTITY is reference data (staff rows likewise carry
  // mutable fields) — so it belongs in REFERENCE, preserved unless `--reference`/`--all`.
  "ingredient",
] as const

/**
 * Adjudicate kernel audit tables (raw SQL, @adjudicate/audit-postgres). None FK
 * each other today. The apply-once tracking table `adjudicate_audit_migrations`
 * is intentionally excluded — it records applied schema, not data, so a clean
 * must never truncate it (that would make provisioning re-run migrations).
 */
export const KERNEL_TABLES = [
  "intent_audit",
  "governance_events",
  "audit_guard_stats",
  "audit_outcomes",
  // responder-trace-admin (audit-postgres migration 011) — one row per LLM model
  // call; audit/trace data, so `db clean` truncates it like the others.
  "turn_trace",
] as const

/**
 * Claustrum memory + grounding tables (raw SQL, @claustrum/*). The
 * `claustrum_migrations` tracking table is excluded for the same reason as the
 * kernel tracking table above.
 */
export const MEMORY_TABLES = [
  "claustrum_memory_episodic",
  "claustrum_memory_semantic",
  "claustrum_memory_procedural",
  "claustrum_memory_relational",
  "claustrum_grounding_docs",
] as const

/** A Prisma domain delegate name (business or reference). */
export type DomainDelegate =
  | (typeof DOMAIN_DELETE_ORDER)[number]
  | (typeof DOMAIN_REFERENCE)[number]

/** A raw-SQL table name (kernel or memory layer). */
export type RawTable =
  | (typeof KERNEL_TABLES)[number]
  | (typeof MEMORY_TABLES)[number]
