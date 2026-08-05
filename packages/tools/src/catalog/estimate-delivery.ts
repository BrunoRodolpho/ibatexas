// estimate_delivery tool
// Accepts a CEP OR GPS coordinates (latitude + longitude).
// For GPS: reverse geocodes to CEP → CEP prefix matching (primary).
//          If geocoding yields no CEP: Haversine distance against zones with centerLat/centerLng (fallback).
// Returns fee, estimated minutes and zone name, or an out-of-area message.

import { createDeliveryZoneService } from "@ibatexas/domain";
import { getRedisClient, type RedisClientType } from "../redis/client.js";
import { rk } from "../redis/key.js";
import { reverseGeocode } from "./reverse-geocode.js";

// ── The Redis client seam (R5-S6) ────────────────────────────────────────────

/**
 * The Redis-shaped client the per-CEP READ-THROUGH cache runs on.
 *
 * The command set is EXHAUSTIVE and deliberately narrow: `get` + `set` are the
 * per-CEP read-through cache, `scan` + `del` are {@link invalidateDeliveryCache}.
 * Nothing else in this file touches Redis. Widen it only by adding a command the
 * module genuinely issues — the narrowness is what lets a test double cover the
 * whole surface instead of guessing, and what makes a client that cannot serve
 * this module a compile error rather than a runtime `TypeError`.
 *
 * Typed as `Pick<RedisClientType, …>` on purpose: the call sites keep node-redis'
 * exact argument types, so a wrong `set` option or a mis-shaped `scan` still
 * fails `tsc`. A test double casts to this type at its own boundary (see
 * `src/testing/in-memory-redis.ts`) rather than this module loosening its types
 * to accommodate one.
 *
 * NOTE (F-42): this is the union across BOTH entry points, and `estimateDelivery`
 * — its only remaining consumer — issues only `get` + `set`. It therefore
 * OVER-demands by two commands. That direction is fail-CLOSED: over-demanding
 * can only reject a usable client at compile time, never silently drop a command
 * at runtime. Narrowing it to `{get, set}` is a separate change and is NOT part
 * of F-42, which is about the opposite (fail-OPEN) direction below.
 */
export type DeliveryCacheClient = Pick<RedisClientType, "get" | "set" | "scan" | "del">;

/**
 * The Redis-shaped client {@link invalidateDeliveryCache} — and ONLY it — runs on.
 *
 * ── THE FAIL-CLOSED PICK ANALYSIS (the #539 / #543 / #548 rule), re-derived by
 * reading every line of `invalidateDeliveryCache` ────────────────────────────
 *
 *   • ISSUED: `scan` (the manual cursor loop, NOT `scanIterator`) and `del`.
 *     Those two, nothing else. `set` belongs to `cacheDeliveryResult` and `get`
 *     to `getCachedDeliveryResult` — both on the `estimateDelivery` path, which
 *     this function never enters.
 *   • HANDED TO downstream: nothing. The client is bound to a function-local
 *     `const` and both commands are issued on it directly, so no callee can
 *     issue a command this Pick does not name. `rk` is a pure key builder and
 *     takes no client.
 *   • FEATURE DETECTION: none — no `typeof client.X === "function"` probe, which
 *     is what makes a throw-on-access Proxy client safe here (F-22).
 *   • LUA: none. No `eval` / `evalSha` / `multi` in the body or through a
 *     hand-off, so the in-memory adapter can serve this function whole.
 *
 * So {issued} ∪ {handed-to} = `{"scan", "del"}`.
 *
 * Split out of {@link DeliveryCacheClient} by F-42 for one reason: this function
 * is the one a mutating ADMIN route calls, so its Pick is what that route's own
 * Pick must absorb. Making the route declare `get` + `set` — commands nothing on
 * the invalidation path issues — would falsify the route's "EXHAUSTIVE union of
 * commands this route issues" contract to buy nothing.
 */
export type DeliveryCacheInvalidationClient = Pick<RedisClientType, "scan" | "del">;

/**
 * Options accepted by this module's two exported entry points.
 *
 * NARROWING (the R5-S1 rule): only the code paths that actually reach Redis take
 * this bag. `estimateDeliveryByCoords` — the Haversine fallback arm — reads the
 * zone rows and caches NOTHING, so it takes no options at all; a client handed to
 * it could only be silently dropped, and the way to prevent a silent drop is to
 * make it unrepresentable. Likewise the Prisma-side dependency
 * (`createDeliveryZoneService`) is NOT reachable through this bag: that is
 * R5-S1's seam on `@ibatexas/domain`, and conflating the two would let a caller
 * think it had substituted a store it had not.
 */
export interface DeliveryCacheOptions {
  /**
   * Redis-shaped client the per-CEP cache runs on. Defaults to the package
   * singleton (`getRedisClient()`), resolved lazily at the SAME point in the
   * SAME try/catch it always was — so every production call site stays a bare
   * `estimateDelivery({ cep })` / `invalidateDeliveryCache()`, and a Redis
   * outage still degrades exactly as before instead of throwing earlier.
   */
  readonly client?: DeliveryCacheClient;
}

/**
 * Options accepted by {@link invalidateDeliveryCache}.
 *
 * A SEPARATE bag from {@link DeliveryCacheOptions}, carrying the honest
 * {@link DeliveryCacheInvalidationClient} rather than the union across both
 * entry points. This is the whole point of F-42: `invalidateDeliveryCache`'s
 * body is a bare try/catch with an empty, best-effort handler, so a client
 * missing `scan` does not fail — the `TypeError` is absorbed and the cache is
 * simply never invalidated, with every suite green while a zone edit silently
 * stops showing up in chat. The defence has to be the TYPE, because there is no
 * runtime signal at all. Demanding exactly `{scan, del}` is what makes a
 * caller-derived client that cannot serve this function a COMPILE error.
 */
export interface DeliveryCacheInvalidationOptions {
  /**
   * Redis-shaped client the invalidation SCAN + DEL run on. Defaults to the
   * package singleton (`getRedisClient()`), resolved lazily inside the same
   * try/catch it always was — so any caller that has no client to thread stays
   * a bare `invalidateDeliveryCache()` and degrades exactly as before.
   */
  readonly client?: DeliveryCacheInvalidationClient;
}

/**
 * Resolve the client for one Redis touch: the injected one, or the singleton.
 *
 * Deliberately NOT hoisted to the entry points. Resolving eagerly would call
 * `getRedisClient()` on the coords arm and on the zone-listing arm, which reach
 * Redis never — turning a Redis outage into a throw on paths that today answer
 * fine. Each call site below keeps its own resolution inside its own try/catch.
 */
async function resolveCacheClient(
  options?: DeliveryCacheOptions,
): Promise<DeliveryCacheClient> {
  return options?.client ?? (await getRedisClient());
}

/**
 * The {@link resolveCacheClient} twin for the invalidation path, returning the
 * narrower {@link DeliveryCacheInvalidationClient}. Written out rather than
 * generalised so each path's return type states its own honest Pick — a shared
 * generic would let either path widen without the other noticing.
 */
async function resolveInvalidationClient(
  options?: DeliveryCacheInvalidationOptions,
): Promise<DeliveryCacheInvalidationClient> {
  return options?.client ?? (await getRedisClient());
}

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

async function getCachedDeliveryResult(
  cep: string,
  options?: DeliveryCacheOptions,
): Promise<EstimateDeliveryOutput | null> {
  try {
    const redis = await resolveCacheClient(options);
    const cached = await redis.get(rk(`delivery:cep:${cep}`));
    return cached ? JSON.parse(cached) as EstimateDeliveryOutput : null;
  } catch {
    return null; // Cache miss on error — fall through to live lookup
  }
}

async function cacheDeliveryResult(
  cep: string,
  result: EstimateDeliveryOutput,
  options?: DeliveryCacheOptions,
): Promise<void> {
  try {
    const redis = await resolveCacheClient(options);
    await redis.set(rk(`delivery:cep:${cep}`), JSON.stringify(result), { EX: DELIVERY_CACHE_TTL });
  } catch {
    // Non-critical — next call will just miss cache
  }
}

/**
 * Invalidate all delivery zone caches (call from admin zone update).
 *
 * Takes {@link DeliveryCacheInvalidationOptions} — the honest `{scan, del}`
 * Pick — NOT the wider {@link DeliveryCacheOptions}. See that type's docblock
 * for why the narrower bag is the safety property and not a tidying-up.
 */
export async function invalidateDeliveryCache(
  options?: DeliveryCacheInvalidationOptions,
): Promise<void> {
  try {
    const redis = await resolveInvalidationClient(options);
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
    // Best-effort cache invalidation.
    //
    // F-42 read this handler and left it SILENT deliberately. Every fail-soft
    // Redis path in this file (`getCachedDeliveryResult`, `cacheDeliveryResult`)
    // swallows the same way, and the module imports no logger at all — so a
    // loud log here would not be following the file's pattern, it would be
    // introducing one. Recorded rather than expanded: the shape that made this
    // handler dangerous (a caller-derived client silently missing `scan`) is
    // now a COMPILE error via `DeliveryCacheInvalidationOptions`, which is a
    // stronger defence than a log nobody reads.
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

async function estimateDeliveryByCep(
  cep: string,
  options?: DeliveryCacheOptions,
): Promise<EstimateDeliveryOutput> {
  const cleanCep = cep.replaceAll(/\D/g, "");

  if (!CEP_RE.test(cleanCep)) {
    return { success: false, message: "CEP inválido. Informe 8 dígitos numéricos." };
  }

  // Check cache first — skip ViaCEP + DB for known CEPs
  const cached = await getCachedDeliveryResult(cleanCep, options);
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
    void cacheDeliveryResult(cleanCep, outOfZone, options);
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
  void cacheDeliveryResult(cleanCep, result, options);
  return result;
}

// ── Haversine-based fallback ──────────────────────────────────────────────────

/**
 * The NARROWED arm: reads the zone rows and caches nothing, so it takes no
 * {@link DeliveryCacheOptions}. Keeping the bag off this signature is what stops
 * a future caller from passing a client here and believing it took effect.
 */
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

export async function estimateDelivery(
  input: EstimateDeliveryInput,
  options?: DeliveryCacheOptions,
): Promise<EstimateDeliveryOutput> {
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
    return estimateDeliveryByCep(input.cep!, options);
  }

  // Coords path: reverse geocode → CEP matching → Haversine fallback
  const { cep: geocodedCep } = await reverseGeocode(input.latitude!, input.longitude!);

  if (geocodedCep && CEP_RE.test(geocodedCep)) {
    const result = await estimateDeliveryByCep(geocodedCep, options);
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
