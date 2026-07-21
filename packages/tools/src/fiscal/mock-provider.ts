// MockFiscalProvider — NEW-014. Deterministic, local, TEST-COMPLETE fiscal
// provider and the DEFAULT (FISCAL_PROVIDER=mock). No network, no credentials.
// Same input → same output across runs and processes, so golden fixtures and
// subscriber-idempotency tests are stable.
//
// Sandbox scenarios (approve / reject / timeout) are switchable — at
// construction (scenario) OR per-order via a scenario map — mirroring a real
// PSP sandbox's forced-outcome hooks, so PR2's subscriber + the end-to-end
// flow can exercise every branch deterministically.

import { createHash } from "node:crypto";
import type {
  FiscalEmitInput,
  FiscalEmitResult,
  FiscalProviderPort,
} from "./port.js";

/** The forced sandbox outcomes the mock can produce. */
export type MockFiscalScenario = "approve" | "reject" | "timeout";

export interface MockFiscalProviderConfig {
  /** Default outcome for every order. Defaults to "approve". */
  readonly scenario?: MockFiscalScenario;
  /** Per-orderId override — forces a specific outcome for named orders. */
  readonly scenarioByOrderId?: Readonly<Record<string, MockFiscalScenario>>;
}

/** Deterministic mock NFC-e access key derived from the orderId (stable across
 *  runs/processes). ALWAYS `MOCK-`-prefixed: a real SEFAZ chave is exactly 44
 *  numeric digits, so the prefix makes it structurally impossible for a mock
 *  emission to be read as fiscal truth by any downstream surface (NEW-014
 *  safety requirement — a mock approval must never be confusable with a real
 *  NFe). The 44-digit body is preserved after the prefix for shape parity. */
function deriveAccessKey(orderId: string): string {
  const hex = createHash("sha256").update(`nfce:${orderId}`).digest("hex");
  // Map hex → 44 decimal digits deterministically (BigInt, zero-padded).
  const digits = BigInt(`0x${hex}`).toString().padStart(44, "0").slice(-44);
  // NEW-014 review gate — DOUBLE distinguishability: the MOCK- prefix AND a
  // "00" leading pair inside the 44-digit body (a real chave de acesso starts
  // with the IBGE UF code, 11–53 — never 00), so even the bare body can never
  // be mistaken for a real SEFAZ key if the prefix is ever stripped downstream.
  return `MOCK-00${digits.slice(2)}`;
}

/** Resolve which scenario applies to this order (per-order override wins). */
function resolveScenario(
  config: MockFiscalProviderConfig,
  orderId: string,
): MockFiscalScenario {
  return config.scenarioByOrderId?.[orderId] ?? config.scenario ?? "approve";
}

export function createMockFiscalProvider(
  config: MockFiscalProviderConfig = {},
): FiscalProviderPort {
  return {
    name: "mock",
    async emit(input: FiscalEmitInput): Promise<FiscalEmitResult> {
      const scenario = resolveScenario(config, input.orderId);
      if (scenario === "reject") {
        return {
          status: "rejected",
          rejectionReason: "mock: rejeição SEFAZ simulada (sandbox)",
        };
      }
      if (scenario === "timeout") {
        return {
          status: "timeout",
          rejectionReason: "mock: tempo de resposta da SEFAZ esgotado (sandbox)",
        };
      }
      const accessKey = deriveAccessKey(input.orderId);
      return {
        status: "approved",
        accessKey,
        xmlUrl: `mock://fiscal/${accessKey}.xml`,
        pdfUrl: `mock://fiscal/${accessKey}.pdf`,
      };
    },
  };
}
