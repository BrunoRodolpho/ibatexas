// estimate_delivery tool
// Validates a CEP, confirms it exists via ViaCEP, and matches against DeliveryZone.cepPrefixes.
// Returns fee, estimated minutes and zone name, or an out-of-area message.

import { createDeliveryZoneService } from "@ibatexas/domain";

export interface EstimateDeliveryInput {
  cep: string;
}

export interface EstimateDeliveryOutput {
  success: boolean;
  cep?: string;
  zoneName?: string;
  feeInCentavos?: number;
  estimatedMinutes?: number;
  message: string;
}

const CEP_RE = /^\d{8}$/;

export async function estimateDelivery(input: EstimateDeliveryInput): Promise<EstimateDeliveryOutput> {
  const cep = input.cep.replaceAll(/\D/g, "");

  if (!CEP_RE.test(cep)) {
    return { success: false, message: "CEP inválido. Informe 8 dígitos numéricos." };
  }

  // Confirm CEP exists via ViaCEP
  let viaCepOk = true;
  try {
    const res = await fetch(`https://viacep.com.br/ws/${cep}/json/`, {
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const data = (await res.json()) as { erro?: boolean };
      if (data.erro) viaCepOk = false;
    } else {
      viaCepOk = false;
    }
  } catch {
    // ViaCEP unavailable — continue with prefix matching anyway
  }

  if (!viaCepOk) {
    return { success: false, message: "CEP não encontrado. Verifique o número informado." };
  }

  // Match first 5 digits against active delivery zones
  const prefix5 = cep.slice(0, 5);
  const deliveryZoneSvc = createDeliveryZoneService();
  const match = await deliveryZoneSvc.findActiveByPrefix(prefix5, cep);

  if (!match) {
    return {
      success: false,
      message: `Infelizmente não entregamos no CEP ${cep} ainda. Consulte nosso cardápio para retirada no local.`,
    };
  }

  const feeReais = (match.feeInCentavos / 100).toFixed(2).replace(".", ",");
  return {
    success: true,
    cep,
    zoneName: match.name,
    feeInCentavos: match.feeInCentavos,
    estimatedMinutes: match.estimatedMinutes,
    message: `Entregamos em ${match.name}! Taxa: R$${feeReais}. Prazo estimado: ${match.estimatedMinutes} minutos.`,
  };
}

// ── Tool definition ───────────────────────────────────────────────────────────

export const EstimateDeliveryTool = {
  name: "estimate_delivery",
  description:
    "Verifica se o CEP informado está na área de entrega e retorna a taxa e o prazo estimado.",
  inputSchema: {
    type: "object",
    properties: {
      cep: { type: "string", description: "CEP de entrega (somente dígitos ou com hífen)" },
    },
    required: ["cep"],
  },
} as const;
