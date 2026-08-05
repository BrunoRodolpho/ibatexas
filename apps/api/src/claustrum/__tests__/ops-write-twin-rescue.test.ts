// ops-write-twin-rescue — BKL-262 Stage 1, the PURE predicate + the declared table.
//
// The turn-seam proof lives in `apps/api/src/ops/__tests__/ops-write-twin-rescue.e2e.test.ts`
// (real handleTurn, both measured cases, the counter-case). THIS suite pins the
// predicate's five conjuncts one at a time, which the seam test cannot do without
// contorting the harness: each case below starts from a turn that DOES earn the
// rescue and breaks exactly one conjunct, so a regression names the conjunct it broke.

import { describe, expect, it } from "vitest";
import type { ClaimVerdict } from "@adjudicate/core";
import {
  isOpsWriteTwinReadRescue,
  OPS_WRITE_TWIN_READ_FAMILIES,
  type OpsWriteTwinRescueInput,
} from "../ops-write-twin-rescue.js";
import { classifyRequestSpans } from "../required-claim-decomposer.js";

const HOURS_ASK = "Qual horário de funcionamento?";
const COVERAGE_ASK = "entregam em Ibaté?";

const validated = (type: string) => ({ type, verdict: "VALIDATED" as ClaimVerdict });

/** A turn that earns the rescue: the BKL-234 hours case. */
const HOURS_RESCUE: OpsWriteTwinRescueInput = {
  decisionKind: "REFUSE",
  envelopeKinds: ["schedule.override.set"],
  claimsTerminal: "RENDER",
  perClaim: [validated("STORE_HOURS"), validated("STORE_OPEN_NOW")],
  requestText: HOURS_ASK,
};

/** A turn that earns the rescue: the LE2-013 coverage case. */
const COVERAGE_RESCUE: OpsWriteTwinRescueInput = {
  decisionKind: "REFUSE",
  envelopeKinds: ["order.note.add"],
  claimsTerminal: "RENDER",
  // The complementary pair: exactly one can ever validate; the other resolves honest
  // UNKNOWN and is dropped by the kernel's §D filter.
  perClaim: [
    validated("DELIVERY_COVERAGE"),
    { type: "DELIVERY_NO_COVERAGE", verdict: "UNKNOWN" as ClaimVerdict },
  ],
  requestText: COVERAGE_ASK,
};

describe("BKL-262 Stage 1 — the two measured cases earn the rescue", () => {
  it("the BKL-234 hours misparse earns it", () => {
    expect(isOpsWriteTwinReadRescue(HOURS_RESCUE)).toBe(true);
  });

  it("the LE2-013 coverage misparse earns it (presence-complement pair)", () => {
    expect(isOpsWriteTwinReadRescue(COVERAGE_RESCUE)).toBe(true);
  });
});

describe("BKL-262 Stage 1 — each conjunct independently declines the rescue", () => {
  it("1. a non-REFUSE decision is never rescued", () => {
    // REQUEST_CONFIRMATION and ESCALATE are rule 2's OTHER legs: park/confirm
    // semantics for legitimate action turns must be completely untouched.
    for (const decisionKind of ["REQUEST_CONFIRMATION", "ESCALATE", "EXECUTE", "REWRITE"]) {
      expect(isOpsWriteTwinReadRescue({ ...HOURS_RESCUE, decisionKind })).toBe(false);
    }
  });

  it("1b. a REFUSE with NO envelopes is not a refused mutation at all", () => {
    expect(isOpsWriteTwinReadRescue({ ...HOURS_RESCUE, envelopeKinds: [] })).toBe(false);
  });

  it("2. a non-RENDER claims terminal has no validated answer to promote", () => {
    for (const claimsTerminal of ["UNKNOWN", "CLARIFY", "ESCALATE"]) {
      expect(isOpsWriteTwinReadRescue({ ...HOURS_RESCUE, claimsTerminal })).toBe(false);
    }
  });

  it("3. a turn with NO read spans is not question-shaped", () => {
    expect(
      isOpsWriteTwinReadRescue({ ...HOURS_RESCUE, requestText: "bom dia!" }),
    ).toBe(false);
  });

  it("4. THE COUNTER-CASE — a mutation-shaped turn keeps its refusal", () => {
    // Staff really tried to change the hours. The refusal IS the message.
    const genuineMutation = "muda o horário de amanhã para 10h às 22h";

    // This is NOT excluded by conjunct 3: the schedule markers match "horário"
    // regardless of the verb, so the turn genuinely carries read spans. Conjunct 4 is
    // therefore load-bearing rather than redundant — pin that premise directly, so
    // this test cannot silently become vacuous if the span nets change.
    expect(classifyRequestSpans(genuineMutation).length).toBeGreaterThan(0);

    expect(
      isOpsWriteTwinReadRescue({ ...HOURS_RESCUE, requestText: genuineMutation }),
    ).toBe(false);
  });

  // F-27 — conjunct 4 is the OPS-PLANE consumer of `hasMutationImperative`, so the
  // `mud(?!ou|ad|aram)` narrowing lands HERE as well as on the customer plane. It is
  // the same BKL-234 defect in the preterite: staff ask whether the hours changed, the
  // roster's only schedule capability is the WRITE, the 4B mis-parses onto it, the
  // kernel refuses — and before F-27 conjunct 4 read "mudou" as a command and let the
  // fabricated prose ship even though the correct hours claim validated in the turn.
  //
  // Measured on this branch: rescue FALSE -> TRUE for all three question forms, and
  // FALSE -> FALSE for every imperative. The PAIR is what makes this non-vacuous:
  // treatment and control differ ONLY in the verb form of the same verb, so the
  // treatment cannot be passing because conjuncts 1/2/5 were relaxed.
  it("4. F-27 — a staff QUESTION in the past tense is question-shaped, not a mutation", () => {
    const QUESTIONS = [
      "o horário de funcionamento mudou?",
      "vocês mudaram o horário de funcionamento?",
      "o horário foi mudado?",
    ];
    const COMMANDS = [
      "muda o horário de amanhã para 10h às 22h",
      "mude o horário de funcionamento",
      "mudar o horário de funcionamento",
    ];
    // Both arms must carry read spans, or the pair would be decided by conjunct 3
    // rather than by conjunct 4 — the property this case is named for.
    for (const text of [...QUESTIONS, ...COMMANDS]) {
      expect(classifyRequestSpans(text).length, text).toBeGreaterThan(0);
    }
    for (const requestText of QUESTIONS) {
      expect(
        isOpsWriteTwinReadRescue({ ...HOURS_RESCUE, requestText }),
        requestText,
      ).toBe(true);
    }
    for (const requestText of COMMANDS) {
      expect(
        isOpsWriteTwinReadRescue({ ...HOURS_RESCUE, requestText }),
        requestText,
      ).toBe(false);
    }
  });

  it("5a. a refused kind absent from the twin table is never rescued", () => {
    for (const kind of [
      "payment.refund.issue",
      "order.status.transition",
      "product.price.set",
      "menu.special.set",
      "ops.alert.resolve.staff",
      "incident.ticket.close.staff",
      "product.availability.set",
    ]) {
      expect(
        isOpsWriteTwinReadRescue({ ...HOURS_RESCUE, envelopeKinds: [kind] }),
      ).toBe(false);
    }
  });

  it("5a. a twin kind whose declared span did NOT fire this turn is not rescued", () => {
    // `order.note.add` is a twin of the COVERAGE/STATUS reads, not of the hours read.
    expect(
      isOpsWriteTwinReadRescue({ ...HOURS_RESCUE, envelopeKinds: ["order.note.add"] }),
    ).toBe(false);
    // …and symmetrically.
    expect(
      isOpsWriteTwinReadRescue({
        ...COVERAGE_RESCUE,
        envelopeKinds: ["schedule.override.set"],
      }),
    ).toBe(false);
  });

  it("5a. EVERY envelope must qualify — one unrelated mutation keeps rule 2", () => {
    expect(
      isOpsWriteTwinReadRescue({
        ...HOURS_RESCUE,
        envelopeKinds: ["schedule.override.set", "payment.refund.issue"],
      }),
    ).toBe(false);
  });

  it("5b. the validated claims must ANSWER the ask, not merely exist", () => {
    // STORE_HOURS alone does not satisfy the STORE_OPEN_NOW_Q closure (BKL-121 D3
    // keeps STORE_HOURS out of REQUIRED_CLAIM_CLOSURE), so completeness fails even
    // though a claim validated. Without this conjunct the rescue would promote a
    // half-answer over the refusal.
    expect(
      isOpsWriteTwinReadRescue({
        ...HOURS_RESCUE,
        perClaim: [validated("STORE_HOURS")],
      }),
    ).toBe(false);
  });

  it("5b. an UNRELATED validated claim cannot stand in for the asked read", () => {
    expect(
      isOpsWriteTwinReadRescue({
        ...HOURS_RESCUE,
        perClaim: [validated("MENU_OVERVIEW")],
      }),
    ).toBe(false);
  });

  it("5b. a required type that FAILED to validate declines the rescue", () => {
    for (const verdict of ["UNKNOWN", "REFUSED"] as const) {
      expect(
        isOpsWriteTwinReadRescue({
          ...HOURS_RESCUE,
          perClaim: [{ type: "STORE_OPEN_NOW", verdict: verdict as ClaimVerdict }],
        }),
      ).toBe(false);
    }
  });
});

describe("BKL-262 Stage 1 — the verdict fold is the STRICT one", () => {
  it("a later VALIDATED instance cannot mask an earlier non-VALIDATED one", () => {
    // The §O#15 anti-masking rule: a type counts VALIDATED iff EVERY instance did.
    // A last-entry-wins fold would report the type satisfied and rescue this turn.
    expect(
      isOpsWriteTwinReadRescue({
        ...HOURS_RESCUE,
        perClaim: [
          { type: "STORE_OPEN_NOW", verdict: "UNKNOWN" as ClaimVerdict },
          validated("STORE_OPEN_NOW"),
        ],
      }),
    ).toBe(false);
  });

  it("…and the order of that pair does not matter", () => {
    expect(
      isOpsWriteTwinReadRescue({
        ...HOURS_RESCUE,
        perClaim: [
          validated("STORE_OPEN_NOW"),
          { type: "STORE_OPEN_NOW", verdict: "UNKNOWN" as ClaimVerdict },
        ],
      }),
    ).toBe(false);
  });
});

describe("BKL-262 Stage 1 — the twin table is CLOSED and reviewable", () => {
  it("declares exactly the two measured misparse classes", () => {
    // Growing this table is a reviewable decision that must argue the twin relation.
    // If a row is added, this test is where the reviewer is forced to look.
    expect(Object.keys(OPS_WRITE_TWIN_READ_FAMILIES).sort()).toEqual([
      "order.note.add",
      "schedule.override.set",
    ]);
  });

  it("every declared span class is one the classifier can actually produce", () => {
    // A row naming a span nothing emits would be silently dead. `satisfies` pins the
    // values to the SpanClass union at compile time; this pins the runtime reachability
    // of the specific families the two rows name.
    const reachable = new Set([
      ...classifyRequestSpans(HOURS_ASK),
      ...classifyRequestSpans("qual o horário de domingo?"),
      ...classifyRequestSpans(COVERAGE_ASK),
      ...classifyRequestSpans("cadê o pedido do cliente?"),
    ]);
    for (const families of Object.values(OPS_WRITE_TWIN_READ_FAMILIES)) {
      for (const family of families) expect(reachable).toContain(family);
    }
  });
});
