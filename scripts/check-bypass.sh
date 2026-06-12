#!/usr/bin/env bash
# scripts/check-bypass.sh — Task 20 bypass-detection CI gate.
#
# Runs the consolidated bypass-detection test suite. This is the single
# entry point CI invokes to enforce the zero-trust-kernel invariants.
#
# What it checks (see apps/api/src/__tests__/bypass-detection/
# bypass-detection.test.ts for the authoritative source of 1-5):
#
#   1. No direct prisma.*.{create,update,delete,upsert} outside command-service
#      *FromEnvelope paths.
#   2. No medusaStore.* / medusaAdmin.* writes outside medusaAdjudicated().
#   3. No executeToolDirect symbol anywhere (task 06 removed it).
#   4. No setMetricsSink(undefined|null) calls (silently disables telemetry).
#   5. Runtime smoke: the dispatcher refuses unknown tool names with
#      kind:"failed" (no silent success on missing handlers).
#   6. Forward-containment: app/package sources never import the test plane
#      (@ibatexas/journeys); the dependency only flows the other way.
#   7. Forward-containment: packages/journeys never reaches into apps/api
#      internals (vacuously green until the package lands in Phase 1).
#
# Every pnpm --filter leg is guarded: a filter that matches no workspace
# package fails the gate instead of silently no-opping (pnpm exits 0 on
# zero matches — that bit us when @ibatexas/llm-provider was deleted).
#
# # Exit codes
#   0  → all bypass-detection assertions pass
#   1+ → at least one bypass detected; CI will fail
#
# # Local usage
#   ./scripts/check-bypass.sh
#   ./scripts/check-bypass.sh --self-test   # prove the no-match guard fails closed
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

# pnpm exits 0 when --filter matches nothing, turning the leg into a silent
# no-op. Assert the package actually resolves in the workspace first.
require_workspace_pkg() {
  local pkg="$1"
  if ! pnpm ls --filter "$pkg" --depth -1 2>/dev/null | grep -q "^${pkg}@"; then
    echo "✗ Workspace package not found: ${pkg} — its filter would match" >&2
    echo "  nothing and the leg would silently pass. Fix or remove the leg." >&2
    exit 1
  fi
}

# --self-test: prove the no-match guard exits non-zero on a bogus package.
if [[ "${1:-}" == "--self-test" ]]; then
  if (require_workspace_pkg "@ibatexas/no-such-package-self-test"); then
    echo "✗ Self-test FAILED: guard accepted a package that does not exist." >&2
    exit 1
  fi
  echo "✓ Self-test passed: no-match guard rejects unknown packages."
  exit 0
fi

echo "── Bypass detection CI gate ─────────────────────────────────────────"
echo ""
echo "Scanning for:"
echo "  1. Direct prisma writes outside *FromEnvelope path"
echo "  2. medusaStore/medusaAdmin writes outside medusaAdjudicated()"
echo "  3. executeToolDirect re-introduction"
echo "  4. setMetricsSink(undefined|null) in production"
echo "  5. Dispatcher refuses unknown tools (runtime smoke)"
echo "  6. App/package sources importing @ibatexas/journeys (test plane)"
echo "  7. packages/journeys reaching into apps/api internals"
echo ""

# Run the consolidated bypass-detection vitest suite.
require_workspace_pkg "@ibatexas/api"
pnpm --filter @ibatexas/api exec vitest run \
  src/__tests__/bypass-detection/bypass-detection.test.ts \
  --reporter=verbose

echo ""
echo "── Also run @ibatexas/domain bypass-detection (task 15 owner sites) ──"
echo ""

require_workspace_pkg "@ibatexas/domain"
pnpm --filter @ibatexas/domain exec vitest run \
  src/services/__tests__/no-direct-prisma-bypass.test.ts \
  --reporter=verbose

echo ""
echo "── Forward-containment: app code never imports @ibatexas/journeys ───"
echo ""

# The test plane (@ibatexas/journeys, Phase 1) may depend on apps/packages,
# never the reverse. Greps regardless of whether the package exists yet.
JOURNEYS_IMPORTS="$(grep -rnE "['\"]@ibatexas/journeys" apps packages \
  --include='*.ts' --include='*.tsx' \
  --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=__tests__ \
  --exclude='*.test.ts' --exclude='*.test.tsx' --exclude='*.spec.ts' \
  | grep -v '^packages/journeys/' || true)"

if [[ -n "$JOURNEYS_IMPORTS" ]]; then
  echo "$JOURNEYS_IMPORTS"
  echo "✗ apps/* and non-test packages/* must not import @ibatexas/journeys." >&2
  exit 1
fi
echo "✓ No @ibatexas/journeys imports outside the test plane."

echo ""
echo "── Forward-containment: journeys never reaches into apps/api ────────"
echo ""

# A missing packages/journeys is success — the leg arms the moment it lands.
if [[ -d packages/journeys ]]; then
  API_INTERNAL_IMPORTS="$(grep -rnE "['\"]([^'\"]*apps/api|@ibatexas/api)" packages/journeys \
    --include='*.ts' --include='*.tsx' \
    --exclude-dir=node_modules --exclude-dir=dist || true)"

  if [[ -n "$API_INTERNAL_IMPORTS" ]]; then
    echo "$API_INTERNAL_IMPORTS"
    echo "✗ packages/journeys must not import apps/api internals." >&2
    exit 1
  fi
  echo "✓ packages/journeys does not reach into apps/api."
else
  echo "✓ packages/journeys not present yet — leg passes vacuously."
fi

echo ""
echo "✓ Bypass detection passed."
