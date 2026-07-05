// Tests for the admin schedule routes' cache-invalidation observability — BKL-124.
//
// The routes now invalidate the schedule cache via invalidateScheduleOrWarn:
//   - on success, the mutation returns normally and nothing is logged;
//   - on ULTIMATE failure (invalidateScheduleCache reports { ok: false } after its
//     own retry), the mutation STILL succeeds (a swallowed DEL must not fail the
//     admin write — the schedule-cache TTL now bounds the staleness), and a
//     structured WARN is logged so operators know the edit may take up to the TTL
//     to propagate.
//
// createScheduleService, @ibatexas/tools, and requireManagerRole are mocked so we
// exercise ONLY the route → invalidation → log wiring.

import { beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, {
  type FastifyInstance,
  type FastifyRequest,
  type FastifyReply,
  type FastifyBaseLogger,
} from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";

// ── Hoisted mocks ────────────────────────────────────────────────────────────
const mockUpsertDay = vi.hoisted(() => vi.fn());
const mockAddHoliday = vi.hoisted(() => vi.fn());
const mockRemoveHoliday = vi.hoisted(() => vi.fn());
const mockUpsertOverride = vi.hoisted(() => vi.fn());
const mockRemoveOverride = vi.hoisted(() => vi.fn());
const mockListOverrides = vi.hoisted(() => vi.fn());
const mockGetFullSchedule = vi.hoisted(() => vi.fn());

const mockInvalidateScheduleCache = vi.hoisted(() => vi.fn());

vi.mock("@ibatexas/domain", () => ({
  createScheduleService: () => ({
    upsertDay: mockUpsertDay,
    addHoliday: mockAddHoliday,
    removeHoliday: mockRemoveHoliday,
    upsertOverride: mockUpsertOverride,
    removeOverride: mockRemoveOverride,
    listOverrides: mockListOverrides,
    getFullSchedule: mockGetFullSchedule,
  }),
}));

vi.mock("@ibatexas/tools", () => ({
  invalidateScheduleCache: mockInvalidateScheduleCache,
}));

// requireManagerRole is proven elsewhere; here we let it pass through so we can
// focus on the invalidation-observability wiring of THIS file.
vi.mock("../../../middleware/staff-auth.js", () => ({
  requireManagerRole: (
    _request: FastifyRequest,
    _reply: FastifyReply,
    done: (err?: Error) => void,
  ) => done(),
}));

import { scheduleRoutes } from "../schedule.js";

// ── Capturing logger ─────────────────────────────────────────────────────────
// A minimal FastifyBaseLogger-shaped stub whose `child()` returns itself, so the
// per-request `request.log.warn` lands on our spy.
const warnSpy = vi.fn();
function makeCapturingLogger(): FastifyBaseLogger {
  const noop = vi.fn();
  const logger: Record<string, unknown> = {
    warn: warnSpy,
    info: noop,
    error: noop,
    debug: noop,
    fatal: noop,
    trace: noop,
    silent: noop,
    level: "info",
  };
  logger.child = () => logger;
  return logger as unknown as FastifyBaseLogger;
}

async function buildTestServer(): Promise<FastifyInstance> {
  const app = Fastify({ loggerInstance: makeCapturingLogger() });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(scheduleRoutes);
  await app.ready();
  return app;
}

const VALID_WEEKLY = {
  days: Array.from({ length: 7 }, (_, dayOfWeek) => ({
    dayOfWeek,
    isOpen: true,
    lunchStart: "11:00",
    lunchEnd: "15:00",
    dinnerStart: "18:00",
    dinnerEnd: "23:00",
  })),
};

beforeEach(() => {
  vi.clearAllMocks();
  // Default: invalidation succeeds.
  mockInvalidateScheduleCache.mockResolvedValue({ ok: true });
});

// ── PUT weekly ───────────────────────────────────────────────────────────────

describe("PUT /api/admin/schedule/weekly — cache invalidation", () => {
  it("persists the week, invalidates the cache, and does NOT warn on success", async () => {
    const app = await buildTestServer();
    const res = await app.inject({
      method: "PUT",
      url: "/api/admin/schedule/weekly",
      payload: VALID_WEEKLY,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(mockUpsertDay).toHaveBeenCalledTimes(7);
    expect(mockInvalidateScheduleCache).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalled();
    await app.close();
  });

  it("still returns 200 but logs a structured WARN when invalidation ultimately fails", async () => {
    mockInvalidateScheduleCache.mockResolvedValue({ ok: false });

    const app = await buildTestServer();
    const res = await app.inject({
      method: "PUT",
      url: "/api/admin/schedule/weekly",
      payload: VALID_WEEKLY,
    });

    // A swallowed DEL must NOT fail the admin write — the TTL bounds the staleness.
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "schedule_cache_invalidation_failed",
        cacheKey: "restaurant:schedule",
      }),
      expect.stringContaining("SCHEDULE_CACHE_TTL_SECONDS"),
    );
    await app.close();
  });
});

// ── POST holiday ───────────────────────────────────────────────────────────────

describe("POST /api/admin/schedule/holidays — cache invalidation", () => {
  it("adds the holiday (201), invalidates, and warns when invalidation fails", async () => {
    mockAddHoliday.mockResolvedValue({ id: "h1", date: "2026-07-09", label: "Feriado" });
    mockInvalidateScheduleCache.mockResolvedValue({ ok: false });

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/schedule/holidays",
      payload: { date: "2026-07-09", label: "Feriado" },
    });

    expect(res.statusCode).toBe(201);
    expect(mockInvalidateScheduleCache).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    await app.close();
  });
});

// ── PUT override ───────────────────────────────────────────────────────────────

describe("PUT /api/admin/schedule/overrides/:date — cache invalidation", () => {
  it("upserts the override (200), invalidates, and stays silent on success", async () => {
    mockUpsertOverride.mockResolvedValue({ date: "2026-07-09", isOpen: false, blocks: [] });

    const app = await buildTestServer();
    const res = await app.inject({
      method: "PUT",
      url: "/api/admin/schedule/overrides/2026-07-09",
      payload: { isOpen: false, blocks: [] },
    });

    expect(res.statusCode).toBe(200);
    expect(mockInvalidateScheduleCache).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalled();
    await app.close();
  });
});
