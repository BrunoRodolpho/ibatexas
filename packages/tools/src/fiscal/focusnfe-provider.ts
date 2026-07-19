// FocusNFeAdapter — NEW-014, the ratified integrate-first target (Focus NFe,
// https://focusnfe.com.br). CODED against their documented NFC-e API but
// CREDENTIAL-GATED: without FOCUSNFE_TOKEN it fails CLOSED (throws) — never a
// silent success — and it is NEVER exercised in tests (no HTTP in CI). It ships
// now so the wire shape is reviewed early; it goes live only when the external
// certificate/account procurement lands (the NEW-014 provider gate).
//
// Focus NFe NFC-e flow (documented):
//   POST {base}/v2/nfce?ref={ref}   Basic auth (token as username, blank pw),
//                                   JSON body → 202 accepted (async processing).
//   GET  {base}/v2/nfce/{ref}       → { status: "autorizado" | "erro_autorizacao"
//                                       | "processando_autorizacao" | ...,
//                                       chave_nfe, caminho_xml_nota_fiscal,
//                                       caminho_danfe, mensagem_sefaz }.

import type {
  FiscalEmitInput,
  FiscalEmitResult,
  FiscalProviderPort,
} from "./port.js";

/** Thrown when the adapter is selected but its credentials are absent — the
 *  fail-closed posture (a fiscal emit must never silently no-op). */
export class FiscalProviderNotConfiguredError extends Error {
  constructor(missing: string) {
    super(`Focus NFe fiscal provider not configured: missing ${missing}`);
    this.name = "FiscalProviderNotConfiguredError";
  }
}

export interface FocusNFeConfig {
  /** Focus NFe API token (Basic-auth username). Required — else fail-closed. */
  readonly token: string | undefined;
  /** API base, e.g. https://api.focusnfe.com.br (sandbox: homologacao host). */
  readonly baseUrl: string | undefined;
  /** Injected for tests only — production uses global fetch. */
  readonly fetchImpl?: typeof fetch;
}

/** Map the Focus NFe `status` string onto the port's outcome. */
function mapFocusStatus(status: string): FiscalEmitResult["status"] {
  if (status === "autorizado") return "approved";
  if (status === "erro_autorizacao" || status === "denegado") return "rejected";
  if (status === "processando_autorizacao") return "timeout";
  return "error";
}

/** Build the Focus NFe NFC-e request body from the port input. Minimal but
 *  wire-shaped; the full SEFAZ field set (emitente, tributos) is a config layer
 *  filled at integration time — flagged as the PR-N follow-up, not mocked. */
function toFocusNFcePayload(input: FiscalEmitInput): Record<string, unknown> {
  return {
    // reais on the Focus wire (centavos/100) — never a raw float from a float.
    valor_total: (input.totalCentavos / 100).toFixed(2),
    ...(input.customerTaxId ? { cpf_destinatario: input.customerTaxId } : {}),
    items: input.items.map((it, i) => ({
      numero_item: i + 1,
      descricao: it.description,
      quantidade_comercial: it.quantity,
      valor_unitario_comercial: (it.unitPriceCentavos / 100).toFixed(2),
    })),
  };
}

export function createFocusNFeProvider(config: FocusNFeConfig): FiscalProviderPort {
  const doFetch = config.fetchImpl ?? fetch;
  return {
    name: "focusnfe",
    async emit(input: FiscalEmitInput): Promise<FiscalEmitResult> {
      // FAIL CLOSED — never emit against an unconfigured provider.
      if (!config.token) throw new FiscalProviderNotConfiguredError("FOCUSNFE_TOKEN");
      if (!config.baseUrl) throw new FiscalProviderNotConfiguredError("FOCUSNFE_BASE_URL");

      const ref = `order-${input.orderId}`;
      const auth = `Basic ${Buffer.from(`${config.token}:`).toString("base64")}`;
      let response: Response;
      try {
        response = await doFetch(`${config.baseUrl}/v2/nfce?ref=${encodeURIComponent(ref)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: auth },
          body: JSON.stringify(toFocusNFcePayload(input)),
        });
      } catch (err) {
        return { status: "error", rejectionReason: `transport: ${(err as Error).message}` };
      }

      // Async accept (202) → the subscriber polls the ref later; surface as a
      // retriable timeout so the pack policy's retry cap governs re-checks.
      if (response.status === 202) return { status: "timeout", rejectionReason: "processando_autorizacao" };

      const body = (await response.json().catch(() => null)) as
        | { status?: string; chave_nfe?: string; caminho_xml_nota_fiscal?: string; caminho_danfe?: string; mensagem_sefaz?: string }
        | null;
      if (!response.ok || !body) {
        return { status: "error", rejectionReason: `http ${response.status}` };
      }
      const status = mapFocusStatus(body.status ?? "");
      if (status === "approved") {
        return {
          status,
          ...(body.chave_nfe ? { accessKey: body.chave_nfe } : {}),
          ...(body.caminho_xml_nota_fiscal ? { xmlUrl: `${config.baseUrl}${body.caminho_xml_nota_fiscal}` } : {}),
          ...(body.caminho_danfe ? { pdfUrl: `${config.baseUrl}${body.caminho_danfe}` } : {}),
        };
      }
      return { status, ...(body.mensagem_sefaz ? { rejectionReason: body.mensagem_sefaz } : {}) };
    },
  };
}
