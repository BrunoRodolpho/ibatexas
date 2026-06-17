// H2 (ERDS-061/062) — agent-approval → adjudicate Redis registry mirror.
//
// Verifies the bridge (approval-engine-bridge.ts):
//   - delegates every call to the inner ibatexas engine and returns its value
//     verbatim (ibatexas types unchanged);
//   - mirrors request/resolve into the adjudicate registry, mapping
//     agentNamespace → sessionId, taint → UNTRUSTED, status rejected → declined;
//   - is fail-OPEN: a registry write that throws never affects the inner result.
//
// The "registry" here is the package's OWN in-memory reference registry
// (createInMemoryApprovalRegistry) — a real ApprovalRegistry with no Redis.

import { describe, expect, it, vi } from "vitest";
import { createInMemoryApprovalRegistry } from "@adjudicate/approval-engine";
import { createAgentApprovalEngineBridge } from "../claustrum/approval-engine-bridge.js";
import type {
  AgentApprovalEngine,
  AgentApprovalRequest,
} from "../claustrum/agent-approvals.js";

const NOW = "2026-06-16T12:00:00.000Z";
const RESOLVED_AT = "2026-06-16T12:05:00.000Z";

function pendingRequest(): AgentApprovalRequest {
  return {
    token: "tok-1",
    agentNamespace: "agent:pix-payment-failure-remediation@0.1.0",
    intentKind: "payment.pix.regenerate",
    intentHash: "hash-abc",
    prompt: "Regenerar cobrança PIX?",
    status: "pending",
    requestedAt: NOW,
  };
}

/** Minimal inner engine double — records calls, returns scripted projections. */
function stubInner(overrides: Partial<AgentApprovalEngine> = {}): AgentApprovalEngine {
  return {
    request: vi.fn(async (_input) => pendingRequest()),
    resolve: vi.fn(async () => ({ request: pendingRequest() })),
    list: vi.fn(() => []),
    get: vi.fn(() => null),
    ...overrides,
  };
}

describe("createAgentApprovalEngineBridge — request mirror", () => {
  it("delegates to inner and mirrors a pending projection (agentNamespace→sessionId, taint UNTRUSTED, channel agent-approval)", async () => {
    const registry = createInMemoryApprovalRegistry({ nowIso: () => NOW });
    const inner = stubInner();
    const bridge = createAgentApprovalEngineBridge({ inner, registry });

    const env = { actor: { sessionId: "agent:x" } } as never;
    const result = await bridge.request({ envelope: env, prompt: "p" });

    // Inner result returned verbatim.
    expect(result).toEqual(pendingRequest());
    expect(inner.request).toHaveBeenCalledOnce();

    // Mirror landed in the registry with the mapped fields.
    const mirrored = await registry.get("tok-1");
    expect(mirrored).not.toBeNull();
    expect(mirrored).toMatchObject({
      token: "tok-1",
      sessionId: "agent:pix-payment-failure-remediation@0.1.0",
      intentHash: "hash-abc",
      intentKind: "payment.pix.regenerate",
      taint: "UNTRUSTED",
      channel: "agent-approval",
      status: "pending",
    });
  });
});

describe("createAgentApprovalEngineBridge — resolve mirror (rejected→declined)", () => {
  it("maps ibatexas rejected → adjudicate declined and carries resolvedBy", async () => {
    const registry = createInMemoryApprovalRegistry({ nowIso: () => NOW });
    const resolvedBy = { id: "staff_1", displayName: "Operador" };
    const inner = stubInner({
      // First seed the pending projection, then resolve rejected.
      resolve: vi.fn(async () => ({
        request: {
          ...pendingRequest(),
          status: "rejected" as const,
          resolvedAt: RESOLVED_AT,
          resolvedBy,
        },
      })),
    });
    const bridge = createAgentApprovalEngineBridge({ inner, registry });

    // Seed the pending mirror (markResolved requires an existing pending row).
    const env = { actor: { sessionId: "agent:x" } } as never;
    await bridge.request({ envelope: env, prompt: "p" });

    const result = await bridge.resolve({
      token: "tok-1",
      accepted: false,
      resolvedBy,
    } as never);

    // Inner result returned verbatim (status stays the ibatexas "rejected").
    expect(result.request.status).toBe("rejected");

    // Mirror is the adjudicate "declined", with the approver.
    const mirrored = await registry.get("tok-1");
    expect(mirrored?.status).toBe("declined");
    expect(mirrored?.resolvedBy).toEqual(resolvedBy);
  });

  it("maps ibatexas approved → adjudicate approved", async () => {
    const registry = createInMemoryApprovalRegistry({ nowIso: () => NOW });
    const resolvedBy = { id: "staff_2" };
    const inner = stubInner({
      resolve: vi.fn(async () => ({
        request: {
          ...pendingRequest(),
          status: "approved" as const,
          resolvedAt: RESOLVED_AT,
          resolvedBy,
        },
      })),
    });
    const bridge = createAgentApprovalEngineBridge({ inner, registry });
    const env = { actor: { sessionId: "agent:x" } } as never;
    await bridge.request({ envelope: env, prompt: "p" });

    await bridge.resolve({ token: "tok-1", accepted: true, resolvedBy } as never);

    const mirrored = await registry.get("tok-1");
    expect(mirrored?.status).toBe("approved");
  });
});

describe("createAgentApprovalEngineBridge — fail-open", () => {
  it("a throwing registry on request never affects the inner result", async () => {
    const throwingRegistry = {
      put: vi.fn(async () => {
        throw new Error("redis down");
      }),
      get: vi.fn(async () => null),
      list: vi.fn(async () => []),
      markResolved: vi.fn(async () => null),
    };
    const onMirrorError = vi.fn();
    const inner = stubInner();
    const bridge = createAgentApprovalEngineBridge({
      inner,
      registry: throwingRegistry,
      onMirrorError,
    });

    const env = { actor: { sessionId: "agent:x" } } as never;
    const result = await bridge.request({ envelope: env, prompt: "p" });

    // The inner projection is returned despite the registry throw.
    expect(result).toEqual(pendingRequest());
    expect(onMirrorError).toHaveBeenCalledWith("request", expect.any(Error));
  });

  it("a throwing registry on resolve never affects the inner result", async () => {
    const throwingRegistry = {
      put: vi.fn(async () => {}),
      get: vi.fn(async () => null),
      list: vi.fn(async () => []),
      markResolved: vi.fn(async () => {
        throw new Error("redis down");
      }),
    };
    const onMirrorError = vi.fn();
    const inner = stubInner({
      resolve: vi.fn(async () => ({
        request: { ...pendingRequest(), status: "rejected" as const },
      })),
    });
    const bridge = createAgentApprovalEngineBridge({
      inner,
      registry: throwingRegistry,
      onMirrorError,
    });

    const result = await bridge.resolve({
      token: "tok-1",
      accepted: false,
      resolvedBy: { id: "s" },
    } as never);

    expect(result.request.status).toBe("rejected");
    expect(onMirrorError).toHaveBeenCalledWith("resolve", expect.any(Error));
  });
});

describe("createAgentApprovalEngineBridge — reads delegate unchanged", () => {
  it("list/get pass straight through to inner", () => {
    const inner = stubInner({
      list: vi.fn(() => [pendingRequest()]),
      get: vi.fn(() => pendingRequest()),
    });
    const registry = createInMemoryApprovalRegistry();
    const bridge = createAgentApprovalEngineBridge({ inner, registry });

    expect(bridge.list({ status: "pending" })).toEqual([pendingRequest()]);
    expect(inner.list).toHaveBeenCalledWith({ status: "pending" });
    expect(bridge.get("tok-1")).toEqual(pendingRequest());
    expect(inner.get).toHaveBeenCalledWith("tok-1");
  });
});
