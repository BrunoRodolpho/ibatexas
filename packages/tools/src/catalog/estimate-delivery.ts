// estimate_delivery tool
// Accepts a CEP OR GPS coordinates (latitude + longitude).
// For GPS: reverse geocodes to CEP → CEP prefix matching (primary).
//          If geocoding yields no CEP: Haversine distance against zones with centerLat/centerLng (fallback).
// Returns fee, estimated minutes and zone name, or an out-of-area message.

import { createDeliveryZoneService } from "@ibatexas/domain";
import { reverseGeocode } from "./reverse-geocode.js";

export interface EstimateDeliveryInput {
  cep?: string;
  latitude?: number;
  longitude?: number;
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

// ── Haversine distance ────────────────────────────────────────────────────────

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371; // Earth radius in km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── CEP-based estimation ──────────────────────────────────────────────────────

async function estimateDeliveryByCep(cep: string): Promise<EstimateDeliveryOutput> {
  const cleanCep = cep.replaceAll(/\D/g, "");

  if (!CEP_RE.test(cleanCep)) {
    return { success: false, message: "CEP inválido. Informe 8 dígitos numéricos." };
  }

  // Confirm CEP exists via ViaCEP
  let viaCepOk = true;
  try {
    const res = await fetch(`https://viacep.com.br/ws/${cleanCep}/json/`, {
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

  const prefix5 = cleanCep.slice(0, 5);
  const deliveryZoneSvc = createDeliveryZoneService();
  const match = await deliveryZoneSvc.findActiveByPrefix(prefix5, cleanCep);

  if (!match) {
    return {
      success: false,
      message: `Infelizmente não entregamos no CEP ${cleanCep} ainda. Consulte nosso cardápio para retirada no local.`,
    };
  }

  const feeReais = (match.feeInCentavos / 100).toFixed(2).replace(".", ",");
  return {
    success: true,
    cep: cleanCep,
    zoneName: match.name,
    feeInCentavos: match.feeInCentavos,
    estimatedMinutes: match.estimatedMinutes,
    message: `Entregamos em ${match.name}! Taxa: R$${feeReais}. Prazo estimado: ${match.estimatedMinutes} minutos.`,
  };
}

// ── Haversine-based fallback ──────────────────────────────────────────────────

async function estimateDeliveryByCoords(
  latitude: number,
  longitude: number,
): Promise<EstimateDeliveryOutput> {
  const deliveryZoneSvc = createDeliveryZoneService();
  const zones = await deliveryZoneSvc.findActiveWithCoords();

  type ZoneWithDistance = { zone: (typeof zones)[number]; distanceKm: number };
  const candidates: ZoneWithDistance[] = [];

  for (const zone of zones) {
    if (zone.centerLat === null || zone.centerLng === null || zone.radiusKm === null) continue;
    const distanceKm = haversineKm(
      latitude,
      longitude,
      Number(zone.centerLat),
      Number(zone.centerLng),
    );
    if (distanceKm <= zone.radiusKm) {
      candidates.push({ zone, distanceKm });
    }
  }

  if (candidates.length === 0) {
    return {
      success: false,
      message:
        "Sua localização não está na área de entrega. Consulte nosso cardápio para retirada no local.",
    };
  }

  candidates.sort((a, b) => a.distanceKm - b.distanceKm);
  const { zone: match } = candidates[0];

  const feeReais = (match.feeInCentavos / 100).toFixed(2).replace(".", ",");
  return {
    success: true,
    zoneName: match.name,
    feeInCentavos: match.feeInCentavos,
    estimatedMinutes: match.estimatedMinutes,
    message: `Entregamos em ${match.name}! Taxa: R$${feeReais}. Prazo estimado: ${match.estimatedMinutes} minutos.`,
  };
}

// ── Main handler ──────────────────────────────────────────────────────────────

export async function estimateDelivery(input: EstimateDeliveryInput): Promise<EstimateDeliveryOutput> {
  const hasCep = typeof input.cep === "string" && input.cep.trim().length > 0;
  const hasCoords =
    typeof input.latitude === "number" && typeof input.longitude === "number";

  if (!hasCep && !hasCoords) {
    return {
      success: false,
      message: "Informe um CEP ou compartilhe sua localização para estimar a entrega.",
    };
  }

  // CEP path: direct
  if (hasCep) {
    return estimateDeliveryByCep(input.cep!);
  }

  // Coords path: reverse geocode → CEP matching → Haversine fallback
  const { cep: geocodedCep } = await reverseGeocode(input.latitude!, input.longitude!);

  if (geocodedCep && CEP_RE.test(geocodedCep)) {
    const result = await estimateDeliveryByCep(geocodedCep);
    if (result.success) return result;
  }

  // Haversine fallback
  return estimateDeliveryByCoords(input.latitude!, input.longitude!);
}

// ── Tool definition ───────────────────────────────────────────────────────────

export const EstimateDeliveryTool = {
  name: "estimate_delivery",
  description:
    "Verifica se o endereço do cliente está na área de entrega e retorna a taxa e o prazo estimado. Aceita CEP ou coordenadas GPS (latitude/longitude).",
  inputSchema: {
    type: "object",
    properties: {
      cep: { type: "string", description: "CEP de entrega (somente dígitos ou com hífen)" },
      latitude: { type: "number", description: "Latitude da localização do cliente" },
      longitude: { type: "number", description: "Longitude da localização do cliente" },
    },
    required: [],
  },
} as const;
