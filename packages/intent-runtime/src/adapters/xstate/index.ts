/**
 * adapters/xstate — the XState binding for the IBX-IGE runtime.
 *
 * In v1.0 this is a re-export from `@ibatexas/llm-provider`. In v2.0 this
 * subpath extracts to `@ibx/intent-runtime-xstate` and the concrete XState
 * code physically lives here. The export surface is chosen today so the
 * split is a move + rename, not a redesign.
 */

export {
  orderMachine,
  getStateString,
  createDefaultContext,
  isCheckoutState,
} from "@ibatexas/llm-provider"
