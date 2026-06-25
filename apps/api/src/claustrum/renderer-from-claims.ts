/**
 * The RENDERER-FROM-CLAIMS (SDD §J.6 / §O#3 / §O#5 / §Q.7; Inv 6; v1.1 §3).
 *
 * The thesis-closing stage (SDD §B): "the system does not generate responses; the
 * system generates validated claims, and responses are RENDERED from those claims."
 * This module is that renderer — and it is the one customer-facing surface where
 * the §O#3 ban must bite: **no customer-facing sentence is authored by a
 * probabilistic model.** `render` is a PURE deterministic template-filler over the
 * proposition-free slot grammar (`./slot-grammar.ts`); it imports no model, makes
 * no network call, reads no clock/RNG, and returns byte-identical output for
 * identical input.
 *
 * The four HARD rules it enforces (SDD §Q.7):
 *
 *   1. **Inv 6 — 1:1 proposition↔validated-claim.** Every PROPOSITION slot is
 *      filled ONLY from an independently-VALIDATED claim of that slot's exact
 *      `claimType`, reading that exact `field`. A proposition slot with no backing
 *      VALIDATED claim is UNFILLABLE → the renderer ABSTAINS for that claim (it
 *      renders a proposition-free template), never a fabricated fact.
 *
 *   2. **§O#3 — no model prose.** The renderer is deterministic; there is NO code
 *      path here that calls a model/LLM to author customer text. Static template
 *      literals + validated field values are the ONLY sources of output bytes.
 *
 *   3. **registry §5 — UNKNOWN / REFUSED are proposition-free.** A non-VALIDATED
 *      claim renders an epistemic self-report / offer ONLY (the SAFE templates) —
 *      it asserts NO domain proposition (no status / payment / order fact).
 *
 *   4. **§O#5 — the set-gate render-half does not re-leak.** When the turn terminal
 *      is `ESCALATE` / `UNKNOWN` from the set-gate (a suppression occurred), the
 *      rendered output carries ONLY the safe terminal template — it NEVER re-asserts
 *      the suppressed proposition's `value`. The renderer reads the suppression
 *      records' STRUCTURAL fields (`subject` / `conflictTypes` / `reason`) and never
 *      a `value` (the gate's `SuppressionRecord` carries no `value` by design, and
 *      this renderer never receives the suppressed claim's value either).
 *
 * Consumes the LINKED `@adjudicate/core` claims runtime (1.5.0): `ClaimVerdict`,
 * `TurnTerminal`, the `ConsistencyClaim` renderable shape, and the
 * `SuppressionRecord` proposition-free suppression record — not a stub.
 *
 * PURE & self-contained: no clock / RNG / IO, NO model import, no
 * kernel-downstream import.
 */
import type {
  ClaimVerdict,
  ConsistencyClaim,
  SuppressionRecord,
  TurnTerminal,
} from "@adjudicate/core";
import {
  isPropositionFree,
  SAFE_TEMPLATES,
  type Template,
  type TemplateSlot,
  VALIDATED_TEMPLATES,
} from "./slot-grammar.js";

/**
 * A claim as the renderer sees it: the §5/P2 `ConsistencyClaim` (subject + type +
 * verdict + value) — exactly the renderable shape the Claims kernel emits. We
 * alias it so the renderer's contract reads in claims-runtime terms.
 */
export type RenderableClaim = ConsistencyClaim;

/**
 * Fill ONE proposition slot from its backing VALIDATED claim (Inv 6). Returns the
 * field's string value IFF a VALIDATED claim of the slot's exact `claimType` is
 * present AND its `value` carries the slot's exact `field` with a non-empty value;
 * otherwise `null` — the slot is UNFILLABLE (no backing) and the caller must
 * abstain, never fabricate.
 *
 * "non-empty" mirrors registry §5: an empty / default value resolves to absence,
 * never to a confident assertion (so an empty field cannot smuggle in a blank
 * proposition).
 */
function fillProposition(
  slot: Extract<TemplateSlot, { kind: "PROPOSITION" }>,
  byType: ReadonlyMap<string, RenderableClaim>,
): string | null {
  const backing = byType.get(slot.claimType);
  // Inv 6: the backing claim must EXIST, be VALIDATED, and carry the exact field.
  if (backing === undefined || backing.verdict !== "VALIDATED") return null;
  const value = backing.value;
  if (value === null || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(record, slot.field)) return null;
  const fieldValue = record[slot.field];
  if (fieldValue === null || fieldValue === undefined) return null;
  const text = String(fieldValue);
  // Empty/blank ⟹ absence (registry §5), not a blank proposition.
  if (text.trim() === "") return null;
  return text;
}

/**
 * Render ONE template to a string by concatenating its slots. A LITERAL slot
 * contributes its static text; a PROPOSITION slot contributes its backing field
 * value. Returns `null` IFF any PROPOSITION slot is UNFILLABLE — the whole
 * template abstains rather than emit a partial/half-asserted sentence (Inv 6: no
 * unbacked assertion). A proposition-free template (no PROPOSITION slots) can never
 * be unfillable, so it always renders.
 */
function renderTemplate(
  template: Template,
  byType: ReadonlyMap<string, RenderableClaim>,
): string | null {
  const parts: string[] = [];
  for (const slot of template.slots) {
    if (slot.kind === "LITERAL") {
      parts.push(slot.text);
      continue;
    }
    const filled = fillProposition(slot, byType);
    if (filled === null) return null; // unbacked proposition ⟹ abstain (Inv 6)
    parts.push(filled);
  }
  return parts.join("");
}

/** The verdict that selects which safe (proposition-free) template a claim abstains to. */
function safeTemplateForVerdict(verdict: Exclude<ClaimVerdict, "VALIDATED">): Template {
  return verdict === "REFUSED" ? SAFE_TEMPLATES.refused : SAFE_TEMPLATES.unknown;
}

/**
 * The renderer-from-claims output. A structured result so the caller (and the
 * tests) can distinguish the terminal posture and which lines came from a fillable
 * assertion vs an abstention — while `text` is the single rendered pt-BR string.
 *
 *   - `text`     — the customer-facing rendered string (deterministic).
 *   - `terminal` — the TURN terminal this render served (echoed from input).
 *   - `lines`    — the per-line breakdown, in render order.
 */
export interface RenderResult {
  readonly text: string;
  readonly terminal: TurnTerminal;
  readonly lines: readonly RenderedLine[];
}

/**
 * One rendered line + WHY it took the form it did (for auditability — never shown
 * to the customer verbatim; `text` is the customer surface):
 *
 *   - `ASSERTION`  — a VALIDATED claim filled its template (carries `claimType`).
 *   - `ABSTENTION` — a non-VALIDATED claim rendered a proposition-free safe template.
 *   - `UNFILLABLE` — a VALIDATED claim whose template had an unbacked proposition
 *                    slot abstained (Inv 6 fail-safe).
 *   - `TERMINAL`   — the turn-terminal safe template (the §O#5 render-half for an
 *                    ESCALATE/UNKNOWN set-gate suppression).
 */
export interface RenderedLine {
  readonly kind: "ASSERTION" | "ABSTENTION" | "UNFILLABLE" | "TERMINAL";
  readonly claimType?: string;
  readonly text: string;
}

/**
 * `render(renderableClaims, terminal, suppressions) → RenderResult` — the PURE
 * template-filler (SDD §Q.7). Same inputs ⟹ byte-identical `text`.
 *
 * Algorithm (deterministic, in order):
 *
 *   1. **§O#5 render-half FIRST.** If `terminal` is NOT `RENDER` (the set-gate
 *      forced `ESCALATE` / `UNKNOWN` / `CLARIFY` — a suppression or an un-modelled
 *      pair), emit ONLY the proposition-free terminal template. We do NOT iterate
 *      the claims and we read NO suppressed `value` — the suppressed proposition
 *      can never reach the customer (the §O#5 guarantee). `suppressions` is read
 *      only for its STRUCTURAL fields if needed; it carries no `value` by design.
 *
 *   2. **RENDER path.** Index the renderable claims by type (Inv 6 1:1 lookup),
 *      then for each claim, in input order:
 *        · VALIDATED + a `validated` template exists → fill it (Inv 6). If any
 *          proposition slot is UNFILLABLE → ABSTAIN to the UNKNOWN safe template
 *          (never a fabricated fact).
 *        · VALIDATED but no modelled template → ABSTAIN (UNKNOWN) — we never
 *          free-author prose for an un-modelled type (§O#3).
 *        · UNKNOWN / REFUSED → the proposition-free safe template (registry §5).
 *
 * The output `text` is the joined lines. NO branch calls a model (§O#3); every
 * output byte is a static template literal or a VALIDATED field value.
 */
export function render(
  renderableClaims: readonly RenderableClaim[],
  terminal: TurnTerminal,
  suppressions: readonly SuppressionRecord[] = [],
): RenderResult {
  // ── 1. §O#5 render-half: a non-RENDER terminal emits ONLY the safe template. ──
  // The suppressed proposition's value never reaches here (SuppressionRecord
  // carries no `value`), and we deliberately do NOT inspect any claim's value on
  // this path — the customer sees only the system's safe posture.
  if (terminal !== "RENDER") {
    // `suppressions` is accepted and structurally available, but we read NONE of
    // its content into the output — it has no `value` field, and we add nothing
    // from it to the rendered text. This is the §O#5 no-re-leak guarantee, made
    // explicit: the terminal template is the entire customer-facing output.
    void suppressions;
    const template = terminal === "CLARIFY" ? SAFE_TEMPLATES.unknown : SAFE_TEMPLATES.escalate;
    // Defensive: a TERMINAL template MUST be proposition-free (it cannot carry a
    // domain fact). If somehow it weren't, abstain to the bare unknown line rather
    // than risk a leak.
    const text = isPropositionFree(template)
      ? (renderTemplate(template, new Map()) ?? "")
      : "";
    const line: RenderedLine = { kind: "TERMINAL", text };
    return { text, terminal, lines: [line] };
  }

  // ── 2. RENDER path: index by type for the Inv 6 1:1 proposition lookup. ──
  const byType = new Map<string, RenderableClaim>();
  for (const claim of renderableClaims) {
    // Only VALIDATED claims back a proposition (Inv 6); a non-validated duplicate
    // type must never become the backing of a slot, so we index VALIDATED only.
    if (claim.verdict === "VALIDATED" && !byType.has(claim.type)) {
      byType.set(claim.type, claim);
    }
  }

  const lines: RenderedLine[] = [];
  for (const claim of renderableClaims) {
    if (claim.verdict === "VALIDATED") {
      const template = VALIDATED_TEMPLATES[claim.type];
      if (template === undefined) {
        // Un-modelled VALIDATED type: we have no template, and §O#3 forbids
        // free-authoring one → abstain (UNKNOWN), never invent prose.
        const safe = SAFE_TEMPLATES.unknown;
        lines.push({
          kind: "ABSTENTION",
          claimType: claim.type,
          text: renderTemplate(safe, byType) ?? "",
        });
        continue;
      }
      const filled = renderTemplate(template, byType);
      if (filled === null) {
        // Inv 6 fail-safe: a proposition slot had no backing → abstain, no fact.
        const safe = SAFE_TEMPLATES.unknown;
        lines.push({
          kind: "UNFILLABLE",
          claimType: claim.type,
          text: renderTemplate(safe, byType) ?? "",
        });
        continue;
      }
      lines.push({ kind: "ASSERTION", claimType: claim.type, text: filled });
      continue;
    }
    // UNKNOWN / REFUSED → proposition-free safe template (registry §5).
    const safe = safeTemplateForVerdict(claim.verdict);
    lines.push({
      kind: "ABSTENTION",
      claimType: claim.type,
      text: renderTemplate(safe, byType) ?? "",
    });
  }

  const text = lines.map((l) => l.text).join(" ");
  return { text, terminal, lines };
}
