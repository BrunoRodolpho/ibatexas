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
  },
});
