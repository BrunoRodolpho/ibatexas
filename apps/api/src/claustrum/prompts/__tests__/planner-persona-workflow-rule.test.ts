/**
 * BKL-275 (truncation leg) — the planner persona must TEACH the workflow surface,
 * and the golden recording must stay byte-identical to it.
 *
 * WHY THESE ARE TESTS AND NOT A COMMENT
 *
 * LE2-020 put `start_workflow` on the planner wire; nobody updated this persona,
 * which still said the model's ONLY job was `express_intent` AND listed
 * "cancelar" among the express_intent actions. On a cancel turn the model read an
 * instruction that contradicted its own tool list and spent the entire
 * `max_tokens` budget trying to reconcile the two — `finish_reason: "length"`
 * with empty content, which the fleet had been reading as a refusal or as
 * engine nondeterminism (BKL-278 characterization refuted both).
 *
 * MEASURED on the pinned engine (nemotron-3-nano:4b, epoch 54cf4353d5a32564,
 * production max_tokens 1024, 6 cancel phrasings x n=3, serial, one fresh
 * process per drive): BEFORE 2 of 6 phrasings emitted NOTHING after burning all
 * 1024 tokens; AFTER 6 of 6 emit start_workflow{workflow:
 * "workflow.orders.paid-cancel"} — a single byte-identical response digest
 * across all six — using 98-321 tokens. Raw drives:
 * ~/projects/scratch/language-engine-2/results/raw/bkl275-truncation/.
 *
 * The persona is prompt CONTENT, so nothing downstream type-checks it; these
 * assertions are the only thing standing between a well-meaning edit and a
 * silent return of the truncation class.
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

describe("PLANNER_PERSONA — workflow-surface rule (BKL-275 truncation leg)", () => {
  it("routes a cancel of an EXISTING order to start_workflow, naming the declared workflow id", () => {
    expect(PLANNER_PERSONA).toContain("start_workflow");
    expect(PLANNER_PERSONA).toContain("workflow.orders.paid-cancel");
    expect(PLANNER_PERSONA).toContain("CANCELAR UM PEDIDO JÁ FEITO");
  });

  it("does NOT list 'cancelar' among the express_intent actions — that line is the contradiction that burned the budget", () => {
    // The exact pre-fix wording. Its RETURN reintroduces the defect, and no
    // type or downstream assertion would notice.
    expect(PLANNER_PERSONA).not.toContain(
      "finalizar/pagar, cancelar, adicionar",
    );
  });

  it("steers cancel AWAY from order.amend.remove_item, the wrong parse the model reaches for otherwise", () => {
    // Measured: with the workflow surface absent (or the rule absent and the
    // budget raised) "cancela meu pedido" resolves to order.amend.remove_item —
    // removing ONE item from a paid order instead of cancelling it.
    const rule = PLANNER_PERSONA.slice(
      PLANNER_PERSONA.indexOf("CANCELAR UM PEDIDO JÁ FEITO"),
    );
    expect(rule).toContain("order.amend.remove_item");
    expect(rule).toContain("NÃO use");
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
