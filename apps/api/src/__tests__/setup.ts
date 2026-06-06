// vitest setup — bootstrap a no-op audit sink for every apps/api test file.
//
// Post audit-2026-05-24 H2 (A1), `getAuditSink()` from
// `@ibatexas/audit-sink` is fail-closed: calling it before
// `__setAuditSinkDependencies(...)` throws `AuditSinkNotInitializedError`.
// Cart routes, whatsapp client, stripe webhook, and the subscriber/job
// surfaces all build wrapper meta with `auditSink: getAuditSink()` at
// import time, so without this setup the route + whatsapp-client tests
// would explode at first call.
//
// Production wiring lives in `apps/api/src/audit-sink-bootstrap.ts`. The
// integration suites that exercise the bootstrap path (e.g.
// `audit-sink-fail-resilience.test.ts`) call `wiring._resetAuditSink()` +
// `wiring._setAuditSinkDependencies({...})` themselves and override the
// noop wired here.

import {
  __setAuditSinkDependencies,
  type AuditSinkDependencies,
} from "@ibatexas/audit-sink";

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
};

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
      return record;
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
};

__setAuditSinkDependencies(noopDeps);
