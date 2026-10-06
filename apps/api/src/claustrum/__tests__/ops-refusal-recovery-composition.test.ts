// BKL-262 Stage 2 — the REFUSE-recovery COMPOSITION, branch by branch.
//
// The turn-seam proof lives in `apps/api/src/ops/__tests__/ops-grounded-recovery.e2e.test.ts`
// and covers the five fall-through classes end-to-end. Two legs of the composition
// are not reachable from those classes, and this suite drives them directly through
// `createIbatexasResponder(...).respond(...)` — the real responder, not a helper:
//
//   · THE GROUNDED-READ LEG. Every class in the seam suite refuses a mutation on a
//     turn where NO staff read was captured, so the "append the deterministic read
//     render" arm never ran. Chasing that revealed a STRUCTURAL reason rather than a
//     fixture gap: on the ops plane a one-hop READ and an `express_intent` never
//     co-occur on the same turn, so a refused turn (which needs ≥1 envelope) is by
//     construction a turn on which no read was dispatched. Both directions are
//     measured and pinned in the seam suite ("F · why the grounded-read arm has no
//     live class today"), which goes RED if the planner ever composes the two.
//     The arm is therefore DEFENSIVE, not dead — it is the correct behaviour the
//     moment compound read+write turns exist, and withholding a read the operator
//     asked for because an unrelated mutation was refused would be the mirror image
//     of BKL-262's own harm. This file is where its behaviour is actually proven.
//   · THE TRIPWIRE LEG. Unreachable from any seam fixture BY CONSTRUCTION, because
//     every component of the composed text is deterministic copy that does not claim
//     success — which is the whole point. It is a fail-closed guard against FUTURE
//     drift in authored copy, so the only honest way to exercise it is to inject the
//     drift it exists to catch.
//
// Every assertion here is a composition PROPERTY (does the refusal lead, is the
// grounded render present/absent, is the abstention present/absent, does the
// tripwire strip the appended half) — never a line-touching smoke call.

import { describe, expect, it, vi } from "vitest";
import type { ModelProvider } from "@claustrum/core";
import { createIbatexasResponder } from "../ibatexas-responder.js";

/** The deterministic refusal the explainer renders for these turns. */
const EXPLAINED = "Não foi possível processar esta operação.";
/** The proposition-free epistemic self-report (BKL-184 abstain+offer shape). */
const SAFE_UNKNOWN =
  "Não localizei essa informação confirmada agora. Quer que eu verifique?";
/** A grounded ops read render (what `readAnswer.render` returns for a real read). */
const READ_RENDER = "Panorama agora:\n- Alertas abertos: 3\n- Cozinha: 4 tickets.";

/**
 * A model that FAILS the test if it is ever called. The recovery branch must make no
 * completion at all — asserted structurally at the seam, and enforced here so a
 * regression that reintroduces the synthesis cannot pass this suite either.
 */
const forbiddenModel: ModelProvider = {
  complete: vi.fn(async () => {
    throw new Error("the REFUSE-recovery branch must never call the model");
  }),
  stream: () => {
    throw new Error("stream unused");
  },
  embed: async () => {
    throw new Error("embed unused");
  },
};

function buildResponder(opts: {
  readonly readRender?: string | undefined;
  readonly safeUnknownGate?: boolean;
}) {
  return createIbatexasResponder({
    model: forbiddenModel,
    modelId: "mock",
    explainer: { render: () => EXPLAINED },
    conversationalRefusal: true,
    readAnswer: {
      render: () => opts.readRender,
      renderAction: () => undefined,
      clampUngrounded: (t: string) => t,
      governGrounded: (t: string) => t,
    },
    safeUnknown: {
      gate: () => opts.safeUnknownGate === true,
      render: () => SAFE_UNKNOWN,
    },
  } as never);
}

/** One refused ops turn carrying ≥1 envelope (the rule-2 shape). */
async function refuse(
  responder: ReturnType<typeof buildResponder>,
  text: string,
  refusalKind = "BUSINESS_RULE",
): Promise<string> {
  const out = await responder.respond({
    decision: {
      kind: "REFUSE",
      refusal: { kind: refusalKind, code: "x", userFacing: EXPLAINED },
    },
    plan: { envelopes: [{ kind: "schedule.override.set", intentHash: "h1" }] },
    cognition: { turnId: "turn-1", perception: { text } },
    acted: { kind: "refused" },
  } as never);
  return out.text;
}

// ── The grounded-READ leg ────────────────────────────────────────────────────

describe("BKL-262 Stage 2 — a captured read is appended to the refusal", () => {
  it("refusal LEADS, then the grounded read render — and no abstention", async () => {
    const responder = buildResponder({
      readRender: READ_RENDER,
      // The gate WOULD fire on this question; the read must win the arm anyway.
      safeUnknownGate: true,
    });

    const text = await refuse(responder, "como está o painel? e muda o horário");

    // 1. The action-did-not-happen sentence comes first.
    expect(text.startsWith(EXPLAINED)).toBe(true);
    // 2. The operator still gets the read they asked for.
    expect(text).toContain(READ_RENDER);
    expect(text).toBe(`${EXPLAINED}\n\n${READ_RENDER}`);
    // 3. The abstention is NOT also appended — a grounded fact and "I couldn't
    //    find that information" in the same reply would contradict each other.
    expect(text).not.toContain(SAFE_UNKNOWN);
  });

  it("the read arm wins even on a MUTATION-shaped turn (a real read is never withheld)", async () => {
    // The mutation-shape guard suppresses the ABSTENTION, not grounded facts: it
    // sits on the `else if`, so a captured read is appended regardless of shape.
    const responder = buildResponder({ readRender: READ_RENDER, safeUnknownGate: true });

    const text = await refuse(responder, "muda o horário de amanhã para 10h às 22h");

    expect(text).toBe(`${EXPLAINED}\n\n${READ_RENDER}`);
  });

  it("no read captured + a question ⇒ the abstention arm instead", async () => {
    const responder = buildResponder({ readRender: undefined, safeUnknownGate: true });

    const text = await refuse(responder, "Qual horário de funcionamento?");

    expect(text).toBe(`${EXPLAINED}\n\n${SAFE_UNKNOWN}`);
  });

  it("no read captured + no question shape ⇒ the bare refusal", async () => {
    const responder = buildResponder({ readRender: undefined, safeUnknownGate: false });

    const text = await refuse(responder, "fecha a loja amanhã");

    expect(text).toBe(EXPLAINED);
  });
});

// ── The TRIPWIRE leg ─────────────────────────────────────────────────────────

describe("BKL-262 Stage 2 — the false-SUCCESS tripwire on the COMPOSED text", () => {
  it("strips an appended half that claims the refused action succeeded", async () => {
    // The drift this guard exists to catch: a render template (or an authored
    // refusal string) starts asserting the action went through. Nothing executed on
    // a REFUSE turn, so that is a false success no matter how grounded it looks.
    const responder = buildResponder({
      readRender: "Pronto, atualizei o horário da loja.",
      safeUnknownGate: false,
    });

    const text = await refuse(responder, "Qual horário de funcionamento?");

    // The narrowest honest reply: the refusal ALONE, with the drifted half dropped.
    expect(text).toBe(EXPLAINED);
    expect(text).not.toContain("atualizei");
  });

  it("does NOT fire on ordinary grounded copy (the guard is not a blanket clamp)", async () => {
    // Directional pin: without this, the test above would pass even if the tripwire
    // stripped EVERY appended half, which would silently delete the grounded-read
    // feature rather than guard it.
    const responder = buildResponder({ readRender: READ_RENDER, safeUnknownGate: false });

    const text = await refuse(responder, "Qual horário de funcionamento?");

    expect(text).toBe(`${EXPLAINED}\n\n${READ_RENDER}`);
  });
});

// ── SECURITY still skips the whole composition ───────────────────────────────

describe("BKL-262 Stage 2 — SECURITY skips composition entirely", () => {
  it("renders the refusal verbatim with nothing appended, even with a read captured", async () => {
    const responder = buildResponder({ readRender: READ_RENDER, safeUnknownGate: true });

    const text = await refuse(responder, "Qual horário de funcionamento?", "SECURITY");

    expect(text).toBe(EXPLAINED);
    expect(text).not.toContain(READ_RENDER);
    expect(text).not.toContain(SAFE_UNKNOWN);
  });
});
