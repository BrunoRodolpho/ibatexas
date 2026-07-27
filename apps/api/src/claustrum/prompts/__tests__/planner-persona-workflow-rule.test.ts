/**
 * BKL-275 (truncation leg) — the planner persona must TEACH the workflow surface
 * as an EXCEPTION to the express_intent rule, WITHOUT editing that rule, and the
 * golden recording must stay byte-identical to it.
 *
 * WHY THESE ARE TESTS AND NOT A COMMENT
 *
 * LE2-020 put `start_workflow` on the planner wire; nobody updated this persona,
 * which still said the model's ONLY job was `express_intent`. On a cancel turn
 * the model read an instruction that contradicted its own tool list and spent
 * the entire `max_tokens` budget trying to reconcile the two — `finish_reason:
 * "length"` with empty content, which the fleet had been reading as a refusal or
 * as engine nondeterminism (BKL-278 characterization refuted both).
 *
 * MEASURED over the 38-case extraction corpus (nemotron-3-nano:4b, epoch
 * 54cf4353d5a32564, PRODUCTION max_tokens 1024, serial, one fresh process per
 * drive, n=3 on every row that moved): `order.cancel` correct paid-cancel
 * selection 4/20 -> 18/20, truncations across the corpus 14 -> 1. Raw drives:
 * ~/projects/scratch/language-engine-2/results/raw/bkl275-truncation/.
 *
 * The persona is prompt CONTENT, so nothing downstream type-checks it. These
 * assertions are the only thing standing between a well-meaning edit and a
 * silent return of the truncation class — or, worse, a re-derivation of one of
 * the measured-and-rejected arms pinned below.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PLANNER_PERSONA } from "../personas.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SURFACES = path.join(
  HERE,
  "../../../__tests__/scripted-pipeline/fixtures/completions/surfaces.json",
);

describe("PLANNER_PERSONA — workflow-surface exception (BKL-275 truncation leg)", () => {
  it("routes a whole-order cancel to start_workflow, naming the declared workflow id", () => {
    expect(PLANNER_PERSONA).toContain("start_workflow");
    expect(PLANNER_PERSONA).toContain("workflow.orders.paid-cancel");
    expect(PLANNER_PERSONA).toContain("EXCEÇÃO — CANCELAR UM PEDIDO INTEIRO");
  });

  it("KEEPS 'cancelar' in the express_intent action list — removing it measurably loosened the whole list", () => {
    // NOT a leftover and NOT cosmetic. An earlier arm dropped "cancelar" here.
    // Measured consequence over the corpus: two reservation utterances that
    // parse correctly began emitting an INVENTED `reservation.ensure`, and an
    // escalate-band cancel invented `workflow.orders.paid-confirm`. The list's
    // authority is load-bearing; the cancel rule is an EXCEPTION to it, never an
    // edit of it. If you are here to "tidy" this line: don't.
    expect(PLANNER_PERSONA).toContain("finalizar/pagar, cancelar, adicionar");
  });

  it("scopes the exception to whole-order cancels and reasserts that everything else stays on express_intent", () => {
    const rule = PLANNER_PERSONA.slice(PLANNER_PERSONA.indexOf("EXCEÇÃO — CANCELAR"));
    // The narrowing clause is what keeps the rule from dragging reservation and
    // checkout turns onto the workflow tool.
    expect(rule).toContain("SOMENTE para cancelar um pedido inteiro");
    expect(rule).toContain("inclusive reservas e finalização de pedido");
    // `slots` pinned to an OBJECT: an arm without this emitted `"slots": ""`
    // (an empty STRING) on two phrasings.
    expect(rule).toContain("slots {}");
  });

  it("does NOT carry the rejected blanket prohibition on start_workflow for reservations", () => {
    // Measured: that wording reaches a perfect 20/20 cancel selection and is
    // STRICTLY MORE DANGEROUS — it degrades a reservation-CREATE utterance into
    // `express_intent: reservation.cancel`, a VALID capability that would
    // EXECUTE the opposite of what the customer asked. Pinned as a test so the
    // 20/20 headline cannot lure it back in.
    expect(PLANNER_PERSONA).not.toContain('NUNCA use "start_workflow" para reservas');
  });

  it("stays BYTE-IDENTICAL to the recorded golden planner surface (the header's stated invariant, now executable)", async () => {
    const surfaces = JSON.parse(await readFile(SURFACES, "utf8")) as {
      planner: { system: string };
    };
    // personas.ts says PLANNER_PERSONA "is byte-identical to the prompt recorded
    // in the golden scripted-pipeline surfaces". That was PROSE until now: the
    // scripted suite resolves completions by a content key derived from this
    // system string, so any persona edit that skips the re-record silently
    // unresolves every planner fixture. This is the gate that says so.
    expect(surfaces.planner.system).toBe(PLANNER_PERSONA);
  });
});
