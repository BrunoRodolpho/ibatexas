import { describe, expect, it } from "vitest";
import {
  basis,
  BASIS_CODES,
  buildEnvelope,
  decisionExecute,
  decisionRefuse,
  refuse,
  type IntentEnvelope,
  type TaintPolicy,
} from "@adjudicate/core";
import { adjudicate } from "../src/adjudicate.js";
import type { Guard, PolicyBundle } from "../src/policy.js";

type Kind = "order.tool.propose";
interface Payload {
  readonly toolName: string;
}
type State = { readonly step: "pre_order" | "shipped" | "terminal" };

const taintPolicy: TaintPolicy = {
  minimumFor: (kind) => (kind === "payment.send" ? "SYSTEM" : "UNTRUSTED"),
};

function baseEnvelope(overrides?: Partial<IntentEnvelope<Kind, Payload>>): IntentEnvelope<Kind, Payload> {
  const env = buildEnvelope<Kind, Payload>({
    kind: "order.tool.propose",
    payload: { toolName: "add_item" },
    actor: { principal: "llm", sessionId: "s-1" },
    taint: "UNTRUSTED",
    createdAt: "2026-04-23T12:00:00.000Z",
  });
  return { ...env, ...overrides } as IntentEnvelope<Kind, Payload>;
}

function bundle(
  overrides?: Partial<PolicyBundle<Kind, Payload, State>>,
): PolicyBundle<Kind, Payload, State> {
  return {
    stateGuards: [],
    authGuards: [],
    taint: taintPolicy,
    business: [],
    default: "EXECUTE",
    ...overrides,
  };
}

describe("adjudicate — default path (all guards pass)", () => {
  it("returns EXECUTE when default is EXECUTE and no guards fire", () => {
    const decision = adjudicate(baseEnvelope(), { step: "pre_order" }, bundle());
    expect(decision.kind).toBe("EXECUTE");
  });

  it("returns REFUSE when default is REFUSE and no guards fire", () => {
    const decision = adjudicate(
      baseEnvelope(),
      { step: "pre_order" },
      bundle({ default: "REFUSE" }),
    );
    expect(decision.kind).toBe("REFUSE");
  });

  it("accumulates one pass basis per category on EXECUTE", () => {
    const decision = adjudicate(baseEnvelope(), { step: "pre_order" }, bundle());
    if (decision.kind !== "EXECUTE") throw new Error("expected EXECUTE");
    // schema + state + auth + taint + business = 5 pass bases
    expect(decision.basis).toHaveLength(5);
    expect(decision.basis.map((b) => b.category)).toEqual([
      "schema",
      "state",
      "auth",
      "taint",
      "business",
    ]);
  });
});

describe("adjudicate — short-circuit order is state → auth → taint → business", () => {
  const fail = (cat: "state" | "auth" | "business"): Guard<Kind, Payload, State> => () =>
    decisionRefuse(refuse("STATE", `${cat}_fail`, "nope"), [
      basis(cat, BASIS_CODES[cat].RULE_VIOLATED ?? BASIS_CODES.state.TRANSITION_ILLEGAL),
    ]);

  it("state failure short-circuits before auth", () => {
    const decision = adjudicate(
      baseEnvelope(),
      { step: "terminal" },
      bundle({
        stateGuards: [fail("state")],
        authGuards: [fail("auth")],
      }),
    );
    expect(decision.kind).toBe("REFUSE");
    if (decision.kind !== "REFUSE") return;
    expect(decision.refusal.code).toBe("state_fail");
  });

  it("auth failure short-circuits before taint (when state passes)", () => {
    const decision = adjudicate(
      baseEnvelope(),
      { step: "pre_order" },
      bundle({
        authGuards: [fail("auth")],
      }),
    );
    expect(decision.kind).toBe("REFUSE");
    if (decision.kind !== "REFUSE") return;
    expect(decision.refusal.code).toBe("auth_fail");
  });
});

describe("adjudicate — taint gate", () => {
  it("refuses UNTRUSTED envelopes that demand SYSTEM", () => {
    const env = baseEnvelope({ kind: "payment.send" as Kind });
    const decision = adjudicate(env, { step: "pre_order" }, bundle());
    expect(decision.kind).toBe("REFUSE");
    if (decision.kind !== "REFUSE") return;
    expect(decision.refusal.kind).toBe("SECURITY");
    expect(decision.refusal.code).toBe("taint_level_insufficient");
  });

  it("passes SYSTEM envelopes that demand SYSTEM", () => {
    const env = baseEnvelope({
      kind: "payment.send" as Kind,
      taint: "SYSTEM",
    });
    const decision = adjudicate(env, { step: "pre_order" }, bundle());
    expect(decision.kind).toBe("EXECUTE");
  });
});

describe("adjudicate — schema gate", () => {
  it("refuses envelopes with an unknown version (last line of defense)", () => {
    const env = { ...baseEnvelope(), version: 999 as 1 };
    const decision = adjudicate(env, { step: "pre_order" }, bundle());
    expect(decision.kind).toBe("REFUSE");
    if (decision.kind !== "REFUSE") return;
    expect(decision.refusal.kind).toBe("SECURITY");
    expect(decision.refusal.code).toBe("schema_version_unsupported");
  });
});

describe("adjudicate — audit trail preservation", () => {
  it("includes passed bases before the short-circuit basis", () => {
    const decision = adjudicate(
      baseEnvelope(),
      { step: "pre_order" },
      bundle({
        business: [
          () =>
            decisionRefuse(
              refuse("BUSINESS_RULE", "cap", "capped"),
              [basis("business", BASIS_CODES.business.QUANTITY_CAPPED)],
            ),
        ],
      }),
    );
    if (decision.kind !== "REFUSE") throw new Error("expected REFUSE");
    // schema, state, auth, taint all passed; then the business short-circuit basis
    const categories = decision.basis.map((b) => b.category);
    expect(categories).toEqual(["schema", "state", "auth", "taint", "business"]);
    // last basis is the failure signal
    expect(decision.basis[decision.basis.length - 1]!.code).toBe("quantity_capped");
  });
});

describe("adjudicate — direct decision pass-through", () => {
  it("propagates EXECUTE from a business guard", () => {
    const decision = adjudicate(
      baseEnvelope(),
      { step: "pre_order" },
      bundle({
        default: "REFUSE",
        business: [
          () =>
            decisionExecute([
              basis("business", BASIS_CODES.business.RULE_SATISFIED),
            ]),
        ],
      }),
    );
    expect(decision.kind).toBe("EXECUTE");
  });
});
