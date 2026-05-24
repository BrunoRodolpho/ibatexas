// vitest setup — bootstrap a no-op audit sink for every @ibatexas/tools
// test file.
//
// Post audit-2026-05-24 H2 (A1), `getAuditSink()` from
// `@ibatexas/audit-sink` is fail-closed: calling it before
// `__setAuditSinkDependencies(...)` throws `AuditSinkNotInitializedError`.
// Every cart-tool wrapper-call site now reads the sink at meta-build
// time, so without this setup the cart-tool unit tests (which mock the
// wrapper but still construct meta) would explode.
//
// Production wiring lives in `apps/api/src/audit-sink-bootstrap.ts` and
// is exercised by the apps/api integration suites. Here we just need a
// stub sink that satisfies the type — the wrapper itself is mocked in
// most cart-tool tests so the emit is never observed.

import {
  __setAuditSinkDependencies,
  type AuditSinkDependencies,
} from "@ibatexas/audit-sink"

// In-memory `PersistentSpillStorage` stub — duplicates the leaf's tiny
// in-memory shape so this setup file has no runtime dep on
// `@adjudicate/audit`. Order of operations matches the leaf's
// `createInMemorySpillStorage`.
const spillStorage = {
  async append() {
    /* no-op */
  },
  async *readAll() {
    /* yields nothing */
  },
  async ack() {
    /* no-op */
  },
}

const noopDeps: AuditSinkDependencies = {
  spillStorage,
  postgresWriter: {
    async insertAudit() {
      /* no-op */
    },
  },
  natsPublisher: {
    async publish() {
      /* no-op */
    },
  },
  redactor: {
    redact(record) {
      return record
    },
  },
  logger: {
    warn() {
      /* no-op */
    },
    error() {
      /* no-op */
    },
  },
}

__setAuditSinkDependencies(noopDeps)
