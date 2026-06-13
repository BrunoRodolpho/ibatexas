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
#      (@ibatexas/journeys); the dependency only flows the other way
#      (sanctioned exception: packages/cli — the pinned direction is
#      journeys→tools, cli→journeys, cli→tools).
#   7. Forward-containment: packages/journeys never reaches into apps/api
#      internals. Non-vacuous since Phase 1a (T1a-1) landed the package: a
#      missing packages/journeys now FAILS the gate instead of passing
#      vacuously (T1a-9 armed the leg).
#   8. Test-plane NATS containment (T1b-2/DR-2): packages/journeys never
#      calls a NATS publish API (.publish(/jetstream(/publishNatsEvent(/…) —
#      the oracle observes the bus through the publish-incapable NatsCapture
#      wrapper (src/oracle/nats-capture.ts), whose guard internals + tests
#      are the only sanctioned places that may NAME those members.
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
echo "  8. packages/journeys calling a NATS publish API (test plane is subscribe-only)"
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
# Sanctioned exception (T1a-2): packages/cli is the thin registration point
# for the `ibx journey` gates — the dependency direction is cli→journeys,
# never journeys→cli (the reverse stays caught by journeys' own deps).
JOURNEYS_IMPORTS="$(grep -rnE "['\"]@ibatexas/journeys" apps packages \
  --include='*.ts' --include='*.tsx' \
  --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=__tests__ \
  --exclude='*.test.ts' --exclude='*.test.tsx' --exclude='*.spec.ts' \
  | grep -v '^packages/journeys/' \
  | grep -v '^packages/cli/' || true)"

if [[ -n "$JOURNEYS_IMPORTS" ]]; then
  echo "$JOURNEYS_IMPORTS"
  echo "✗ apps/* and non-test packages/* (except the cli registration point)" >&2
  echo "  must not import @ibatexas/journeys." >&2
  exit 1
fi
echo "✓ No @ibatexas/journeys imports outside the test plane."

echo ""
echo "── Forward-containment: journeys never reaches into apps/api ────────"
echo ""

# Non-vacuous since T1a-1 landed the package (T1a-9 armed this): the package
# must exist AND resolve in the workspace, otherwise the leg fails closed —
# a deleted/renamed test plane must never silently green this gate.
if [[ ! -d packages/journeys ]]; then
  echo "✗ packages/journeys is missing — the test plane landed in Phase 1a;" >&2
  echo "  this leg no longer passes vacuously. Restore the package or" >&2
  echo "  consciously remove the leg." >&2
  exit 1
fi
require_workspace_pkg "@ibatexas/journeys"

# Anchored to import syntax (from/import/require directly before the quoted
# specifier): a bare `['\"]...apps/api` pattern treats prose apostrophes as
# opening quotes — a doc comment like «P0-2's precedent in apps/api/...»
# false-positived the leg. Catches static `from "..."`, side-effect
# `import "..."`, dynamic `import("...")` and `require("...")`.
API_INTERNAL_IMPORTS="$(grep -rnE \
  "(^|[^[:alnum:]_.])(from|import|require)[[:space:](]*['\"]([^'\"]*apps/api|@ibatexas/api)" \
  packages/journeys \
  --include='*.ts' --include='*.tsx' \
  --exclude-dir=node_modules --exclude-dir=dist || true)"

if [[ -n "$API_INTERNAL_IMPORTS" ]]; then
  echo "$API_INTERNAL_IMPORTS"
  echo "✗ packages/journeys must not import apps/api internals." >&2
  exit 1
fi
echo "✓ packages/journeys does not reach into apps/api (scanned non-vacuously)."

echo ""
echo "── Test-plane NATS containment: journeys never publishes (leg 8) ─────"
echo ""

# T1b-2 (DR-2): the journey test plane OBSERVES the event bus, never injects
# into it — a test-plane publish could forge production signals
# (payment.status_changed → forged resume; intent.defer.timeout → forged LGPD
# anonymize). The only sanctioned NATS surface in packages/journeys is the
# publish-incapable NatsCapture wrapper (src/oracle/nats-capture.ts), so any
# call-shaped use of a publish API anywhere else in the package fails the
# gate. Patterns cover Core NATS (.publish(/.publishMessage(/.request(/
# .requestMany(), JetStream entry points (jetstream(/jetstreamManager(), and
# the in-repo helper (publishNatsEvent().
#
# Exclusions (the task-pinned carve-out, kept minimal):
#   - src/oracle/nats-capture.ts — the guard module itself NAMES the
#     forbidden members to assert they are unreachable;
#   - src/harness/trigger-inject.ts — T3-9: the SINGLE sanctioned test-plane
#     publish (wakes a managed-agent trigger bridge in a journey). Contained
#     like nats-capture: fingerprint-gated at runtime (IBX_TEST_FINGERPRINT),
#     never imported by the persona driver (not in the {chat,http,fixture}
#     act-tool set), unreachable from apps/* (leg 6). Deliberate + named,
#     mirroring the JWT-fixture containment (plan §9 governance critic).
#   - tests (__tests__/ + *.test.ts/*.spec.ts) — they pin the guard by
#     attempting the forbidden calls against doubles.
# Leg 7 above already fails closed when packages/journeys is missing, so
# this grep never passes vacuously.
NATS_PUBLISH_CALLS="$(grep -rnE \
  "(\.publish\(|\.publishMessage\(|\.request\(|\.requestMany\(|jetstream\(|jetstreamManager\(|publishNatsEvent\()" \
  packages/journeys \
  --include='*.ts' --include='*.tsx' \
  --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=__tests__ \
  --exclude='*.test.ts' --exclude='*.test.tsx' --exclude='*.spec.ts' \
  --exclude='nats-capture.ts' \
  --exclude='trigger-inject.ts' || true)"

if [[ -n "$NATS_PUBLISH_CALLS" ]]; then
  echo "$NATS_PUBLISH_CALLS"
  echo "✗ packages/journeys must never call a NATS publish API — the test" >&2
  echo "  plane is subscribe-only (use the NatsCapture oracle wrapper;" >&2
  echo "  see src/oracle/nats-capture.ts)." >&2
  exit 1
fi
echo "✓ packages/journeys contains no NATS publish API calls (subscribe-only test plane)."

echo ""
echo "✓ Bypass detection passed."
