// Unit tests for whatsapp/session.ts — mock Redis, prisma, uuid.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Hoisted mocks ──────────────────────────────────────────────────────────────

const mockUuidv4 = vi.hoisted(() => vi.fn());

const mockRedis = vi.hoisted(() => ({
  hGetAll: vi.fn(),
  hGet: vi.fn(),
  hSet: vi.fn(),
  expire: vi.fn(),
  set: vi.fn(),
  del: vi.fn(),
}));

const mockUpsertFromWhatsApp = vi.hoisted(() => vi.fn());

vi.mock("uuid", () => ({ v4: mockUuidv4 }));

vi.mock("@ibatexas/tools", () => ({
  getRedisClient: vi.fn(async () => mockRedis),
  rk: vi.fn((key: string) => `ibatexas:${key}`),
}));

vi.mock("@ibatexas/domain", () => ({
  createCustomerService: () => ({
    upsertFromWhatsApp: mockUpsertFromWhatsApp,
  }),
}));

vi.mock("@ibatexas/types", () => ({
  Channel: { Web: "web", WhatsApp: "whatsapp" },
}));

import {
  normalizePhone,
  hashPhone,
  resolveWhatsAppSession,
  buildWhatsAppContext,
  touchSession,
  acquireAgentLock,
  releaseAgentLock,
  tryDebounce,
  getSessionState,
  setSessionState,
} from "../whatsapp/session.js";

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ── normalizePhone ────────────────────────────────────────────────────────────

describe("normalizePhone", () => {
  it("strips whatsapp: prefix", () => {
    expect(normalizePhone("whatsapp:+5511999887766")).toBe("+5511999887766");
  });

  it("returns phone as-is when no prefix", () => {
    expect(normalizePhone("+5511999887766")).toBe("+5511999887766");
  });

  it("throws on invalid phone format (no + prefix)", () => {
    expect(() => normalizePhone("5511999887766")).toThrow("Invalid phone format");
  });

  it("throws on invalid phone format (too short)", () => {
    expect(() => normalizePhone("+123")).toThrow("Invalid phone format");
  });

  it("throws on invalid phone format (non-numeric)", () => {
    expect(() => normalizePhone("+55abc")).toThrow("Invalid phone format");
  });

  it("throws on empty string", () => {
    expect(() => normalizePhone("")).toThrow("Invalid phone format");
  });

  it("throws on phone starting with +0", () => {
    expect(() => normalizePhone("+011999887766")).toThrow("Invalid phone format");
  });

  it("accepts minimum valid E.164 (8 digits after +)", () => {
    expect(normalizePhone("+12345678")).toBe("+12345678");
  });

  it("accepts maximum valid E.164 (15 digits after +)", () => {
    expect(normalizePhone("+123456789012345")).toBe("+123456789012345");
  });
});

// ── hashPhone ─────────────────────────────────────────────────────────────────

describe("hashPhone", () => {
  it("returns a 12-char hex string", () => {
    const h = hashPhone("+5511999887766");
    expect(h).toMatch(/^[0-9a-f]{12}$/);
  });

  it("same input produces same hash", () => {
    expect(hashPhone("+5511999887766")).toBe(hashPhone("+5511999887766"));
  });

  it("different inputs produce different hashes", () => {
    expect(hashPhone("+5511999887766")).not.toBe(hashPhone("+5511999887700"));
  });
});

// ── resolveWhatsAppSession ──────────────────────────────────────────────────

describe("resolveWhatsAppSession", () => {
  const phone = "+5511999887766";

  it("returns cached session from Redis (isNew: false)", async () => {
    mockRedis.hGetAll.mockResolvedValue({
      phone,
      sessionId: "sess-cached",
      customerId: "cust-cached",
    });

    const session = await resolveWhatsAppSession(phone);

    expect(session).toEqual({
      phone,
      sessionId: "sess-cached",
      customerId: "cust-cached",
      isNew: false,
    });
    expect(mockUpsertFromWhatsApp).not.toHaveBeenCalled();
  });

  it("uses phone from Redis cache if available", async () => {
    mockRedis.hGetAll.mockResolvedValue({
      phone: "+5511888877766",
      sessionId: "sess-1",
      customerId: "cust-1",
    });

    const session = await resolveWhatsAppSession(phone);
    expect(session.phone).toBe("+5511888877766");
  });

  it("falls back to input phone when Redis cache has no phone field", async () => {
    mockRedis.hGetAll.mockResolvedValue({
      sessionId: "sess-1",
      customerId: "cust-1",
    });

    const session = await resolveWhatsAppSession(phone);
    expect(session.phone).toBe(phone);
  });

  it("creates new session on cache miss (isNew: true)", async () => {
    mockRedis.hGetAll.mockResolvedValue({});
    mockUpsertFromWhatsApp.mockResolvedValue({ id: "cust-new" });
    mockUuidv4.mockReturnValue("new-session-uuid");
    mockRedis.hSet.mockResolvedValue(undefined);
    mockRedis.expire.mockResolvedValue(undefined);

    const session = await resolveWhatsAppSession(phone);

    expect(session.isNew).toBe(true);
    expect(session.sessionId).toBe("new-session-uuid");
    expect(session.customerId).toBe("cust-new");

    // Verify customer service was called
    expect(mockUpsertFromWhatsApp).toHaveBeenCalledWith(phone);

    // Verify Redis storage
    expect(mockRedis.hSet).toHaveBeenCalledWith(
      expect.stringContaining("wa:phone:"),
      expect.objectContaining({
        phone,
        sessionId: "new-session-uuid",
        customerId: "cust-new",
      }),
    );

    // Verify TTL was set (24h)
    expect(mockRedis.expire).toHaveBeenCalledWith(
      expect.stringContaining("wa:phone:"),
      86400,
    );
  });

  it("creates new session when cache has sessionId but no customerId", async () => {
    mockRedis.hGetAll.mockResolvedValue({ sessionId: "old-sess" });
    mockUpsertFromWhatsApp.mockResolvedValue({ id: "cust-new" });
    mockUuidv4.mockReturnValue("fresh-uuid");
    mockRedis.hSet.mockResolvedValue(undefined);
    mockRedis.expire.mockResolvedValue(undefined);

    const session = await resolveWhatsAppSession(phone);
    expect(session.isNew).toBe(true);
  });
});

// ── buildWhatsAppContext ──────────────────────────────────────────────────────

describe("buildWhatsAppContext", () => {
  it("builds AgentContext with WhatsApp channel and customer userType", () => {
    const ctx = buildWhatsAppContext({
      phone: "+5511999887766",
      sessionId: "sess-1",
      customerId: "cust-1",
      isNew: false,
    });

    expect(ctx.channel).toBe("whatsapp");
    expect(ctx.sessionId).toBe("sess-1");
    expect(ctx.customerId).toBe("cust-1");
    expect(ctx.userType).toBe("customer");
  });
});

// ── touchSession ──────────────────────────────────────────────────────────────

describe("touchSession", () => {
  it("updates lastMessageAt and refreshes TTL", async () => {
    mockRedis.hSet.mockResolvedValue(undefined);
    mockRedis.expire.mockResolvedValue(undefined);

    await touchSession("abc123");

    expect(mockRedis.hSet).toHaveBeenCalledWith(
      expect.stringContaining("wa:phone:abc123"),
      "lastMessageAt",
      expect.any(String),
    );
    expect(mockRedis.expire).toHaveBeenCalledWith(
      expect.stringContaining("wa:phone:abc123"),
      86400,
    );
  });
});

// ── acquireAgentLock / releaseAgentLock ────────────────────────────────────────

describe("acquireAgentLock", () => {
  it("returns true when lock is acquired (SET NX succeeds)", async () => {
    mockRedis.set.mockResolvedValue("OK");

    const acquired = await acquireAgentLock("sess-1");

    expect(acquired).toBe(true);
    expect(mockRedis.set).toHaveBeenCalledWith(
      expect.stringContaining("wa:agent:sess-1"),
      "1",
      { EX: 30, NX: true },
    );
  });

  it("returns false when lock already held (SET NX fails)", async () => {
    mockRedis.set.mockResolvedValue(null);

    const acquired = await acquireAgentLock("sess-1");

    expect(acquired).toBe(false);
  });

  it("starts heartbeat interval on successful acquisition", async () => {
    mockRedis.set.mockResolvedValue("OK");
    mockRedis.expire.mockResolvedValue(undefined);

    await acquireAgentLock("sess-hb");

    // Advance time to trigger heartbeat (10s interval)
    await vi.advanceTimersByTimeAsync(10_000);

    // Heartbeat calls expire to extend TTL
    expect(mockRedis.expire).toHaveBeenCalledWith(
      expect.stringContaining("wa:agent:sess-hb"),
      30,
    );
  });
});

describe("releaseAgentLock", () => {
  it("clears heartbeat and deletes Redis key", async () => {
    mockRedis.set.mockResolvedValue("OK");
    mockRedis.del.mockResolvedValue(1);

    // Acquire first to set up heartbeat
    await acquireAgentLock("sess-rel");
    await releaseAgentLock("sess-rel");

    expect(mockRedis.del).toHaveBeenCalledWith(
      expect.stringContaining("wa:agent:sess-rel"),
    );
  });

  it("handles release when no heartbeat exists (no-op)", async () => {
    mockRedis.del.mockResolvedValue(0);

    // Release without acquiring — should not throw
    await expect(releaseAgentLock("sess-none")).resolves.toBeUndefined();
  });

  it("handles Redis errors gracefully (best-effort)", async () => {
    mockRedis.del.mockRejectedValue(new Error("Redis down"));

    // Should not throw even if Redis fails
    await expect(releaseAgentLock("sess-err")).resolves.toBeUndefined();
  });
});

// ── tryDebounce ───────────────────────────────────────────────────────────────

describe("tryDebounce", () => {
  it("returns true when debounce key is new (first message in window)", async () => {
    mockRedis.set.mockResolvedValue("OK");

    const result = await tryDebounce("hash123");

    expect(result).toBe(true);
    expect(mockRedis.set).toHaveBeenCalledWith(
      expect.stringContaining("wa:debounce:hash123"),
      "1",
      { EX: 2, NX: true },
    );
  });

  it("returns false when debounce key already exists", async () => {
    mockRedis.set.mockResolvedValue(null);

    const result = await tryDebounce("hash123");

    expect(result).toBe(false);
  });
});

// ── getSessionState / setSessionState ─────────────────────────────────────────

describe("getSessionState", () => {
  it("returns state from Redis hash", async () => {
    mockRedis.hGet.mockResolvedValue("browsing");

    const state = await getSessionState("abc");
    expect(state).toBe("browsing");
  });

  it("returns 'idle' when no state stored", async () => {
    mockRedis.hGet.mockResolvedValue(null);

    const state = await getSessionState("abc");
    expect(state).toBe("idle");
  });

  it("returns 'idle' when state is empty string", async () => {
    mockRedis.hGet.mockResolvedValue("");

    const state = await getSessionState("abc");
    expect(state).toBe("idle");
  });
});

describe("setSessionState", () => {
  it("writes state to Redis hash", async () => {
    mockRedis.hSet.mockResolvedValue(undefined);

    await setSessionState("abc", "checkout");

    expect(mockRedis.hSet).toHaveBeenCalledWith(
      expect.stringContaining("wa:phone:abc"),
      "state",
      "checkout",
    );
  });
});
