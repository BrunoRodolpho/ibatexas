// estimate_delivery tool
// Accepts a CEP OR GPS coordinates (latitude + longitude).
// For GPS: reverse geocodes to CEP → CEP prefix matching (primary).
//          If geocoding yields no CEP: Haversine distance against zones with centerLat/centerLng (fallback).
// Returns fee, estimated minutes and zone name, or an out-of-area message.

import { createDeliveryZoneService } from "@ibatexas/domain";
import { getRedisClient } from "../redis/client.js";
import { rk } from "../redis/key.js";
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

// ── Delivery zone cache ──────────────────────────────────────────────────────
// Caches per-CEP results in Redis (1h TTL). Most customers order from the same
// set of CEPs — this skips ViaCEP + DB lookups for known addresses.

const DELIVERY_CACHE_TTL = Number.parseInt(process.env.DELIVERY_CACHE_TTL || "3600", 10); // 1 hour

async function getCachedDeliveryResult(cep: string): Promise<EstimateDeliveryOutput | null> {
  try {
    const redis = await getRedisClient();
    const cached = await redis.get(rk(`delivery:cep:${cep}`));
    return cached ? JSON.parse(cached) as EstimateDeliveryOutput : null;
  } catch {
    return null; // Cache miss on error — fall through to live lookup
  }
}

async function cacheDeliveryResult(cep: string, result: EstimateDeliveryOutput): Promise<void> {
  try {
    const redis = await getRedisClient();
    await redis.set(rk(`delivery:cep:${cep}`), JSON.stringify(result), { EX: DELIVERY_CACHE_TTL });
  } catch {
    // Non-critical — next call will just miss cache
  }
}

/** Invalidate all delivery zone caches (call from admin zone update). */
export async function invalidateDeliveryCache(): Promise<void> {
  try {
    const redis = await getRedisClient();
    // Scan for delivery:cep:* keys and delete them
    const pattern = rk("delivery:cep:*");
    let cursor = 0;
    do {
      const result = await redis.scan(cursor, { MATCH: pattern, COUNT: 100 });
      cursor = result.cursor;
      if (result.keys.length > 0) {
        await redis.del(result.keys);
      }
    } while (cursor !== 0);
  } catch {
    // Best-effort cache invalidation
  }
}

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

  // Check cache first — skip ViaCEP + DB for known CEPs
  const cached = await getCachedDeliveryResult(cleanCep);
  if (cached) return cached;

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
    const phone = process.env.RESTAURANT_PHONE ?? "";
    const phoneHint = phone ? ` ou ligue ${phone}` : "";
    const outOfZone: EstimateDeliveryOutput = {
      success: false,
      cep: cleanCep,
      message: `Infelizmente não entregamos no CEP ${cleanCep} ainda. Você pode retirar no restaurante${phoneHint} ou tentar outro endereço.`,
    };
    void cacheDeliveryResult(cleanCep, outOfZone);
    return outOfZone;
  }

  const feeReais = (match.feeInCentavos / 100).toFixed(2).replace(".", ",");
  const result: EstimateDeliveryOutput = {
    success: true,
    cep: cleanCep,
    zoneName: match.name,
    feeInCentavos: match.feeInCentavos,
    estimatedMinutes: match.estimatedMinutes,
    message: `Entregamos em ${match.name}! Taxa: R$${feeReais}. Prazo estimado: ${match.estimatedMinutes} minutos.`,
  };
  void cacheDeliveryResult(cleanCep, result);
  return result;
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
    // No input — list active delivery zones so customer knows where we deliver
    const deliveryZoneSvc = createDeliveryZoneService();
    const zones = await deliveryZoneSvc.listAll();
    const activeZones = zones.filter((z) => z.active);
    if (activeZones.length === 0) {
      return { success: false, message: "No momento estamos apenas com retirada no restaurante." };
    }
    const zoneList = activeZones.map((z) => {
      const fee = (z.feeInCentavos / 100).toFixed(2).replace(".", ",");
      return `${z.name} — R$${fee} (~${z.estimatedMinutes}min)`;
    }).join("\n");
    return {
      success: true,
      message: `Áreas de entrega:\n${zoneList}\nInforme seu CEP para confirmar.`,
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
