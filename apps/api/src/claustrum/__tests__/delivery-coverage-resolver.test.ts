// delivery-coverage-resolver.test.ts — LE2-002 / NEW-007, the RESOLVER half.
//
// This suite drives the REAL `delivery-coverage-resolver.ts` over mocked EXTERNALS
// (the zone projection + the estimation tool — the only two IO edges it has), and
// proves the four branches the ticket's honesty rules turn on:
//
//   1. Pure composers — the pt-BR scalars + the CEP/zone-name detectors. Money is
//      formatted from INTEGER CENTAVOS (Hard Rule 2); the model authors none of it.
//   2. Zone-NAME arm — the live "Ibaté" case grounds off the delivery-zones
//      projection; an unrecognised place NEVER nearest-neighbours onto a zone.
//   3. CEP arm — routes THROUGH the existing estimation tool; a proven
//      outside-every-zone result is a FACT (`not_covered`), while an
//      invalid/unresolvable CEP is NOT (`needs_cep`), and a THROW is NOT (Inv 7:
//      "could not check" is never "we don't deliver").
//   4. The CACHE-INVALIDATION seam — an admin zone edit shows up in the very next
//      chat answer, on BOTH arms: the zone-NAME arm reads the projection live, and
//      the CEP arm is freed by the admin route's `invalidateDeliveryCache()`.
//
// The turn-seam / claim / render half lives in the sibling
// `delivery-coverage-claim.test.ts`.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, {
  type FastifyInstance,
  type FastifyRequest,
  type FastifyReply,
} from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import type { InMemoryRedis } from "@ibatexas/tools/testing";
import { rk } from "@ibatexas/tools";
import { deliveryZoneRoutes } from "../../routes/admin/delivery-zones.js";
import {
  clearDeliveryCoverageMemoForTests,
  composeDeliveryCoverageText,
  composeDeliveryNoCoverageText,
  detectCepInText,
  formatCentavosBRL,
  formatCepForDisplay,
  matchZoneByName,
  resolveDeliveryCoverage,
} from "../delivery-coverage-resolver.js";

// ── The two IO edges, mocked at the seam ─────────────────────────────────────
//
// A MUTABLE zone table stands in for the delivery-zones projection so an admin
// edit and a chat read observe the SAME rows (that shared identity is the whole
// point of the invalidation seam test at the bottom).

interface FakeZone {
  id: string;
  name: string;
  cepPrefixes: string[];
  feeInCentavos: number;
  estimatedMinutes: number;
  active: boolean;
}

const zoneTable = vi.hoisted(() => ({ rows: [] as FakeZone[] }));

/**
 * R5-S6 — the per-CEP cache is now REAL.
 *
 * This suite used to hand-write the cache it was testing: a `cepCache` Map, an
 * `invalidateDeliveryCache` stub whose whole body was `cepCache.clear()` (with a
 * comment claiming it was "byte-for-byte the real contract"), an
 * `estimateDelivery` stub that re-implemented the read-through, and
 * `rk: (k) => `ibatexas:${k}`` — a prefix production has never written, since the
 * real `rk()` emits `${APP_ENV}:`. Branch (4) below is the suite's reason to
 * exist, and none of the code it names ever ran: a wrong SCAN pattern, a broken
 * cursor loop, or a changed key prefix were all invisible.
 *
 * Now the REAL `estimateDelivery` and the REAL `invalidateDeliveryCache` run,
 * over the canonical in-memory adapter from `@ibatexas/tools/testing`. `rk()`
 * runs real, so every key below is the one production writes.
 */
const redisHolder = vi.hoisted(() => ({ current: null as InMemoryRedis | null }));

/** The adapter, once the mock factory has built it. */
function redis(): InMemoryRedis {
  if (redisHolder.current === null) throw new Error("in-memory redis not initialised");
  return redisHolder.current;
}

vi.mock("@ibatexas/domain", () => ({
  createDeliveryZoneService: () => ({
    async listAll() {
      return zoneTable.rows.map((z) => ({ ...z }));
    },
    /** The lookup the REAL estimateDelivery makes on its CEP arm. */
    async findActiveByPrefix(prefix5: string, _fullCep: string) {
      const row = zoneTable.rows.find(
        (z) => z.active && z.cepPrefixes.includes(prefix5),
      );
      return row === undefined ? null : { ...row };
    },
    async findActiveWithCoords() {
      return [];
    },
    async update(id: string, data: Partial<FakeZone>) {
      const row = zoneTable.rows.find((z) => z.id === id);
      if (row === undefined) throw new Error("no such zone");
      Object.assign(row, data);
      return { ...row };
    },
    async create(data: FakeZone) {
      zoneTable.rows.push({ ...data });
      return { ...data };
    },
    async remove(id: string) {
      zoneTable.rows = zoneTable.rows.filter((z) => z.id !== id);
    },
  }),
}));

// Spies that OBSERVE the two entry points. Their default implementation (re-armed
// in `beforeEach`) is the REAL function bound to the adapter; a handful of cases
// below override one deliberately, and say why.
const estimateSpy = vi.hoisted(() => vi.fn());
const invalidateSpy = vi.hoisted(() => vi.fn());
/** Filled by the mock factory with the real functions, client already injected. */
const bound = vi.hoisted(() => ({
  estimate: null as null | ((input: unknown) => Promise<unknown>),
  invalidate: null as null | (() => Promise<void>),
}));

// The ONLY substitution is the Redis client. Every other export — including the
// logic of the two functions under test and `rk` — is the real one.
vi.mock("@ibatexas/tools", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ibatexas/tools")>();
  const { createInMemoryRedis } = await import("@ibatexas/tools/testing");
  redisHolder.current = createInMemoryRedis();
  const client = () => redisHolder.current!.client;
  bound.estimate = (input) =>
    actual.estimateDelivery(
      input as Parameters<typeof actual.estimateDelivery>[0],
      { client: client() },
    );
  bound.invalidate = () => actual.invalidateDeliveryCache({ client: client() });
  return {
    ...actual,
    // The admin route's dedup SET lands in the SAME keyspace the invalidation
    // scans — so a MATCH pattern that over-reaches would now delete it.
    getRedisClient: async () => client(),
    estimateDelivery: estimateSpy,
    invalidateDeliveryCache: invalidateSpy,
  };
});

// The admin route's manager gate is proven by escalations-authz.test.ts; here it
// passes through so the seam under test is the CACHE one, not the auth one.
vi.mock("../../middleware/staff-auth.js", () => ({
  requireManagerRole: (
    _request: FastifyRequest,
    _reply: FastifyReply,
    done: (err?: Error) => void,
  ) => done(),
}));

// The four SEEDED zones (packages/domain/src/seed-delivery.ts, verbatim) — so the
// live "Ibaté" case below is the REAL row, not a convenient fixture.
const SEED_ZONES: FakeZone[] = [
  {
    id: "z-arq-centro",
    name: "Araraquara Centro",
    cepPrefixes: ["14800", "14801"],
    feeInCentavos: 800,
    estimatedMinutes: 30,
    active: true,
  },
  {
    id: "z-ibate",
    name: "Ibaté",
    cepPrefixes: ["14815"],
    feeInCentavos: 1500,
    estimatedMinutes: 50,
    active: true,
  },
  {
    id: "z-sao-carlos",
    name: "São Carlos",
    cepPrefixes: ["13560", "13561"],
    feeInCentavos: 2500,
    estimatedMinutes: 75,
    active: true,
  },
];

function seedZones(over: readonly Partial<FakeZone>[] = []): void {
  zoneTable.rows = SEED_ZONES.map((z, i) => ({ ...z, ...(over[i] ?? {}) }));
}

/** Keys the REAL estimateDelivery caches its per-CEP answers under. */
function cachedCepKeys(): string[] {
  return redis()
    .keys()
    .filter((k) => k.startsWith(rk("delivery:cep:")));
}

async function buildAdminServer(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(deliveryZoneRoutes);
  await app.ready();
  return app;
}

beforeEach(() => {
  clearDeliveryCoverageMemoForTests();
  redis().flush();
  seedZones();
  // Re-arm both spies to the REAL implementation. Overriding is opt-in per case.
  estimateSpy.mockReset();
  estimateSpy.mockImplementation((input: unknown) => bound.estimate!(input));
  invalidateSpy.mockReset();
  invalidateSpy.mockImplementation(() => bound.invalidate!());
  // The REAL estimateDelivery probes ViaCEP before matching a prefix. Stub it
  // "CEP exists" so the branch under test is the ZONE decision, never network
  // reachability (a real fetch here would also violate the no-network rule).
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ cep: "00000-000" }), { status: 200 })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── (1) Pure composers ────────────────────────────────────────────────────────

describe("LE2-002 — pt-BR money + CEP formatting (Hard Rule 2)", () => {
  it("formats integer centavos as R$ XX,XX — never a float", () => {
    expect(formatCentavosBRL(1500)).toBe("R$ 15,00");
    expect(formatCentavosBRL(800)).toBe("R$ 8,00");
    expect(formatCentavosBRL(2550)).toBe("R$ 25,50");
    expect(formatCentavosBRL(5)).toBe("R$ 0,05");
    expect(formatCentavosBRL(0)).toBe("R$ 0,00");
  });

  it("composes the grounded-yes scalar from the zone row's own numbers", () => {
    expect(
      composeDeliveryCoverageText({
        zoneName: "Ibaté",
        feeInCentavos: 1500,
        estimatedMinutes: 50,
      }),
    ).toBe(
      "Sim, entregamos em Ibaté — taxa de R$ 15,00 e prazo estimado de cerca de 50 minutos",
    );
  });

  it("composes the honest-no scalar narrowly — about THAT CEP, never about a region", () => {
    expect(composeDeliveryNoCoverageText("01001000")).toBe(
      "Ainda não entregamos no CEP 01001-000",
    );
  });

  it("formats a CEP for display and leaves a malformed one alone", () => {
    expect(formatCepForDisplay("14815000")).toBe("14815-000");
    expect(formatCepForDisplay("14815-000")).toBe("14815-000");
    expect(formatCepForDisplay("148")).toBe("148");
  });
});

describe("LE2-002 — detectCepInText (never guesses which CEP)", () => {
  it("reads the two forms a customer actually types", () => {
    expect(detectCepInText("entregam no 14815000?")).toBe("14815000");
    expect(detectCepInText("meu cep é 14815-000")).toBe("14815000");
  });

  it("does not match a CEP-shaped run INSIDE a longer digit run", () => {
    expect(detectCepInText("pedido 148150001")).toBeUndefined();
    expect(detectCepInText("telefone 5519900000001")).toBeUndefined();
  });

  it("returns undefined for ZERO CEPs and for TWO DISTINCT ones (asks, never picks)", () => {
    expect(detectCepInText("vocês entregam em Ibaté?")).toBeUndefined();
    expect(detectCepInText("é 14815000 ou 13560000?")).toBeUndefined();
    // The SAME cep repeated is not an ambiguity.
    expect(detectCepInText("14815000, isso, 14815-000")).toBe("14815000");
  });
});

describe("LE2-002 — matchZoneByName (the resolver's no-guessing wall)", () => {
  it("matches a zone name accent- and case-insensitively (the live Ibaté case)", () => {
    expect(matchZoneByName(SEED_ZONES, "vocês entregam em Ibaté?")?.name).toBe("Ibaté");
    expect(matchZoneByName(SEED_ZONES, "voces entregam em ibate?")?.name).toBe("Ibaté");
    expect(matchZoneByName(SEED_ZONES, "fazem entrega pra SAO CARLOS?")?.name).toBe(
      "São Carlos",
    );
  });

  it("matches only WHOLE token runs — never a substring of a longer word", () => {
    expect(matchZoneByName(SEED_ZONES, "vocês entregam em Ibatezinho?")).toBeUndefined();
  });

  it("an unrecognised place matches NOTHING — no nearest-neighbour guess", () => {
    expect(matchZoneByName(SEED_ZONES, "vocês entregam em Matão?")).toBeUndefined();
    expect(matchZoneByName(SEED_ZONES, "vocês entregam?")).toBeUndefined();
  });

  it("an INACTIVE zone never matches (a disabled zone is not coverage)", () => {
    const inactive = SEED_ZONES.map((z) =>
      z.name === "Ibaté" ? { ...z, active: false } : z,
    );
    expect(matchZoneByName(inactive, "vocês entregam em Ibaté?")).toBeUndefined();
  });

  it("TWO unrelated named zones is an ambiguity → undefined (never picks one)", () => {
    expect(
      matchZoneByName(SEED_ZONES, "entregam em Ibaté e em São Carlos?"),
    ).toBeUndefined();
  });

  it("a LONGER name SUBSUMES the shorter one it contains (not an ambiguity)", () => {
    const nested: FakeZone[] = [
      { ...SEED_ZONES[0]!, id: "z-a", name: "Araraquara" },
      { ...SEED_ZONES[0]!, id: "z-b", name: "Araraquara Centro", feeInCentavos: 800 },
    ];
    expect(matchZoneByName(nested, "entregam em Araraquara Centro?")?.name).toBe(
      "Araraquara Centro",
    );
  });
});

// ── (2) Zone-NAME arm ─────────────────────────────────────────────────────────

describe("LE2-002 — resolver, zone-NAME arm (over the delivery-zones projection)", () => {
  it("the live 'Ibaté' case → covered, with the seed row's own fee + ETA", async () => {
    const out = await resolveDeliveryCoverage("t1", "vocês entregam em Ibaté?");
    expect(out.kind).toBe("covered");
    if (out.kind !== "covered") throw new Error("unreachable");
    expect(out.zoneName).toBe("Ibaté");
    expect(out.feeInCentavos).toBe(1500);
    expect(out.estimatedMinutes).toBe(50);
    expect(out.coverageText).toBe(
      "Sim, entregamos em Ibaté — taxa de R$ 15,00 e prazo estimado de cerca de 50 minutos",
    );
    // The zone-name arm never touches the estimation tool (no CEP to estimate).
    expect(estimateSpy).not.toHaveBeenCalled();
    // …and therefore caches nothing.
    expect(cachedCepKeys()).toEqual([]);
  });

  it("an UNRECOGNISED place → needs_cep (asks), never a nearby zone", async () => {
    const out = await resolveDeliveryCoverage("t2", "vocês entregam em Matão?");
    expect(out).toEqual({ kind: "needs_cep" });
  });

  it("a BARE coverage question (no place at all) → needs_cep", async () => {
    expect(await resolveDeliveryCoverage("t3", "vocês fazem entrega?")).toEqual({
      kind: "needs_cep",
    });
  });

  it("an UNREADABLE projection → unknown, NEVER not_covered (Inv 7)", async () => {
    const original = zoneTable.rows;
    Object.defineProperty(zoneTable, "rows", {
      get() {
        throw new Error("db down");
      },
      configurable: true,
    });
    try {
      expect(await resolveDeliveryCoverage("t4", "vocês entregam em Ibaté?")).toEqual({
        kind: "unknown",
      });
    } finally {
      Object.defineProperty(zoneTable, "rows", {
        value: original,
        writable: true,
        configurable: true,
      });
    }
  });

  it("a CORRUPT zone row (non-integer fee) → unknown, never a rendered price", async () => {
    zoneTable.rows = [
      { ...SEED_ZONES[1]!, feeInCentavos: 15.5 },
    ];
    expect(await resolveDeliveryCoverage("t5", "vocês entregam em Ibaté?")).toEqual({
      kind: "unknown",
    });
  });

  it("memoizes per (turnId, text) so the investigator and the planner read ONCE", async () => {
    const a = await resolveDeliveryCoverage("t6", "vocês entregam em Ibaté?");
    const b = await resolveDeliveryCoverage("t6", "vocês entregam em Ibaté?");
    // Byte-equal scalars are what make the kernel's C6 pass by construction.
    expect(a).toEqual(b);
    // A DIFFERENT turn is a different memo entry (never leaks across turns).
    zoneTable.rows = [{ ...SEED_ZONES[1]!, feeInCentavos: 1900 }];
    const c = await resolveDeliveryCoverage("t7", "vocês entregam em Ibaté?");
    if (c.kind !== "covered") throw new Error("unreachable");
    expect(c.feeInCentavos).toBe(1900);
  });
});

// ── (3) CEP arm (THROUGH the existing estimation tool) ────────────────────────

describe("LE2-002 — resolver, CEP arm (through the existing estimation tool)", () => {
  it("a CEP inside a zone → covered, with the tool's fee + ETA", async () => {
    const out = await resolveDeliveryCoverage("c1", "entregam no CEP 14815000?");
    expect(estimateSpy).toHaveBeenCalledWith({ cep: "14815000" });
    expect(out.kind).toBe("covered");
    if (out.kind !== "covered") throw new Error("unreachable");
    expect(out.coverageText).toBe(
      "Sim, entregamos em Ibaté — taxa de R$ 15,00 e prazo estimado de cerca de 50 minutos",
    );
  });

  it("a CEP OUTSIDE every zone → not_covered (a VALIDATED negative, not an UNKNOWN)", async () => {
    const out = await resolveDeliveryCoverage("c2", "entregam no 01001-000?");
    expect(out).toEqual({
      kind: "not_covered",
      noCoverageText: "Ainda não entregamos no CEP 01001-000",
    });
  });

  it("an INVALID / unresolvable CEP (no echoed cep) → needs_cep, never not_covered", async () => {
    // Driven through the REAL tool: ViaCEP reporting the CEP does not exist is
    // exactly what makes it return a success:false with NO echoed `cep`.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ erro: true }), { status: 200 })),
    );
    expect(await resolveDeliveryCoverage("c3", "entregam no 99999999?")).toEqual({
      kind: "needs_cep",
    });
    // An unresolvable CEP must NOT be cached — the next lookup has to re-ask.
    expect(cachedCepKeys()).toEqual([]);
  });

  it("a THROWING estimation tool → unknown, NEVER not_covered (Inv 7)", async () => {
    // The throw comes from the REAL tool's own zone lookup, not from a stub.
    const original = zoneTable.rows;
    Object.defineProperty(zoneTable, "rows", {
      get() {
        throw new Error("db down");
      },
      configurable: true,
    });
    try {
      expect(await resolveDeliveryCoverage("c4", "entregam no 14815000?")).toEqual({
        kind: "unknown",
      });
    } finally {
      Object.defineProperty(zoneTable, "rows", {
        value: original,
        writable: true,
        configurable: true,
      });
    }
  });

  it("a success WITHOUT a zone name/fee (the tool's zone-LIST branch) → unknown", async () => {
    // The one case that CANNOT be driven through the real tool: the zone-LIST
    // shape is only returned for a call with NO cep, and the resolver always
    // passes one. This stays a deliberate boundary stub — it pins the RESOLVER's
    // defensive handling of a success it cannot render, not the tool's output.
    estimateSpy.mockResolvedValue({
      success: true,
      message: "Áreas de entrega: …",
    });
    expect(await resolveDeliveryCoverage("c5", "entregam no 14815000?")).toEqual({
      kind: "unknown",
    });
  });

  it("the CEP wins over a zone name in the same message (it is the precise datum)", async () => {
    const out = await resolveDeliveryCoverage(
      "c6",
      "moro em Ibaté, o CEP é 01001000, entregam?",
    );
    // The CEP resolves OUTSIDE every zone — the honest answer, even though the
    // message also names a covered zone. Precise beats approximate; never both.
    expect(out.kind).toBe("not_covered");
  });
});

// ── (4) The admin-edit → chat-answer seam (existing cache invalidation) ───────

describe("LE2-002 — an admin zone edit reflects in the next chat answer", () => {
  it("zone-NAME arm: the edited fee/ETA appears immediately (live projection read)", async () => {
    // Before: the seeded Ibaté row.
    const before = await resolveDeliveryCoverage("seam-a-1", "entregam em Ibaté?");
    if (before.kind !== "covered") throw new Error("unreachable");
    expect(before.feeInCentavos).toBe(1500);

    // The admin raises the fee and the ETA through the REAL route handler.
    const app = await buildAdminServer();
    const res = await app.inject({
      method: "PUT",
      url: "/api/admin/delivery-zones/z-ibate",
      headers: { "x-request-id": "req-seam-a" },
      payload: {
        name: "Ibaté",
        cepPrefixes: ["14815"],
        feeInCentavos: 1900,
        estimatedMinutes: 60,
        active: true,
      },
    });
    expect(res.statusCode).toBe(200);
    await app.close();

    // The NEXT turn (a new turnId — the memo never spans turns) sees the edit.
    const after = await resolveDeliveryCoverage("seam-a-2", "entregam em Ibaté?");
    if (after.kind !== "covered") throw new Error("unreachable");
    expect(after.feeInCentavos).toBe(1900);
    expect(after.coverageText).toBe(
      "Sim, entregamos em Ibaté — taxa de R$ 19,00 e prazo estimado de cerca de 60 minutos",
    );
  });

  it("CEP arm: the route's invalidateDeliveryCache() drops the stale per-CEP entry", async () => {
    // A first customer asks by CEP — the tool caches the R$ 15,00 answer under
    // the key the REAL rk() builds.
    const before = await resolveDeliveryCoverage("seam-b-1", "entregam no 14815000?");
    if (before.kind !== "covered") throw new Error("unreachable");
    expect(before.feeInCentavos).toBe(1500);
    await vi.waitFor(() =>
      expect(cachedCepKeys()).toEqual([rk("delivery:cep:14815000")]),
    );

    // The admin raises the fee. WITHOUT the invalidation the cached R$ 15,00 would
    // survive and the next customer would be quoted a stale price.
    const app = await buildAdminServer();
    const res = await app.inject({
      method: "PUT",
      url: "/api/admin/delivery-zones/z-ibate",
      headers: { "x-request-id": "req-seam-b" },
      payload: {
        name: "Ibaté",
        cepPrefixes: ["14815"],
        feeInCentavos: 1900,
        estimatedMinutes: 60,
        active: true,
      },
    });
    expect(res.statusCode).toBe(200);
    await app.close();

    // The route fired the EXISTING invalidation, and the REAL scan-and-delete
    // emptied the per-CEP cache.
    expect(invalidateSpy).toHaveBeenCalledTimes(1);
    expect(cachedCepKeys()).toEqual([]);
    // …and it deleted ONLY the delivery keys: the route's own dedup key, written
    // through the same real rk() into the same keyspace, survives. That is what
    // makes the SCAN's MATCH pattern load-bearing rather than decorative.
    expect(redis().keys()).toContain(rk("dz:update:dedup:req-seam-b"));

    // …so the next turn's CEP answer carries the NEW fee + ETA.
    const after = await resolveDeliveryCoverage("seam-b-2", "entregam no 14815000?");
    if (after.kind !== "covered") throw new Error("unreachable");
    expect(after.feeInCentavos).toBe(1900);
    expect(after.estimatedMinutes).toBe(60);
  });

  it("DEACTIVATING a zone flips the next chat answer off the name arm (no stale yes)", async () => {
    const before = await resolveDeliveryCoverage("seam-c-1", "entregam em Ibaté?");
    expect(before.kind).toBe("covered");

    const app = await buildAdminServer();
    const res = await app.inject({
      method: "PUT",
      url: "/api/admin/delivery-zones/z-ibate",
      headers: { "x-request-id": "req-seam-c" },
      payload: {
        name: "Ibaté",
        cepPrefixes: ["14815"],
        feeInCentavos: 1500,
        estimatedMinutes: 50,
        active: false,
      },
    });
    expect(res.statusCode).toBe(200);
    await app.close();

    // An inactive zone is NOT coverage — and the resolver asks rather than
    // asserting a negative it cannot prove from a name alone.
    expect(await resolveDeliveryCoverage("seam-c-2", "entregam em Ibaté?")).toEqual({
      kind: "needs_cep",
    });
  });
});
