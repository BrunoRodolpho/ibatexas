// Shared `no-restricted-imports` path entries (F-53).
//
// ── Why this lives in the shared config ───────────────────────────────────
//
// `@adjudicate/audit`'s root export publicly ships the raw sink primitives.
// Every IbateXas audit emit MUST route through `getAuditSink()`
// (`@ibatexas/audit-sink`), which wraps the whole fan-out in the
// `AuditRedactor` — see the composition note in
// `packages/audit-sink/src/intent-audit-wiring.ts`. An emit built directly on
// a raw primitive reaches NATS + Postgres with PII intact, which is an LGPD
// control failure, not a style problem.
//
// The invariant is repo-wide, so the rule ships in the base config that every
// workspace's `eslint.config.mjs` extends. Only the authorised composer inside
// `@ibatexas/audit-sink` may import these — that package's own
// `eslint.config.mjs` carries the (hand-written, deliberately minimal)
// file allowlist.
//
// ── Override hazard ───────────────────────────────────────────────────────
//
// ESLint REPLACES rule options rather than merging them: a workspace that
// declares its own `no-restricted-imports` drops every path in this base
// entry. The three workspaces that do so (`apps/api`, `apps/web`,
// `packages/tools`) therefore splice `AUDIT_RAW_SINK_IMPORT_BAN` into their
// own `paths` array explicitly. Adding a new `no-restricted-imports` override
// anywhere means doing the same, or that workspace silently loses this ban.

/**
 * Emitters — each can reach a concrete destination (console, NATS) or fan out
 * to several, so any of them is a complete unredacted-emit path on its own.
 */
const RAW_AUDIT_SINK_EMITTERS = [
  "multiSink",
  "multiSinkLossy",
  "multiSinkStrict",
  "createConsoleSink",
  "createNatsSink",
]

/**
 * Wrappers — these buffer/spill around an inner sink and cannot emit by
 * themselves. Banned anyway: composing durability around the audit path is the
 * owner package's job, and a wrapper is the natural place to smuggle a raw
 * inner sink past review.
 */
const RAW_AUDIT_SINK_WRAPPERS = ["bufferedSink", "persistentBufferedSink"]

const RAW_AUDIT_SINK_PRIMITIVES = [
  ...RAW_AUDIT_SINK_EMITTERS,
  ...RAW_AUDIT_SINK_WRAPPERS,
]

const AUDIT_RAW_SINK_IMPORT_BAN = {
  name: "@adjudicate/audit",
  importNames: RAW_AUDIT_SINK_PRIMITIVES,
  message:
    "Raw @adjudicate/audit sink primitives are restricted to the audit composer (packages/audit-sink/src/index.ts). Every audit emit must go through getAuditSink() from @ibatexas/audit-sink so the AuditRedactor scrubs PII before NATS/Postgres see the record (LGPD). Non-emitting helpers such as createInMemorySpillStorage are unrestricted.",
}

module.exports = {
  AUDIT_RAW_SINK_IMPORT_BAN,
  RAW_AUDIT_SINK_PRIMITIVES,
  RAW_AUDIT_SINK_EMITTERS,
  RAW_AUDIT_SINK_WRAPPERS,
}
