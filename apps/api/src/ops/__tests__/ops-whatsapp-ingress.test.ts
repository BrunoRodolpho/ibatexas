// ops-whatsapp-ingress — the BKL-086 fork handler, unit-proven with injected
// fakes + a mocked handleTurn. Proves the SECURITY-CRITICAL fork contract:
//   - allowlist = the Staff table, re-read EVERY message (no caching); no row /
//     inactive ⇒ {consumed:false} (fall through to the customer path unchanged),
//     and the conductor is NEVER composed for a non-staff / inactive phone.
//   - an active staff phone ⇒ {consumed:true}: composes the ops conductor with
//     the WHATSAPP verb scope + the authenticated {staffId, role}, runs the turn,
//     replies, and shares the ops-history thread by staffId.
//   - honest pt-BR surfaces on empty input / factory-unavailable / turn failure.
//   - the lock is reused (held ⇒ skip without a second turn).
//
// The crown-jewel e2e (REAL composed conductor + kernel + scripted model) lives
// in ops-whatsapp-ingress.e2e.test.ts.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { wrapLegacyResponderText, mintFallbackReply } from "@adjudicate/core";
import { createStaffService } from "@ibatexas/domain";
import { getOpsConductorFactory } from "../../claustrum-bootstrap.js";
import { acquireAgentLock, releaseAgentLock } from "../../whatsapp/session.js";
import { sendText } from "../../whatsapp/client.js";
import { appendOpsMessages, buildOpsHistoryBlock } from "../ops-history.js";
import {
  handleOpsWhatsAppMessage,
  buildOpsWhatsAppIngressDeps,
  type OpsWhatsAppIngressDeps,
  type StaffAllowlistRow,
} from "../ops-whatsapp-ingress.js";

const mockHandleTurn = vi.hoisted(() => vi.fn());

// The ops module's production wiring imports load Redis/Twilio/prisma/bootstrap;
// stub them so importing the module under test is cheap. handleOpsWhatsAppMessage
// (the unit under test) uses INJECTED deps, never these.
vi.mock("@claustrum/core", () => ({ handleTurn: mockHandleTurn }));
vi.mock("../../claustrum-bootstrap.js", () => ({ getOpsConductorFactory: vi.fn() }));
vi.mock("../../whatsapp/session.js", () => ({
  acquireAgentLock: vi.fn(),
  releaseAgentLock: vi.fn(),
}));
vi.mock("../../whatsapp/client.js", () => ({ sendText: vi.fn() }));
vi.mock("../ops-history.js", () => ({
  appendOpsMessages: vi.fn(),
  buildOpsHistoryBlock: vi.fn(),
}));
vi.mock("@ibatexas/domain", () => ({ createStaffService: vi.fn() }));

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const ACTIVE_OWNER: StaffAllowlistRow = { id: "staff_1", role: "OWNER", active: true };

function fakeConductor() {
  return {
    openCapsule: vi.fn(async () => ({ id: "cap-1", turnId: "t-1" })),
    closeCapsule: vi.fn(async () => {}),
  };
}

function makeDeps(over: Partial<OpsWhatsAppIngressDeps> = {}): {
  deps: OpsWhatsAppIngressDeps;
  conductor: ReturnType<typeof fakeConductor>;
  spies: {
    findStaffByPhone: ReturnType<typeof vi.fn>;
    composeConductor: ReturnType<typeof vi.fn>;
    acquireLock: ReturnType<typeof vi.fn>;
    releaseLock: ReturnType<typeof vi.fn>;
    loadHistoryBlock: ReturnType<typeof vi.fn>;
    appendHistory: ReturnType<typeof vi.fn>;
    sendReply: ReturnType<typeof vi.fn>;
    sendError: ReturnType<typeof vi.fn>;
  };
} {
  const conductor = fakeConductor();
  const spies = {
    findStaffByPhone: vi.fn(async () => ACTIVE_OWNER as StaffAllowlistRow | null),
    composeConductor: vi.fn(() => conductor as never),
    acquireLock: vi.fn(async () => "lock-uuid" as string | null),
    releaseLock: vi.fn(async () => {}),
    loadHistoryBlock: vi.fn(async () => undefined as string | undefined),
    appendHistory: vi.fn(async () => {}),
    sendReply: vi.fn(async () => {}),
    sendError: vi.fn(async () => {}),
  };
  // Overrides win AND become the tracked spy (so assertions on `spies` match the
  // functions actually injected into `deps`).
  Object.assign(spies, over);
  const deps = spies as unknown as OpsWhatsAppIngressDeps;
  return { deps, conductor, spies };
}

const ARGS = { phone: "+5511999999999", hash: "hash-abc", text: "acabou a picanha", log };

beforeEach(() => {
  vi.clearAllMocks();
  mockHandleTurn.mockResolvedValue({
    response: { text: "Feito. A picanha saiu do cardápio." },
    decision: { kind: "EXECUTE" },
    acted: { kind: "executed" },
  });
});

describe("allowlist gate (the Staff table, re-read every message)", () => {
  it("no staff row → {consumed:false}; the conductor is NEVER composed", async () => {
    const { deps, spies } = makeDeps({ findStaffByPhone: vi.fn(async () => null) });
    const out = await handleOpsWhatsAppMessage(deps, ARGS);
    expect(out).toEqual({ consumed: false });
    expect(spies.composeConductor).not.toHaveBeenCalled();
    expect(spies.acquireLock).not.toHaveBeenCalled();
    expect(spies.sendReply).not.toHaveBeenCalled();
  });

  it("inactive staff → {consumed:false} (never ghost a demoted staffer); conductor NEVER composed", async () => {
    const { deps, spies } = makeDeps({
      findStaffByPhone: vi.fn(
        async (): Promise<StaffAllowlistRow | null> => ({ id: "staff_x", role: "MANAGER", active: false }),
      ),
    });
    const out = await handleOpsWhatsAppMessage(deps, ARGS);
    expect(out).toEqual({ consumed: false });
    expect(spies.composeConductor).not.toHaveBeenCalled();
  });

  it("findStaffByPhone is called EXACTLY once per message (no role/active caching)", async () => {
    const { deps, spies } = makeDeps();
    await handleOpsWhatsAppMessage(deps, ARGS);
    await handleOpsWhatsAppMessage(deps, ARGS);
    expect(spies.findStaffByPhone).toHaveBeenCalledTimes(2);
    expect(spies.findStaffByPhone).toHaveBeenCalledWith(ARGS.phone);
  });
});

describe("active staff → the ops turn", () => {
  it("composes with the authenticated {staffId, role} + the WHATSAPP verb scope, replies, and consumes", async () => {
    const { deps, conductor, spies } = makeDeps();
    const out = await handleOpsWhatsAppMessage(deps, ARGS);
    expect(out).toEqual({ consumed: true });

    // The conductor is composed with the JWT-equivalent actor (never model-derived)…
    expect(spies.composeConductor).toHaveBeenCalledTimes(1);
    const [actor, context] = spies.composeConductor.mock.calls[0]!;
    expect(actor).toEqual({ staffId: "staff_1", role: "OWNER" });
    // …and the WhatsApp verb scope (the SIM-swap compensating control).
    expect(context.opsVerbScope).toBe("whatsapp");

    // Identity IDENTICAL to the HTTP route (shared parks/history/resume).
    expect(conductor.openCapsule).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "system",
        customerId: "staff:staff_1",
        sessionKey: "ops:staff_1",
        actor: { principal: "user", role: "staff", sessionId: "admin:staff_1", staffId: "staff_1" },
      }),
    );
    expect(mockHandleTurn).toHaveBeenCalledTimes(1);
    expect(spies.sendReply).toHaveBeenCalledWith("Feito. A picanha saiu do cardápio.");
    expect(conductor.closeCapsule).toHaveBeenCalledTimes(1);
    expect(spies.releaseLock).toHaveBeenCalledWith(ARGS.hash, "lock-uuid");
  });

  it("shares the ops-history thread by staffId: appends the user msg BEFORE the turn, then the reply", async () => {
    const order: string[] = [];
    const { deps, spies } = makeDeps({
      loadHistoryBlock: vi.fn(async () => "### HISTÓRICO ###"),
      appendHistory: vi.fn(async (_s, msgs) => {
        order.push(String(msgs[0]!.role));
      }),
    });
    await handleOpsWhatsAppMessage(deps, ARGS);
    // The history block (rendered before the append) is threaded into the composition.
    const [, context] = spies.composeConductor.mock.calls[0]!;
    expect(context.historyBlock).toBe("### HISTÓRICO ###");
    // Both appends target the SAME staffId key the dashboard uses.
    expect(spies.appendHistory).toHaveBeenNthCalledWith(1, "staff_1", [
      { role: "user", content: "acabou a picanha" },
    ]);
    expect(spies.appendHistory).toHaveBeenNthCalledWith(2, "staff_1", [
      { role: "assistant", content: "Feito. A picanha saiu do cardápio." },
    ]);
    expect(order).toEqual(["user", "assistant"]);
  });

  it("a history-append failure is non-fatal (the turn still replies)", async () => {
    const { deps, spies } = makeDeps({
      appendHistory: vi.fn(async () => {
        throw new Error("redis down");
      }),
    });
    const out = await handleOpsWhatsAppMessage(deps, ARGS);
    expect(out).toEqual({ consumed: true });
    expect(spies.sendReply).toHaveBeenCalledWith("Feito. A picanha saiu do cardápio.");
  });
});

describe("honest failure surfaces (never fabricate success)", () => {
  it("empty command → nudge; the conductor is NEVER composed and the lock is not taken", async () => {
    const { deps, spies } = makeDeps();
    const out = await handleOpsWhatsAppMessage(deps, { ...ARGS, text: "   " });
    expect(out).toEqual({ consumed: true });
    expect(spies.sendError).toHaveBeenCalledWith(expect.stringContaining("Não entendi o comando"));
    expect(spies.acquireLock).not.toHaveBeenCalled();
    expect(spies.composeConductor).not.toHaveBeenCalled();
  });

  it("a held lock → consume without a second turn (no compose, no reply)", async () => {
    const { deps, spies } = makeDeps({ acquireLock: vi.fn(async () => null) });
    const out = await handleOpsWhatsAppMessage(deps, ARGS);
    expect(out).toEqual({ consumed: true });
    expect(spies.composeConductor).not.toHaveBeenCalled();
    expect(spies.sendReply).not.toHaveBeenCalled();
    expect(spies.releaseLock).not.toHaveBeenCalled();
  });

  it("factory unavailable (compose throws) → 'indisponível' message; lock released; consumed", async () => {
    const { deps, spies } = makeDeps({
      composeConductor: vi.fn(() => {
        throw new Error("bootstrap not run");
      }),
    });
    const out = await handleOpsWhatsAppMessage(deps, ARGS);
    expect(out).toEqual({ consumed: true });
    expect(spies.sendError).toHaveBeenCalledWith(expect.stringContaining("indisponível"));
    expect(spies.sendReply).not.toHaveBeenCalled();
    expect(spies.releaseLock).toHaveBeenCalledWith(ARGS.hash, "lock-uuid");
  });

  it("turn failure (handleTurn throws) → honest failure message; capsule closed; lock released", async () => {
    mockHandleTurn.mockRejectedValueOnce(new Error("kernel exploded"));
    const { deps, conductor, spies } = makeDeps();
    const out = await handleOpsWhatsAppMessage(deps, ARGS);
    expect(out).toEqual({ consumed: true });
    expect(spies.sendError).toHaveBeenCalledWith(expect.stringContaining("Não consegui processar"));
    expect(spies.sendReply).not.toHaveBeenCalled();
    expect(conductor.closeCapsule).toHaveBeenCalledTimes(1);
    expect(spies.releaseLock).toHaveBeenCalledWith(ARGS.hash, "lock-uuid");
  });

  it("openCapsule failure → honest failure message; consumed", async () => {
    const conductor = {
      openCapsule: vi.fn(async () => {
        throw new Error("session lock timeout");
      }),
      closeCapsule: vi.fn(async () => {}),
    };
    const { deps, spies } = makeDeps({ composeConductor: vi.fn(() => conductor as never) });
    const out = await handleOpsWhatsAppMessage(deps, ARGS);
    expect(out).toEqual({ consumed: true });
    expect(spies.sendError).toHaveBeenCalledWith(expect.stringContaining("Não consegui processar"));
  });

  it("an empty turn completion → honest fallback (never ghost the owner)", async () => {
    mockHandleTurn.mockResolvedValueOnce({
      response: { text: "   " },
      decision: { kind: "EXECUTE" },
      acted: null,
    });
    const { deps, spies } = makeDeps();
    await handleOpsWhatsAppMessage(deps, ARGS);
    expect(spies.sendReply).not.toHaveBeenCalled();
    expect(spies.sendError).toHaveBeenCalledWith(expect.stringContaining("Não consegui processar"));
  });
});

describe("buildOpsWhatsAppIngressDeps (production wiring)", () => {
  it("maps the Staff row (id/role/active) and binds every collaborator to the real impls", async () => {
    const findByPhone = vi.fn(async () => ({ id: "staff_7", role: "MANAGER", active: true, name: "Ana" }));
    vi.mocked(createStaffService).mockReturnValue({ findByPhone } as never);
    const factory = vi.fn(() => ({ id: "conductor" }) as never);
    vi.mocked(getOpsConductorFactory).mockReturnValue(factory as never);
    vi.mocked(acquireAgentLock).mockResolvedValue("lock-uuid");
    vi.mocked(releaseAgentLock).mockResolvedValue(undefined);
    vi.mocked(buildOpsHistoryBlock).mockResolvedValue("### bloco ###");
    vi.mocked(appendOpsMessages).mockResolvedValue(undefined);
    vi.mocked(sendText).mockResolvedValue(undefined);

    const deps = buildOpsWhatsAppIngressDeps("+5511999999999", log);

    // findStaffByPhone → maps the row down to {id, role, active}.
    const row = await deps.findStaffByPhone("+5511999999999");
    expect(row).toEqual({ id: "staff_7", role: "MANAGER", active: true });
    expect(findByPhone).toHaveBeenCalledWith("+5511999999999");
    // No row ⇒ null.
    findByPhone.mockResolvedValueOnce(null as never);
    expect(await deps.findStaffByPhone("+5511000000000")).toBeNull();

    // composeConductor → getOpsConductorFactory()(actor, ctx).
    deps.composeConductor({ staffId: "staff_7", role: "MANAGER" }, { opsVerbScope: "whatsapp" });
    expect(factory).toHaveBeenCalledWith({ staffId: "staff_7", role: "MANAGER" }, { opsVerbScope: "whatsapp" });

    // lock + history delegate to the real modules.
    await deps.acquireLock("hash");
    expect(acquireAgentLock).toHaveBeenCalledWith("hash");
    await deps.releaseLock("hash", "lock-uuid");
    expect(releaseAgentLock).toHaveBeenCalledWith("hash", "lock-uuid");
    await deps.loadHistoryBlock("staff_7");
    expect(buildOpsHistoryBlock).toHaveBeenCalledWith("staff_7");
    await deps.appendHistory("staff_7", [{ role: "user", content: "oi" }]);
    expect(appendOpsMessages).toHaveBeenCalledWith("staff_7", [{ role: "user", content: "oi" }]);

    // sendReply / sendError → kernel-gated sendText to whatsapp:{phone}, branded.
    await deps.sendReply("Feito.");
    expect(sendText).toHaveBeenCalledWith("whatsapp:+5511999999999", wrapLegacyResponderText("Feito."));
    await deps.sendError("Erro.");
    expect(sendText).toHaveBeenCalledWith("whatsapp:+5511999999999", mintFallbackReply("Erro."));
  });
});
