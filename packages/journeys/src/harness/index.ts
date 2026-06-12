// harness/ barrel — environment handshake + invariant harness.
//
// T1a-10: pre-flight (IBX_TEST_FINGERPRINT handshake via /health
// testFingerprint, hostname denylist over the infraEndpoints() address
// source, ANTHROPIC_MODEL == certification target with the nonCertifying
// escape, ANTHROPIC_API_KEY presence). Later agents extend ONLY this
// barrel — the root src/index.ts already re-exports it.

export {
  CERTIFICATION_MODEL,
  NON_CERTIFYING_ENV,
  PREFLIGHT_CHECKS,
  PreflightRefusalError,
  runPreflight,
  TEST_FINGERPRINT_ENV,
  type FetchLike,
  type PreflightCheckName,
  type PreflightCheckRecord,
  type PreflightOptions,
  type PreflightResult,
} from "./preflight.js"
