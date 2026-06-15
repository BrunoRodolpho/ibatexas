#!/usr/bin/env bash
# scripts/check-bypass.sh — Task 20 bypass-detection CI gate.
#
# Runs the consolidated bypass-detection test suite. This is the single
# entry point CI invokes to enforce the zero-trust-kernel invariants.
#
# What it checks (see apps/api/src/__tests__/bypass-detection/
# bypass-detection.test.ts for the authoritative source):
#
#   1. No direct prisma.*.{create,update,delete,upsert} outside command-service
#      *FromEnvelope paths.
#   2. No medusaStore.* / medusaAdmin.* writes outside medusaAdjudicated().
#   3. No executeToolDirect symbol anywhere (task 06 removed it).
#   4. No setMetricsSink(undefined|null) calls (silently disables telemetry).
#   5. Runtime smoke: the dispatcher refuses unknown tool names with
#      kind:"failed" (no silent success on missing handlers).
#
# # Exit codes
#   0  → all bypass-detection assertions pass
#   1+ → at least one bypass detected; CI will fail
#
# # Local usage
#   ./scripts/check-bypass.sh
#
# # CI usage
#   add the call to .github/workflows/*.yml as a required check
#
# # On false-positive
#   Update the ALLOWED_* sets in bypass-detection.test.ts, not this script.

set -euo pipefail

# Resolve repo root from the script location.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

echo "── Bypass detection CI gate ─────────────────────────────────────────"
echo ""
echo "Scanning for:"
echo "  1. Direct prisma writes outside *FromEnvelope path"
echo "  2. medusaStore/medusaAdmin writes outside medusaAdjudicated()"
echo "  3. executeToolDirect re-introduction"
echo "  4. setMetricsSink(undefined|null) in production"
echo "  5. Dispatcher refuses unknown tools (runtime smoke)"
echo ""

# Run the consolidated bypass-detection vitest suite.
pnpm --filter @ibatexas/api exec vitest run \
  src/__tests__/bypass-detection/bypass-detection.test.ts \
  --reporter=verbose

echo ""
echo "── Also run @ibatexas/domain bypass-detection (task 15 owner sites) ──"
echo ""

pnpm --filter @ibatexas/domain exec vitest run \
  src/services/__tests__/no-direct-prisma-bypass.test.ts \
  --reporter=verbose

echo ""
echo "── Also run @ibatexas/llm-provider executeToolDirect removal test ────"
echo ""

pnpm --filter @ibatexas/llm-provider exec vitest run \
  src/__tests__/no-execute-tool-direct.test.ts \
  --reporter=verbose

echo ""
echo "✓ Bypass detection passed."
