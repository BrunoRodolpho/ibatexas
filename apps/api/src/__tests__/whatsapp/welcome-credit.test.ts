// Unit tests for welcome credit helpers in whatsapp/session.ts
//
// LE2-018 retired the `BEMVINDO15` literal that used to live in session.ts.
// The code is now the declared external reference `promotion.welcome-credit`,
// read from WELCOME_CREDIT_COUPON_CODE — so these tests stub the variable and
// assert the granted code TRACKS CONFIG rather than a constant. The value below
// is deliberately not the production one: a test that hardcoded BEMVINDO15
// would pass just as well against a function that ignored config entirely,
// which is the exact regression this ticket exists to prevent.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { setWelcomeCredit, getAndConsumeWelcomeCredit } from "../../whatsapp/session.js";

// ── Hoisted mocks ──────────────────────────────────────────────────────────────

const mockRedis = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  del: vi.fn(),
  getDel: vi.fn(),
}));

const TEST_COUPON = "CONFIGURED_WELCOME_CODE";

// `@ibatexas/tools` is mocked wholesale here (importActual would drag the whole
// barrel through the partial `@ibatexas/types` mock below), so the reference
// resolver is a faithful stand-in rather than the real function: it reads the
// same variable and throws the same way when it is unset. What that stub cannot
// prove — that `promotion.welcome-credit` is really declared, and really sourced
// from WELCOME_CREDIT_COUPON_CODE — is pinned against the actual catalog table in
// `src/__tests__/external-reference-boot-gate.test.ts`. The link between the two
// is the id asserted below.
const mockRequireExternalReferenceKey = vi.hoisted(() =>
  vi.fn((_id: string): string => {
    const value = process.env.WELCOME_CREDIT_COUPON_CODE ?? "";
    if (value.trim() === "") throw new Error("WELCOME_CREDIT_COUPON_CODE is unset or blank.");
    return value.trim();
  }),
);

vi.mock("@ibatexas/tools", () => ({
  requireExternalReferenceKey: mockRequireExternalReferenceKey,
  getRedisClient: vi.fn(async () => mockRedis),
  rk: vi.fn((key: string) => `test:${key}`),
  atomicIncr: vi.fn().mockResolvedValue(1),
}));

vi.mock("@ibatexas/domain", () => ({
  createCustomerService: () => ({
    upsertFromWhatsApp: vi.fn(),
  }),
}));

vi.mock("@ibatexas/types", () => ({
  Channel: { Web: "web", WhatsApp: "whatsapp" },
}));

vi.mock("uuid", () => ({ v4: vi.fn().mockReturnValue("test-uuid") }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("WELCOME_CREDIT_COUPON_CODE", TEST_COUPON);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ── setWelcomeCredit ──────────────────────────────────────────────────────────

describe("setWelcomeCredit", () => {
  it("stores the CONFIGURED coupon with 30-day TTL", async () => {
    mockRedis.set.mockResolvedValue("OK");

    await setWelcomeCredit("cust-123");

    expect(mockRedis.set).toHaveBeenCalledWith(
      expect.stringContaining("welcome:credit:cust-123"),
      TEST_COUPON,
      { EX: 30 * 86400 },
    );
    // The declared reference id — renaming it in the catalog without renaming it
    // here is what this assertion exists to catch.
    expect(mockRequireExternalReferenceKey).toHaveBeenCalledWith("promotion.welcome-credit");
  });

  it("refuses rather than granting a made-up code when the config is unset", async () => {
    // No fallback literal, anywhere. If this ever stops throwing, the
    // hardcoded coupon is back — see packages/tools/src/external-references/
    // config.ts. In a real process this is unreachable: the boot gate already
    // refused to start.
    vi.stubEnv("WELCOME_CREDIT_COUPON_CODE", "");

    await expect(setWelcomeCredit("cust-123")).rejects.toThrow(
      /WELCOME_CREDIT_COUPON_CODE/,
    );
    expect(mockRedis.set).not.toHaveBeenCalled();
  });
});

// ── getAndConsumeWelcomeCredit ────────────────────────────────────────────────

describe("getAndConsumeWelcomeCredit", () => {
  it("returns coupon code and deletes key on first call", async () => {
    mockRedis.getDel.mockResolvedValue(TEST_COUPON);

    const code = await getAndConsumeWelcomeCredit("cust-123");

    expect(code).toBe(TEST_COUPON);
    expect(mockRedis.getDel).toHaveBeenCalledWith(
      expect.stringContaining("welcome:credit:cust-123"),
    );
  });

  it("returns null when no credit exists", async () => {
    mockRedis.getDel.mockResolvedValue(null);

    const code = await getAndConsumeWelcomeCredit("cust-123");

    expect(code).toBeNull();
  });

  it("is consumed — second call returns null", async () => {
    // First call: getDel atomically returns and deletes
    mockRedis.getDel.mockResolvedValueOnce(TEST_COUPON);

    const first = await getAndConsumeWelcomeCredit("cust-456");
    expect(first).toBe(TEST_COUPON);

    // Second call: key already deleted, getDel returns null
    mockRedis.getDel.mockResolvedValueOnce(null);

    const second = await getAndConsumeWelcomeCredit("cust-456");
    expect(second).toBeNull();
  });
});
