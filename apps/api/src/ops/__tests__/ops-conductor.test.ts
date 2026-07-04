// ops-conductor — the NEW-032 crown-jewel proof: a staff ops command driven
// through composeOpsConductor + a full handleTurn against the REAL composed
// policy router + REAL kernel adjudicate (no DB/network — model/medusa/services
// are fakes). Proves the layered role enforcement END-TO-END:
//
//   - OWNER  → product.availability.set EXECUTEs; the availability executor runs
//     ONCE (the same medusaAdjudicated egress the products route uses).
//   - ATTENDANT → REFUSE staff_role_violation (matrix {OWNER,MANAGER}); the
//     executor NEVER runs; the reply is the role-opaque pt-BR refusal.
//   - product missing → REFUSE product_not_found; the executor never runs.
//
// The envelope authority the kernel gates on is stamped by the planner's
// staffEnvelopeActor (admin:<staffId> + role) — never the model — so this
// exercises exactly the security crux.

import { describe, expect, it, vi } from "vitest";
import {
  adjudicate,
  type PolicyBundle,
} from "@adjudicate/core/kernel";
import {
  decisionRefuse,
  refuse,
  type Decision,
  type IntentEnvelope,
} from "@adjudicate/core";
import {
  handleTurn,
  type Adjudicator,
  type ChannelMessage,
  type Completion,
  type CompletionRequest,
  type ModelProvider,
  type Session,
  type SessionLock,
  type SessionPort,
  type TelemetryPort,
  type TenantResolver,
} from "@claustrum/core";
import { IBATEXAS_COMPOSED_PACKS } from "@ibatexas/packs-composed";
import {
  buildIbatexasPolicyPacks,
  type ErasedPack,
} from "../../claustrum/compose-policy-packs.js";
import { composePolicyRouter } from "../../claustrum/capability-policy.js";
import { SystemChannel } from "../../claustrum/system-channel.js";
import {
  noopMemoryProvider,
  noopGroundingProvider,
} from "../../claustrum/noop-memory-grounding.js";
import { composeOpsConductor } from "../ops-conductor.js";
import { createOpsToolRegistry } from "../ops-tool-registry.js";
import { createOpsResolver } from "../ops-resolver.js";

// The EXACT composed router the conductor SUBMIT stage adjudicates against.
const ROUTER: PolicyBundle<string, unknown, unknown> = composePolicyRouter(
  buildIbatexasPolicyPacks(
    IBATEXAS_COMPOSED_PACKS as unknown as ReadonlyArray<ErasedPack>,
  ) as never,
);

// ── Fakes ────────────────────────────────────────────────────────────────────

/** A real-kernel adjudicator: adjudicate() runs the pure kernel over the router. */
const realKernelAdjudicator: Adjudicator = {
  adjudicate: async (envelope, state, policy) =>
    adjudicate(envelope as IntentEnvelope, state as never, policy as never),
  adjudicatePlan: async (envelopes, state, policy, perStates) => {
    if (envelopes.length === 0) {
      return decisionRefuse(
        refuse("BUSINESS_RULE", "empty_plan", "Nada a autorizar.", "empty plan"),
        [],
      );
    }
    return adjudicate(
      envelopes[0] as IntentEnvelope,
      (perStates?.[0] ?? state) as never,
      policy as never,
    );
  },
  replayEnvelopesByCustomerId: async () => [],
  streamAuditByIntentHashPrefix: async function* () {
    /* none */
  },
  getOutcomes: async () => [],
  verifyAuditRecord: () => ({ ok: true }),
};

function freshSession(customerId: string): Session {
  return {
    id: `ops:${customerId}`,
    customerId,
    channel: "system",
    startedAt: "2026-07-04T00:00:00.000Z",
    lastActivityAt: "2026-07-04T00:00:00.000Z",
    pendingConfirmations: [],
    deferredEnvelopes: [],
    activeGoals: [],
    workingMemory: { summary: "", facts: [], updatedAt: "2026-07-04T00:00:00.000Z" },
  };
}

const inMemorySession: SessionPort = {
  load: async (customerId) => freshSession(customerId),
  save: async () => {},
  parkPendingConfirmation: async () => {},
  parkDeferred: async () => {},
  unpark: async () => {},
};

const inMemoryLock: SessionLock = {
  acquire: async (key) => ({ key, release: async () => {} }),
};

const noopTelemetry: TelemetryPort = {
  emitTurn: async () => {},
  emitLLMTrace: async () => {},
  emitMemoryAccess: async () => {},
};

const tenantResolver: TenantResolver = {
  resolve: async ({ channel, customerId }) => ({
    tenant: {
      tenantId: "ibatexas",
      displayName: "IbateXas",
      locale: "pt-BR",
      environment: "dev",
    },
    state: { channel, customerId },
    policy: ROUTER,
  }),
};

/** A scripted model: planner call (has tools) → the express_intent tool call;
 *  responder call (no tools) → grounded text. */
function scriptedModel(
  plannerToolCalls: ReadonlyArray<{ id: string; name: string; input: unknown }>,
  responderText = "Feito.",
): { model: ModelProvider; complete: ReturnType<typeof vi.fn> } {
  const complete = vi.fn(async (req: CompletionRequest): Promise<Completion> => {
    const isPlanner = (req.tools?.length ?? 0) > 0;
    return {
      model: "mock",
      stopReason: "end_turn",
      text: isPlanner ? "" : responderText,
      toolCalls: isPlanner ? [...plannerToolCalls] : [],
      inputTokens: 5,
      outputTokens: 4,
    };
  });
  const model: ModelProvider = {
    complete,
    stream: () => {
      throw new Error("stream unused");
    },
    embed: async () => {
      throw new Error("embed unused");
    },
  };
  return { model, complete };
}

/** The order-projection subset the ops resolver feeds the note/transition state. */
type FakeOpsOrder = {
  customerId: string | null;
  paymentMethod: string | null;
  paymentStatus: string | null;
  totalInCentavos: number;
  /** Current status — the BKL-090 legality guard reads it for transitions. */
  fulfillmentStatus: string | null;
} | null;

function buildDeps(opts: {
  model: ModelProvider;
  medusaAdjudicated: ReturnType<typeof vi.fn>;
  writeAdjudicatedNote: ReturnType<typeof vi.fn>;
  /** POST-adjudication kitchen-advance writer (BKL-090). */
  writeAdjudicatedStatusTransition?: ReturnType<typeof vi.fn>;
  /** order.status_changed publisher spy (BKL-090). */
  publishOrderStatusChanged?: ReturnType<typeof vi.fn>;
  product: { id: string; status: string } | null;
  /** BKL-089 — the candidate set the name-resolver read returns (when the direct
   *  id lookup misses, i.e. `product` is null). Absent ⇒ no name resolver wired. */
  productsByName?: Array<{ id: string; title: string; status: string }>;
  /** The order the resolver projects for order.note.add / order.status.transition;
   *  null ⇒ order-missing. */
  order?: FakeOpsOrder;
}) {
  const tools = createOpsToolRegistry({
    medusaAdjudicated: opts.medusaAdjudicated as never,
    auditSink: {} as never,
    orderCmdSvc: {
      writeAdjudicatedNote: opts.writeAdjudicatedNote,
      writeAdjudicatedStatusTransition:
        opts.writeAdjudicatedStatusTransition ?? vi.fn(),
    },
    publishOrderStatusChanged: opts.publishOrderStatusChanged ?? vi.fn(),
  });
  return {
    adjudicator: realKernelAdjudicator,
    memory: noopMemoryProvider(),
    grounding: noopGroundingProvider("mock"),
    explainer: { render: (r: { userFacing: string }) => r.userFacing },
    handoff: { queue: async () => {} },
    telemetry: noopTelemetry,
    session: inMemorySession,
    tenantResolver,
    sessionLock: inMemoryLock,
    systemChannel: new SystemChannel({
      gatewaySigningKey: "test-ops-signing-key-abcdefghijklmnop",
      gateway: "ibatexas-ops-test",
    }),
    tools,
    model: opts.model,
    modelId: "mock",
    opsReadToolExecutors: {},
    buildResolver: (staffId: string) =>
      createOpsResolver({
        staffId,
        tenantId: "ibatexas",
        lookupProduct: async () => opts.product,
        lookupOrder: async () => opts.order ?? null,
        ...(opts.productsByName
          ? { listProductsByName: async () => opts.productsByName! }
          : {}),
      }),
  };
}

function inbound(staffId: string, text: string): ChannelMessage {
  return {
    channel: "system",
    customerId: `staff:${staffId}`,
    conversationId: `admin:${staffId}`,
    externalId: `ops-${staffId}-1`,
    text,
    receivedAt: "2026-07-04T12:00:00.000Z",
    locale: "pt-BR",
  };
}

async function runOpsTurn(
  deps: ReturnType<typeof buildDeps>,
  role: "OWNER" | "MANAGER" | "ATTENDANT",
  staffId: string,
  text: string,
): Promise<Decision & { response: string }> {
  const conductor = composeOpsConductor(deps as never, { staffId, role });
  const message = inbound(staffId, text);
  const capsule = await conductor.openCapsule({
    channel: "system",
    customerId: `staff:${staffId}`,
    sessionKey: `ops:${staffId}`,
    actor: { principal: "user", role: "staff", sessionId: `admin:${staffId}`, staffId },
    inbound: message,
  });
  try {
    const turn = await handleTurn(capsule, message);
    return { ...turn.decision, response: turn.response.text } as never;
  } finally {
    await conductor.closeCapsule(capsule);
  }
}

const AVAIL_CALL = {
  id: "tc-1",
  name: "express_intent",
  input: {
    capability: "product.availability.set",
    payload: { productId: "prod_1", available: false },
  },
};

describe("ops conductor — the end-to-end kernel proof (NEW-032)", () => {
  it("OWNER → EXECUTE; the availability executor runs ONCE", async () => {
    const medusaAdjudicated = vi.fn(async (_args: unknown) => ({ product: { id: "prod_1" } }));
    const writeAdjudicatedNote = vi.fn();
    const { model } = scriptedModel([AVAIL_CALL]);
    const deps = buildDeps({
      model,
      medusaAdjudicated,
      writeAdjudicatedNote,
      product: { id: "prod_1", status: "published" },
    });
    const out = await runOpsTurn(deps, "OWNER", "staff_1", "acabou a picanha");
    expect(out.kind).toBe("EXECUTE");
    expect(medusaAdjudicated).toHaveBeenCalledTimes(1);
    const args = medusaAdjudicated.mock.calls[0]![0] as Record<string, unknown>;
    expect(args.payload).toEqual({ metadata: { inStock: false } });
    expect(args.sourceSubject).toBe("ops:product.availability.set:admin:staff_1");
  });

  it("ATTENDANT → REFUSE staff_role_violation; the executor NEVER runs; reply is the role-opaque refusal", async () => {
    const medusaAdjudicated = vi.fn(async (_args: unknown) => ({ product: {} }));
    const { model } = scriptedModel([AVAIL_CALL]);
    const deps = buildDeps({
      model,
      medusaAdjudicated,
      writeAdjudicatedNote: vi.fn(),
      product: { id: "prod_1", status: "published" },
    });
    const out = await runOpsTurn(deps, "ATTENDANT", "staff_9", "tira o X do cardápio");
    expect(out.kind).toBe("REFUSE");
    if (out.kind === "REFUSE") {
      expect(out.refusal.code).toBe("staff_role_violation");
      // Role-opaque pt-BR: never names the role/matrix to the operator.
      expect(out.response).toBe(out.refusal.userFacing);
      expect(out.response.toLowerCase()).not.toContain("attendant");
    }
    expect(medusaAdjudicated).not.toHaveBeenCalled();
  });

  it("OWNER but product missing → REFUSE product_not_found; the executor never runs", async () => {
    const medusaAdjudicated = vi.fn(async (_args: unknown) => ({ product: {} }));
    const { model } = scriptedModel([AVAIL_CALL]);
    const deps = buildDeps({
      model,
      medusaAdjudicated,
      writeAdjudicatedNote: vi.fn(),
      product: null,
    });
    const out = await runOpsTurn(deps, "OWNER", "staff_1", "acabou a picanha");
    expect(out.kind).toBe("REFUSE");
    if (out.kind === "REFUSE") {
      expect(out.refusal.code).toBe("ops.availability.product_not_found");
    }
    expect(medusaAdjudicated).not.toHaveBeenCalled();
  });

  it("MANAGER → EXECUTE (matrix permits OWNER+MANAGER)", async () => {
    const medusaAdjudicated = vi.fn(async (_args: unknown) => ({ product: {} }));
    const { model } = scriptedModel([AVAIL_CALL]);
    const deps = buildDeps({
      model,
      medusaAdjudicated,
      writeAdjudicatedNote: vi.fn(),
      product: { id: "prod_1", status: "published" },
    });
    const out = await runOpsTurn(deps, "MANAGER", "staff_2", "acabou a picanha");
    expect(out.kind).toBe("EXECUTE");
    expect(medusaAdjudicated).toHaveBeenCalledTimes(1);
  });
});

// ── product.availability.set BY NAME (BKL-089) ───────────────────────────────
//
// The crown-jewel proof for name resolution: the scripted model emits
// productId:"picanha" (a NAME, per the persona), the direct id lookup MISSES, the
// ops resolver resolves the name to a real id via the injected catalog read and
// REWRITES the payload BEFORE adjudication, and the availability executor runs the
// SAME medusaAdjudicated egress with the RESOLVED id. An ambiguous name resolves
// to nothing ⇒ the kernel REFUSEs product_not_found (executor never runs). The
// adversarial pin: a resolvable name on a wrong-ROLE turn still REFUSEs — the
// role the kernel gates on rode through resolution untouched.

const AVAIL_BY_NAME_CALL = {
  id: "tc-name",
  name: "express_intent",
  input: {
    capability: "product.availability.set",
    payload: { productId: "picanha", available: false },
  },
};

describe("ops conductor — product.availability.set by NAME (BKL-089)", () => {
  it("OWNER 'acabou a picanha' (name) → resolves → EXECUTE with the RESOLVED id", async () => {
    const medusaAdjudicated = vi.fn(async (_args: unknown) => ({ product: { id: "prod_42" } }));
    const { model } = scriptedModel([AVAIL_BY_NAME_CALL]);
    const deps = buildDeps({
      model,
      medusaAdjudicated,
      writeAdjudicatedNote: vi.fn(),
      product: null, // direct id lookup MISSES → name resolution engages
      productsByName: [{ id: "prod_42", title: "Picanha", status: "published" }],
    });
    const out = await runOpsTurn(deps, "OWNER", "staff_1", "acabou a picanha");
    expect(out.kind).toBe("EXECUTE");
    expect(medusaAdjudicated).toHaveBeenCalledTimes(1);
    const args = medusaAdjudicated.mock.calls[0]![0] as Record<string, unknown>;
    // The egress targets the RESOLVED id, not the spoken name.
    expect(args.path).toBe("/admin/products/prod_42");
    expect(args.payload).toEqual({ metadata: { inStock: false } });
  });

  it("ambiguous name → REFUSE product_not_found; the executor never runs", async () => {
    const medusaAdjudicated = vi.fn(async (_args: unknown) => ({ product: {} }));
    const { model } = scriptedModel([AVAIL_BY_NAME_CALL]);
    const deps = buildDeps({
      model,
      medusaAdjudicated,
      writeAdjudicatedNote: vi.fn(),
      product: null,
      productsByName: [
        { id: "prod_1", title: "Picanha Fatiada", status: "published" },
        { id: "prod_2", title: "Picanha Inteira", status: "published" },
      ],
    });
    const out = await runOpsTurn(deps, "OWNER", "staff_1", "acabou a picanha");
    expect(out.kind).toBe("REFUSE");
    if (out.kind === "REFUSE") {
      expect(out.refusal.code).toBe("ops.availability.product_not_found");
    }
    expect(medusaAdjudicated).not.toHaveBeenCalled();
  });

  it("adversarial: a resolvable name on an ATTENDANT turn still REFUSEs the role", async () => {
    const medusaAdjudicated = vi.fn(async (_args: unknown) => ({ product: { id: "prod_42" } }));
    const { model } = scriptedModel([AVAIL_BY_NAME_CALL]);
    const deps = buildDeps({
      model,
      medusaAdjudicated,
      writeAdjudicatedNote: vi.fn(),
      product: null,
      productsByName: [{ id: "prod_42", title: "Picanha", status: "published" }],
    });
    const out = await runOpsTurn(deps, "ATTENDANT", "staff_9", "acabou a picanha");
    expect(out.kind).toBe("REFUSE");
    if (out.kind === "REFUSE") {
      // Role gate wins — resolution rewrote only the payload, never the actor.
      expect(out.refusal.code).toBe("staff_role_violation");
    }
    expect(medusaAdjudicated).not.toHaveBeenCalled();
  });
});

// ── order.note.add (NEW-032 verbs-v2) ────────────────────────────────────────
//
// Proves the newly-ADVERTISED foreign-owned verb is reachable end-to-end: the
// scripted model proposes order.note.add, the ops planner (now advertising it)
// lets it through translateToolCalls, and the composed pack-orders bundle
// (carrying the prepended staffRoleGuard; matrix {OWNER,MANAGER,ATTENDANT})
// adjudicates it. On EXECUTE the ops registry's writeAdjudicatedNote executor
// runs with isInternal defaulted true + authorId = the Capsule staffId (never a
// model field). A missing order ⇒ pack-orders no_order REFUSE (spy not called).

const NOTE_CALL = {
  id: "tc-note",
  name: "express_intent",
  input: {
    capability: "order.note.add",
    payload: { orderId: "order_1", body: "cliente pediu sem cebola" },
  },
};

/** A typed note-writer spy so `mock.calls[i]` carries the [payload, extras]
 *  tuple (an untyped `vi.fn()` infers a zero-arg signature). */
function noteWriterSpy() {
  return vi.fn(
    async (
      _payload: { orderId: string; body: string; isInternal?: boolean },
      _extras: { author: string; authorId?: string },
    ): Promise<{ noteId: string; orderId: string }> => ({
      noteId: "note_x",
      orderId: "order_1",
    }),
  );
}

/** An order the resolver projects (customerId non-null ⇒ requireAuthenticated
 *  passes — mirrors adjudicateAdminNote's order.customerId-derived state). */
const PRESENT_ORDER: FakeOpsOrder = {
  customerId: "cust_1",
  paymentMethod: "pix",
  paymentStatus: "confirmed",
  totalInCentavos: 5_000,
  fulfillmentStatus: "confirmed",
};

describe("ops conductor — order.note.add reachable end-to-end (NEW-032 verbs-v2)", () => {
  it("OWNER 'adiciona uma nota' → EXECUTE; note write runs with isInternal:true default + Capsule authorId", async () => {
    const writeAdjudicatedNote = noteWriterSpy();
    const { model } = scriptedModel([NOTE_CALL]);
    const deps = buildDeps({
      model,
      medusaAdjudicated: vi.fn(),
      writeAdjudicatedNote,
      product: null,
      order: PRESENT_ORDER,
    });
    const out = await runOpsTurn(
      deps,
      "OWNER",
      "staff_1",
      "adiciona uma nota no pedido order_1",
    );
    expect(out.kind).toBe("EXECUTE");
    expect(writeAdjudicatedNote).toHaveBeenCalledTimes(1);
    const [notePayload, extras] = writeAdjudicatedNote.mock.calls[0]!;
    expect(notePayload.orderId).toBe("order_1");
    expect(notePayload.body).toBe("cliente pediu sem cebola");
    // Staff notes default INTERNAL (set on the payload, not the envelope).
    expect(notePayload.isInternal).toBe(true);
    // authorId is the Capsule/JWT staffId — NEVER a model-parsed field.
    expect(extras.author).toBe("staff");
    expect(extras.authorId).toBe("staff_1");
  });

  it("ATTENDANT → EXECUTE (matrix permits all 3 roles for order.note.add)", async () => {
    const writeAdjudicatedNote = noteWriterSpy();
    const { model } = scriptedModel([NOTE_CALL]);
    const deps = buildDeps({
      model,
      medusaAdjudicated: vi.fn(),
      writeAdjudicatedNote,
      product: null,
      order: PRESENT_ORDER,
    });
    const out = await runOpsTurn(
      deps,
      "ATTENDANT",
      "staff_9",
      "anota que o cliente pediu sem cebola no pedido order_1",
    );
    expect(out.kind).toBe("EXECUTE");
    expect(writeAdjudicatedNote).toHaveBeenCalledTimes(1);
    expect(writeAdjudicatedNote.mock.calls[0]![1]).toMatchObject({
      author: "staff",
      authorId: "staff_9",
    });
  });

  it("order missing → pack-orders no_order REFUSE; the note write NEVER runs", async () => {
    const writeAdjudicatedNote = vi.fn();
    const { model } = scriptedModel([NOTE_CALL]);
    const deps = buildDeps({
      model,
      medusaAdjudicated: vi.fn(),
      writeAdjudicatedNote,
      product: null,
      order: null, // resolver ⇒ ctx.orderId:null ⇒ requireOrderIdForMutation REFUSE
    });
    const out = await runOpsTurn(
      deps,
      "OWNER",
      "staff_1",
      "adiciona uma nota no pedido inexistente",
    );
    expect(out.kind).toBe("REFUSE");
    expect(writeAdjudicatedNote).not.toHaveBeenCalled();
  });

  it("payload isInternal:false is respected (not force-defaulted to internal)", async () => {
    const writeAdjudicatedNote = noteWriterSpy();
    const { model } = scriptedModel([
      {
        id: "tc-note-public",
        name: "express_intent",
        input: {
          capability: "order.note.add",
          payload: {
            orderId: "order_1",
            body: "aviso ao cliente",
            isInternal: false,
          },
        },
      },
    ]);
    const deps = buildDeps({
      model,
      medusaAdjudicated: vi.fn(),
      writeAdjudicatedNote,
      product: null,
      order: PRESENT_ORDER,
    });
    const out = await runOpsTurn(
      deps,
      "MANAGER",
      "staff_2",
      "adiciona um aviso público no pedido order_1",
    );
    expect(out.kind).toBe("EXECUTE");
    expect(writeAdjudicatedNote).toHaveBeenCalledTimes(1);
    expect(writeAdjudicatedNote.mock.calls[0]![0].isInternal).toBe(false);
  });
});

// ── order.status.transition (BKL-090 kitchen-advance) ────────────────────────
//
// The crown-jewel proof for the newly-unblocked verb: a staff "avança o pedido X"
// driven through composeOpsConductor + a full handleTurn against the REAL composed
// router + REAL kernel. Proves the BKL-090 legality guard END-TO-END on the ops
// plane — the ops resolver projects the CURRENT fulfillmentStatus, and the kernel
// REFUSEs an illegal/terminal transition BEFORE the write executor runs (no
// executor-throw reliance for the LLM-proposed surface). A legal advance EXECUTEs
// with actor=admin + the Capsule staffId (never the model payload).

/** Build an express_intent tool call proposing order.status.transition. */
function transitionCall(orderId: string, newStatus: string) {
  return {
    id: "tc-transition",
    name: "express_intent",
    input: {
      capability: "order.status.transition",
      payload: { orderId, newStatus },
    },
  };
}

/** A typed transition-writer spy carrying the [payload, extras] tuple. Returns
 *  the WIDE result (displayId/customerId from the projection row). */
function transitionWriterSpy() {
  return vi.fn(
    async (
      _payload: { orderId: string; newStatus: string; expectedVersion?: number },
      _extras: { actor: string; actorId?: string; reason?: string },
    ): Promise<{
      version: number;
      previousStatus: string;
      newStatus: string;
      displayId: number;
      customerId: string | null;
    }> => ({
      version: 4,
      previousStatus: "preparing",
      newStatus: "ready",
      displayId: 777,
      customerId: "cust_1",
    }),
  );
}

/** An order projected at a given current status. */
function orderAt(fulfillmentStatus: string): FakeOpsOrder {
  return {
    customerId: "cust_1",
    paymentMethod: "pix",
    paymentStatus: "confirmed",
    totalInCentavos: 5_000,
    fulfillmentStatus,
  };
}

describe("ops conductor — order.status.transition reachable end-to-end (BKL-090)", () => {
  it("ATTENDANT 'avança o pedido' legal (preparing→ready) → EXECUTE; write runs with actor=admin + Capsule staffId; order.status_changed emitted", async () => {
    const writeAdjudicatedStatusTransition = transitionWriterSpy();
    const publishOrderStatusChanged = vi.fn(
      async (_event: import("@ibatexas/types").OrderStatusChangedEvent) => {},
    );
    const { model } = scriptedModel([transitionCall("order_1", "ready")]);
    const deps = buildDeps({
      model,
      medusaAdjudicated: vi.fn(),
      writeAdjudicatedNote: vi.fn(),
      writeAdjudicatedStatusTransition,
      publishOrderStatusChanged,
      product: null,
      order: orderAt("preparing"),
    });
    const out = await runOpsTurn(
      deps,
      "ATTENDANT",
      "staff_9",
      "avança o pedido order_1 pra pronto",
    );
    expect(out.kind).toBe("EXECUTE");
    expect(writeAdjudicatedStatusTransition).toHaveBeenCalledTimes(1);
    const [payload, extras] = writeAdjudicatedStatusTransition.mock.calls[0]!;
    expect(payload).toEqual({ orderId: "order_1", newStatus: "ready" });
    expect(extras.actor).toBe("admin");
    expect(extras.actorId).toBe("staff_9");
    // The downstream customer-notify/event-log/reconcile fan-out fires: the SAME
    // order.status_changed the admin advance route emits, with projection-sourced
    // displayId/customerId (never the model).
    expect(publishOrderStatusChanged).toHaveBeenCalledTimes(1);
    expect(publishOrderStatusChanged.mock.calls[0]![0]).toMatchObject({
      orderId: "order_1",
      displayId: 777,
      customerId: "cust_1",
      previousStatus: "preparing",
      newStatus: "ready",
      updatedBy: "admin",
      version: 4,
    });
  });

  it("OWNER legal advance → EXECUTE (matrix permits all 3 roles for order.status.transition)", async () => {
    const writeAdjudicatedStatusTransition = transitionWriterSpy();
    const { model } = scriptedModel([transitionCall("order_1", "ready")]);
    const deps = buildDeps({
      model,
      medusaAdjudicated: vi.fn(),
      writeAdjudicatedNote: vi.fn(),
      writeAdjudicatedStatusTransition,
      product: null,
      order: orderAt("preparing"),
    });
    const out = await runOpsTurn(deps, "OWNER", "staff_1", "avança o pedido order_1");
    expect(out.kind).toBe("EXECUTE");
    expect(writeAdjudicatedStatusTransition).toHaveBeenCalledTimes(1);
  });

  it("ILLEGAL transition (confirmed→delivered) → REFUSE order.status.transition_illegal; write + emit NEVER run", async () => {
    const writeAdjudicatedStatusTransition = transitionWriterSpy();
    const publishOrderStatusChanged = vi.fn(async () => {});
    const { model } = scriptedModel([transitionCall("order_1", "delivered")]);
    const deps = buildDeps({
      model,
      medusaAdjudicated: vi.fn(),
      writeAdjudicatedNote: vi.fn(),
      writeAdjudicatedStatusTransition,
      publishOrderStatusChanged,
      product: null,
      order: orderAt("confirmed"),
    });
    const out = await runOpsTurn(
      deps,
      "OWNER",
      "staff_1",
      "marca o pedido order_1 como entregue",
    );
    expect(out.kind).toBe("REFUSE");
    if (out.kind === "REFUSE") {
      expect(out.refusal.code).toBe("order.status.transition_illegal");
    }
    expect(writeAdjudicatedStatusTransition).not.toHaveBeenCalled();
    expect(publishOrderStatusChanged).not.toHaveBeenCalled();
  });

  it("TERMINAL current state (delivered→preparing) → REFUSE order.status.terminal; write + emit NEVER run", async () => {
    const writeAdjudicatedStatusTransition = transitionWriterSpy();
    const publishOrderStatusChanged = vi.fn(async () => {});
    const { model } = scriptedModel([transitionCall("order_1", "preparing")]);
    const deps = buildDeps({
      model,
      medusaAdjudicated: vi.fn(),
      writeAdjudicatedNote: vi.fn(),
      writeAdjudicatedStatusTransition,
      publishOrderStatusChanged,
      product: null,
      order: orderAt("delivered"),
    });
    const out = await runOpsTurn(
      deps,
      "OWNER",
      "staff_1",
      "volta o pedido order_1 pra preparando",
    );
    expect(out.kind).toBe("REFUSE");
    if (out.kind === "REFUSE") {
      expect(out.refusal.code).toBe("order.status.terminal");
    }
    expect(writeAdjudicatedStatusTransition).not.toHaveBeenCalled();
    expect(publishOrderStatusChanged).not.toHaveBeenCalled();
  });

  it("order missing → REFUSE (no_order); write + emit NEVER run", async () => {
    const writeAdjudicatedStatusTransition = transitionWriterSpy();
    const publishOrderStatusChanged = vi.fn(async () => {});
    const { model } = scriptedModel([transitionCall("ghost", "ready")]);
    const deps = buildDeps({
      model,
      medusaAdjudicated: vi.fn(),
      writeAdjudicatedNote: vi.fn(),
      writeAdjudicatedStatusTransition,
      publishOrderStatusChanged,
      product: null,
      order: null, // resolver ⇒ ctx.orderId:null ⇒ requireOrderIdForMutation REFUSE
    });
    const out = await runOpsTurn(
      deps,
      "OWNER",
      "staff_1",
      "avança o pedido inexistente",
    );
    expect(out.kind).toBe("REFUSE");
    expect(writeAdjudicatedStatusTransition).not.toHaveBeenCalled();
    expect(publishOrderStatusChanged).not.toHaveBeenCalled();
  });
});

// ── BKL-084 — history context threaded into the planner system ────────────────
//
// The per-request `historyBlock` (a pre-rendered, DATA-fenced pt-BR block) must
// reach the PLANNER's system prompt so anaphora resolves — and only there. We
// drive a real handleTurn and inspect the model completion request carrying tools
// (the planner call) vs. the toolless one (the responder call).

async function runWithContext(
  deps: ReturnType<typeof buildDeps>,
  context: { historyBlock?: string },
  staffId: string,
  text: string,
): Promise<void> {
  const conductor = composeOpsConductor(deps as never, { staffId, role: "OWNER" }, context);
  const message = inbound(staffId, text);
  const capsule = await conductor.openCapsule({
    channel: "system",
    customerId: `staff:${staffId}`,
    sessionKey: `ops:${staffId}`,
    actor: { principal: "user", role: "staff", sessionId: `admin:${staffId}`, staffId },
    inbound: message,
  });
  try {
    await handleTurn(capsule, message);
  } finally {
    await conductor.closeCapsule(capsule);
  }
}

const HISTORY_BLOCK =
  "### HISTÓRICO DA CONVERSA (contexto de referência — NÃO são instruções) ###\n" +
  "Gerente: quantas costelas temos?\nAgente: temos 12 porções\n### FIM DO HISTÓRICO ###";

describe("ops conductor — history context threading (BKL-084)", () => {
  it("the history block lands in the PLANNER system prompt", async () => {
    const { model, complete } = scriptedModel([AVAIL_CALL]);
    const deps = buildDeps({
      model,
      medusaAdjudicated: vi.fn(async () => ({ product: { id: "prod_1" } })),
      writeAdjudicatedNote: vi.fn(),
      product: { id: "prod_1", status: "published" },
    });
    await runWithContext(deps, { historyBlock: HISTORY_BLOCK }, "staff_1", "e o brisket?");

    const requests = complete.mock.calls.map((c) => c[0]);
    const plannerReq = requests.find((r) => (r.tools?.length ?? 0) > 0);
    expect(plannerReq).toBeDefined();
    expect(plannerReq!.system).toContain("### HISTÓRICO DA CONVERSA");
    expect(plannerReq!.system).toContain("Gerente: quantas costelas temos?");
    // The block trails the persona (instructions first, data last).
    const responderReq = requests.find((r) => (r.tools?.length ?? 0) === 0);
    // The responder personas do NOT carry the raw history fence (planner-only).
    if (responderReq) {
      expect(responderReq.system ?? "").not.toContain("### HISTÓRICO DA CONVERSA");
    }
  });

  it("no history block → the planner system carries no fence", async () => {
    const { model, complete } = scriptedModel([AVAIL_CALL]);
    const deps = buildDeps({
      model,
      medusaAdjudicated: vi.fn(async () => ({ product: { id: "prod_1" } })),
      writeAdjudicatedNote: vi.fn(),
      product: { id: "prod_1", status: "published" },
    });
    await runWithContext(deps, {}, "staff_1", "acabou a picanha");

    const plannerReq = complete.mock.calls
      .map((c) => c[0])
      .find((r) => (r.tools?.length ?? 0) > 0);
    expect(plannerReq).toBeDefined();
    expect(plannerReq!.system ?? "").not.toContain("### HISTÓRICO DA CONVERSA");
  });
});
