// NEW-014 — fiscal provider port contract + mock scenarios + Focus NFe
// fail-closed + env selection. No network: the mock is deterministic and the
// Focus NFe adapter is only ever exercised in its NOT-CONFIGURED (throws) path.

import { describe, it, expect, vi } from "vitest";
import {
  createFiscalProvider,
  createMockFiscalProvider,
  createFocusNFeProvider,
  FiscalProviderNotConfiguredError,
  type FiscalEmitInput,
} from "../index.js";

const INPUT: FiscalEmitInput = {
  orderId: "order_01",
  displayId: 42,
  items: [
    { description: "Costela bovina defumada", quantity: 1, unitPriceCentavos: 8900 },
    { description: "Guaraná", quantity: 2, unitPriceCentavos: 600 },
  ],
  totalCentavos: 10100,
  customerTaxId: "12345678909",
};

describe("MockFiscalProvider — scenarios + determinism", () => {
  it("approve → approved with a MOCK-prefixed access key + xml/pdf urls", async () => {
    const r = await createMockFiscalProvider({ scenario: "approve" }).emit(INPUT);
    expect(r.status).toBe("approved");
    // MOCK- prefix so a mock emission can never be read as a real 44-digit
    // SEFAZ chave downstream (NEW-014 safety requirement).
    expect(r.accessKey).toMatch(/^MOCK-\d{44}$/);
    expect(r.xmlUrl).toContain(r.accessKey!);
    expect(r.pdfUrl).toContain(r.accessKey!);
    expect(r.rejectionReason).toBeUndefined();
  });

  it("defaults to approve when no scenario is given", async () => {
    expect((await createMockFiscalProvider().emit(INPUT)).status).toBe("approved");
  });

  it("reject → rejected with a reason + NO access key", async () => {
    const r = await createMockFiscalProvider({ scenario: "reject" }).emit(INPUT);
    expect(r.status).toBe("rejected");
    expect(r.rejectionReason).toBeTruthy();
    expect(r.accessKey).toBeUndefined();
  });

  it("timeout → timeout with a reason + NO access key", async () => {
    const r = await createMockFiscalProvider({ scenario: "timeout" }).emit(INPUT);
    expect(r.status).toBe("timeout");
    expect(r.accessKey).toBeUndefined();
  });

  it("is DETERMINISTIC — same input → same access key across instances", async () => {
    const a = await createMockFiscalProvider().emit(INPUT);
    const b = await createMockFiscalProvider().emit(INPUT);
    expect(a.accessKey).toBe(b.accessKey);
  });

  it("distinct orders get distinct access keys", async () => {
    const a = await createMockFiscalProvider().emit(INPUT);
    const b = await createMockFiscalProvider().emit({ ...INPUT, orderId: "order_02" });
    expect(a.accessKey).not.toBe(b.accessKey);
  });

  it("per-orderId override wins over the default scenario", async () => {
    const p = createMockFiscalProvider({ scenario: "approve", scenarioByOrderId: { order_01: "reject" } });
    expect((await p.emit(INPUT)).status).toBe("rejected");
    expect((await p.emit({ ...INPUT, orderId: "order_99" })).status).toBe("approved");
  });
});

describe("FocusNFeAdapter — fails CLOSED, never HTTP in tests", () => {
  it("throws FiscalProviderNotConfiguredError when the token is missing (no fetch)", async () => {
    const fetchSpy = vi.fn();
    const p = createFocusNFeProvider({ token: undefined, baseUrl: "https://api.focusnfe.com.br", fetchImpl: fetchSpy as unknown as typeof fetch });
    await expect(p.emit(INPUT)).rejects.toBeInstanceOf(FiscalProviderNotConfiguredError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("throws when the base url is missing", async () => {
    const p = createFocusNFeProvider({ token: "tok", baseUrl: undefined });
    await expect(p.emit(INPUT)).rejects.toBeInstanceOf(FiscalProviderNotConfiguredError);
  });
});

describe("createFiscalProvider — env selection", () => {
  it("defaults to the mock when FISCAL_PROVIDER is unset", () => {
    expect(createFiscalProvider({}).name).toBe("mock");
  });

  it("selects focusnfe when FISCAL_PROVIDER=focusnfe", () => {
    expect(createFiscalProvider({ FISCAL_PROVIDER: "focusnfe" } as NodeJS.ProcessEnv).name).toBe("focusnfe");
  });

  it("honors FISCAL_MOCK_SCENARIO for the mock", async () => {
    const p = createFiscalProvider({ FISCAL_MOCK_SCENARIO: "reject" } as NodeJS.ProcessEnv);
    expect((await p.emit(INPUT)).status).toBe("rejected");
  });
});
