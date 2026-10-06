import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // audit-2026-05-24 H2 (A1): every wrapper-call site in the api routes
    // / whatsapp client now constructs meta with `auditSink: getAuditSink()`.
    // The leaf's `getAuditSink()` is fail-closed and throws if called before
    // `__setAuditSinkDependencies(...)`. We wire a no-op sink in
    // `src/__tests__/setup.ts` so every test file gets a usable sink at
    // module load. Production wiring lives in `apps/api/src/audit-sink-
    // bootstrap.ts` and is exercised by the integration suites.
    setupFiles: ["./src/__tests__/setup.ts"],
    // BKL-245: match the 60s budget CI already runs with
    // (ci.yml `turbo test -- --testTimeout=60000`) so local full-suite
    // runs have the same headroom instead of flaking at the 5s default.
    testTimeout: 60_000,
    // BKL-245: the hook-timeout flakes are this package's alone — the
    // `beforeAll` hooks in admin-auth / admin-reviews build a full Fastify
    // test server, which exceeds the 10s default on a contended machine.
    // CI's `--testTimeout` flag does NOT raise hookTimeout, so CI is exposed
    // to these too; 30s is the bound. Deliberately NOT applied workspace-wide.
    hookTimeout: 30_000,
  },
});
