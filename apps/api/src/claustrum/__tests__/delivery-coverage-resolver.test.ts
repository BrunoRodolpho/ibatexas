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

import { beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, {
  type FastifyInstance,
  type FastifyRequest,
  type FastifyReply,
} from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
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

/** The estimation tool's per-CEP cache, modelled as the real Redis one is: a
 *  key→result map that `invalidateDeliveryCache()` clears wholesale. */
const cepCache = vi.hoisted(() => new Map<string, unknown>());

const mockEstimateDelivery = vi.hoisted(() => vi.fn());
const mockInvalidateDeliveryCache = vi.hoisted(() =>
  vi.fn(async () => {
    // Byte-for-byte the real contract (estimate-delivery.ts): drop every
    // `delivery:cep:*` entry so the next lookup re-reads the zone rows.
    cepCache.clear();
  }),
);
const mockRedisSet = vi.hoisted(() => vi.fn(async () => "OK" as string | null));

vi.mock("@ibatexas/domain", () => ({
  createDeliveryZoneService: () => ({
    async listAll() {
      return zoneTable.rows.map((z) => ({ ...z }));
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

vi.mock("@ibatexas/tools", () => ({
  estimateDelivery: mockEstimateDelivery,
  invalidateDeliveryCache: mockInvalidateDeliveryCache,
  getRedisClient: async () => ({ set: mockRedisSet }),
  rk: (k: string) => `ibatexas:${k}`,
}));

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

/** Model the estimation tool over the CURRENT zone rows + the CURRENT cep cache —
 *  the same read-through shape estimate-delivery.ts has (cache first, then the
 *  prefix match), so an invalidation is observable exactly where it is in prod. */
function wireEstimateDeliveryOverZones(): void {
  mockEstimateDelivery.mockImplementation(async ({ cep }: { cep?: string }) => {
    const clean = (cep ?? "").replaceAll(/\D/g, "");
    const cached = cepCache.get(clean);
    if (cached !== undefined) return cached;
    const zone = zoneTable.rows.find(
      (z) => z.active && z.cepPrefixes.some((p) => clean.startsWith(p)),
    );
    const result =
      zone === undefined
        ? { success: false, cep: clean, message: "fora de área" }
        : {
            success: true,
            cep: clean,
            zoneName: zone.name,
            feeInCentavos: zone.feeInCentavos,
            estimatedMinutes: zone.estimatedMinutes,
            message: "ok",
          };
    cepCache.set(clean, result);
    return result;
  });
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
  cepCache.clear();
  seedZones();
  mockEstimateDelivery.mockReset();
  mockInvalidateDeliveryCache.mockClear();
  mockRedisSet.mockClear();
  mockRedisSet.mockResolvedValue("OK");
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
    expect(mockEstimateDelivery).not.toHaveBeenCalled();
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
    wireEstimateDeliveryOverZones();
    const out = await resolveDeliveryCoverage("c1", "entregam no CEP 14815000?");
    expect(mockEstimateDelivery).toHaveBeenCalledWith({ cep: "14815000" });
    expect(out.kind).toBe("covered");
    if (out.kind !== "covered") throw new Error("unreachable");
    expect(out.coverageText).toBe(
      "Sim, entregamos em Ibaté — taxa de R$ 15,00 e prazo estimado de cerca de 50 minutos",
    );
  });

  it("a CEP OUTSIDE every zone → not_covered (a VALIDATED negative, not an UNKNOWN)", async () => {
    wireEstimateDeliveryOverZones();
    const out = await resolveDeliveryCoverage("c2", "entregam no 01001-000?");
    expect(out).toEqual({
      kind: "not_covered",
      noCoverageText: "Ainda não entregamos no CEP 01001-000",
    });
  });

  it("an INVALID / unresolvable CEP (no echoed cep) → needs_cep, never not_covered", async () => {
    mockEstimateDelivery.mockResolvedValue({
      success: false,
      message: "CEP não encontrado. Verifique o número informado.",
    });
    expect(await resolveDeliveryCoverage("c3", "entregam no 99999999?")).toEqual({
      kind: "needs_cep",
    });
  });

  it("a THROWING estimation tool → unknown, NEVER not_covered (Inv 7)", async () => {
    mockEstimateDelivery.mockRejectedValue(new Error("viacep down"));
    expect(await resolveDeliveryCoverage("c4", "entregam no 14815000?")).toEqual({
      kind: "unknown",
    });
  });

  it("a success WITHOUT a zone name/fee (the tool's zone-LIST branch) → unknown", async () => {
    mockEstimateDelivery.mockResolvedValue({
      success: true,
      message: "Áreas de entrega: …",
    });
    expect(await resolveDeliveryCoverage("c5", "entregam no 14815000?")).toEqual({
      kind: "unknown",
    });
  });

  it("the CEP wins over a zone name in the same message (it is the precise datum)", async () => {
    wireEstimateDeliveryOverZones();
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
    wireEstimateDeliveryOverZones();

    // A first customer asks by CEP — the tool caches the R$ 15,00 answer.
    const before = await resolveDeliveryCoverage("seam-b-1", "entregam no 14815000?");
    if (before.kind !== "covered") throw new Error("unreachable");
    expect(before.feeInCentavos).toBe(1500);
    expect(cepCache.size).toBe(1);

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

    // The route fired the EXISTING invalidation, and it emptied the per-CEP cache.
    expect(mockInvalidateDeliveryCache).toHaveBeenCalledTimes(1);
    expect(cepCache.size).toBe(0);

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
