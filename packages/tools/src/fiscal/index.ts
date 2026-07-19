// Fiscal provider selection (NEW-014). Env-driven (Hard Rule #3), default mock
// (Hard Rule #6 — FISCAL_PROVIDER + FOCUSNFE_* documented in .env.example).
//
//   FISCAL_PROVIDER=mock      → deterministic local provider (DEFAULT).
//   FISCAL_PROVIDER=focusnfe  → the integrate-first Focus NFe adapter
//                               (fails closed without FOCUSNFE_TOKEN).
//   FISCAL_MOCK_SCENARIO=approve|reject|timeout → force a mock outcome (sandbox).

import type { FiscalProviderPort } from "./port.js";
import { createMockFiscalProvider, type MockFiscalScenario } from "./mock-provider.js";
import { createFocusNFeProvider } from "./focusnfe-provider.js";

export * from "./port.js";
export {
  createMockFiscalProvider,
  type MockFiscalScenario,
  type MockFiscalProviderConfig,
} from "./mock-provider.js";
export {
  createFocusNFeProvider,
  FiscalProviderNotConfiguredError,
  type FocusNFeConfig,
} from "./focusnfe-provider.js";

/**
 * Build the configured fiscal provider from the environment. Unknown /
 * unset FISCAL_PROVIDER resolves to the mock (fail-safe default — the flow
 * is always buildable locally; the real provider is opt-in via env).
 */
export function createFiscalProvider(env: NodeJS.ProcessEnv = process.env): FiscalProviderPort {
  if (env.FISCAL_PROVIDER === "focusnfe") {
    return createFocusNFeProvider({
      token: env.FOCUSNFE_TOKEN,
      baseUrl: env.FOCUSNFE_BASE_URL,
    });
  }
  const scenario = env.FISCAL_MOCK_SCENARIO as MockFiscalScenario | undefined;
  return createMockFiscalProvider(scenario ? { scenario } : {});
}
