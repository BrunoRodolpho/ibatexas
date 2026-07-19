// admin/ops-chat.ts — the dashboard ops ingress, FE-D13 honest stale-resume slice.
//
// Proves the route-level wiring of the confirm-park TTL notice: when the loaded
// session holds a park older than OPS_CONFIRM_PARK_TTL_SECONDS and the reply signals
// a resume, the route restates the expiry (deterministic pt-BR) and SKIPS handleTurn
// (no turn_trace row), appends the notice to the ops thread, and clears the capsule;
// a fresh session runs the normal turn unchanged (the notice is gated, not global).
//
// Harness mirrors ops-snapshot.test.ts: an app-level preHandler injects the staff
// identity the parent admin guard would attach, `requireStaff` then passes. The
// conductor factory, handleTurn, and the Redis-backed ops-history are mocked so the
// test exercises ONLY the route's notice branch (the notice DECISION itself is the
// real opsStaleResumeNotice — deliberately NOT mocked).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import type { ParkedEnvelope } from "@claustrum/core";

const mockHandleTurn = vi.hoisted(() => vi.fn());
const mockOpenCapsule = vi.hoisted(() => vi.fn());
const mockCloseCapsule = vi.hoisted(() => vi.fn());
const mockUnpark = vi.hoisted(() => vi.fn());
const mockConductorFactory = vi.hoisted(() =>
  vi.fn(() => ({ openCapsule: mockOpenCapsule, closeCapsule: mockCloseCapsule })),
);
const mockAppendOpsMessages = vi.hoisted(() => vi.fn());
const mockBuildOpsHistoryBlock = vi.hoisted(() => vi.fn());
const mockLoadOpsHistory = vi.hoisted(() => vi.fn());

// Only handleTurn is overridden — importOriginal keeps SystemChannel et al. intact
// so ops-system-channel.ts (the REAL opsStaleResumeNotice) evaluates normally.
vi.mock("@claustrum/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@claustrum/core")>();
  return { ...actual, handleTurn: mockHandleTurn };
});
vi.mock("../../../claustrum-bootstrap.js", () => ({
  getOpsConductorFactory: () => mockConductorFactory,
}));
vi.mock("../../../ops/ops-history.js", () => ({
  appendOpsMessages: mockAppendOpsMessages,
  buildOpsHistoryBlock: mockBuildOpsHistoryBlock,
  loadOpsHistory: mockLoadOpsHistory,
}));

interface StaffContext {
  readonly staffId: string | null;
  readonly staffRole: "OWNER" | "MANAGER" | "ATTENDANT" | null;
}
const OWNER: StaffContext = { staffId: "owner1", staffRole: "OWNER" };

/** A park stamped `secondsAgo` before now (real clock — the route's inbound.receivedAt). */
function expiredPark(kind: string, userPrompt: string, secondsAgo = 3600): ParkedEnvelope {
  return {
    envelope: { kind, intentHash: "abc123abc123" } as ParkedEnvelope["envelope"],
    confirmationToken: "tok-1",
    userPrompt,
    parkedAt: new Date(Date.now() - secondsAgo * 1000).toISOString(),
  };
}

async function buildServer(staff: StaffContext): Promise<FastifyInstance> {
  const { adminOpsChatRoutes } = await import("../ops-chat.js");
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.addHook("preHandler", async (req) => {
    if (staff.staffId) {
      (req as unknown as { staffId: string | null }).staffId = staff.staffId;
      (req as unknown as { staffRole: string | null }).staffRole = staff.staffRole;
    }
  });
  await app.register(adminOpsChatRoutes);
  await app.ready();
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockBuildOpsHistoryBlock.mockResolvedValue(undefined);
  mockAppendOpsMessages.mockResolvedValue(undefined);
  mockCloseCapsule.mockResolvedValue(undefined);
  mockUnpark.mockResolvedValue(undefined);
});
afterEach(() => vi.resetModules());

describe("POST /api/admin/ops/chat — FE-D13 honest stale-resume", () => {
  it("a 'sim' against an EXPIRED park → the expiry notice, handleTurn SKIPPED, notice appended, zombie pruned", async () => {
    mockOpenCapsule.mockResolvedValue({
      session: { unpark: mockUnpark },
      loadedSession: {
        id: "system:staff:owner1",
        pendingConfirmations: [
          expiredPark("payment.refund.issue", "Confirmar reembolso de R$ 50,00?"),
        ],
      },
    });
    const server = await buildServer(OWNER);
    try {
      const res = await server.inject({
        method: "POST",
        url: "/api/admin/ops/chat",
        payload: { message: "sim, confirma" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.reply).toContain("expirou");
      expect(body.reply).toContain("Confirmar reembolso de R$ 50,00?");
      expect(body.decision).toBe("STALE_PARK_EXPIRED");
      expect(body.executed).toBe(false);
      expect(body.proposedKinds).toEqual([]);
      // The kernel turn was SKIPPED (no turn_trace/intent_audit row for this message).
      expect(mockHandleTurn).not.toHaveBeenCalled();
      // FE-D33 — the expired zombie was pruned via the SessionPort's unpark.
      expect(mockUnpark).toHaveBeenCalledWith("system:staff:owner1", "abc123abc123");
      // The notice was appended to the ops thread (assistant), and the capsule closed.
      expect(mockAppendOpsMessages).toHaveBeenCalledWith("owner1", [
        { role: "assistant", content: body.reply },
      ]);
      expect(mockCloseCapsule).toHaveBeenCalledTimes(1);
    } finally {
      await server.close();
    }
  });

  it("FE-D33 — a prune failure is NON-FATAL: the notice still returns 200", async () => {
    mockOpenCapsule.mockResolvedValue({
      session: {
        unpark: mockUnpark.mockRejectedValueOnce(new Error("redis down")),
      },
      loadedSession: {
        id: "system:staff:owner1",
        pendingConfirmations: [
          expiredPark("payment.refund.issue", "Confirmar reembolso de R$ 50,00?"),
        ],
      },
    });
    const server = await buildServer(OWNER);
    try {
      const res = await server.inject({
        method: "POST",
        url: "/api/admin/ops/chat",
        payload: { message: "sim, confirma" },
      });
      // The prune threw, but the notice is still delivered and the turn skipped.
      expect(res.statusCode).toBe(200);
      expect(res.json().reply).toContain("expirou");
      expect(res.json().decision).toBe("STALE_PARK_EXPIRED");
      expect(mockHandleTurn).not.toHaveBeenCalled();
      expect(mockCloseCapsule).toHaveBeenCalledTimes(1);
    } finally {
      await server.close();
    }
  });

  it("a fresh session (no parks) runs the normal turn — the notice is gated, not global", async () => {
    mockOpenCapsule.mockResolvedValue({
      loadedSession: { pendingConfirmations: [] },
    });
    mockHandleTurn.mockResolvedValue({
      response: { text: "Feito." },
      decision: { kind: "EXECUTE" },
      acted: { kind: "executed" },
      plan: { envelopes: [] },
    });
    const server = await buildServer(OWNER);
    try {
      const res = await server.inject({
        method: "POST",
        url: "/api/admin/ops/chat",
        payload: { message: "reembolsa 50 do pedido 4242" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(mockHandleTurn).toHaveBeenCalledTimes(1);
      expect(body.reply).toBe("Feito.");
      expect(body.decision).toBe("EXECUTE");
      expect(body.executed).toBe(true);
    } finally {
      await server.close();
    }
  });
});

describe("POST /api/admin/ops/chat — FE-D32 soft-affirmative restatement", () => {
  // A FRESH park: stamped just now (well within the confirm-park TTL).
  function freshPark(kind: string, userPrompt: string): ParkedEnvelope {
    return {
      envelope: { kind, intentHash: "fresh1fresh1" } as ParkedEnvelope["envelope"],
      confirmationToken: "tok-fresh",
      userPrompt,
      parkedAt: new Date(Date.now() - 5000).toISOString(), // 5s ago → fresh
    };
  }

  it("a bare 'pode' against a FRESH park → SOFT_AFFIRM_RESTATE (executed:false), handleTurn SKIPPED, park NOT pruned", async () => {
    mockOpenCapsule.mockResolvedValue({
      session: { unpark: mockUnpark },
      loadedSession: {
        id: "system:staff:owner1",
        pendingConfirmations: [
          freshPark("payment.refund.issue", "Confirmar reembolso de R$ 50,00?"),
        ],
      },
    });
    const server = await buildServer(OWNER);
    try {
      const res = await server.inject({
        method: "POST",
        url: "/api/admin/ops/chat",
        payload: { message: "pode" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.decision).toBe("SOFT_AFFIRM_RESTATE");
      expect(body.executed).toBe(false);
      expect(body.reply).toContain("Confirmar reembolso de R$ 50,00?"); // restates the prompt
      expect(body.reply).toContain('"sim"'); // asks for an explicit confirm
      // The kernel turn was SKIPPED, and the FRESH park was NOT pruned — it survives
      // so a follow-up "sim" executes it.
      expect(mockHandleTurn).not.toHaveBeenCalled();
      expect(mockUnpark).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("a subsequent explicit 'sim' against the SAME fresh park runs the normal turn (executes)", async () => {
    mockOpenCapsule.mockResolvedValue({
      loadedSession: {
        id: "system:staff:owner1",
        pendingConfirmations: [
          freshPark("payment.refund.issue", "Confirmar reembolso de R$ 50,00?"),
        ],
      },
    });
    mockHandleTurn.mockResolvedValue({
      response: { text: "Reembolso confirmado." },
      decision: { kind: "EXECUTE" },
      acted: { kind: "executed" },
      plan: { envelopes: [] },
    });
    const server = await buildServer(OWNER);
    try {
      const res = await server.inject({
        method: "POST",
        url: "/api/admin/ops/chat",
        payload: { message: "sim" },
      });
      expect(res.statusCode).toBe(200);
      // An explicit confirm is NOT restated — it runs the normal loop (which resumes
      // the still-fresh park).
      expect(res.json().decision).not.toBe("SOFT_AFFIRM_RESTATE");
      expect(mockHandleTurn).toHaveBeenCalledTimes(1);
    } finally {
      await server.close();
    }
  });
});
