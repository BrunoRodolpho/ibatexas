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
  CanonicalClaim,
  ClaimVerdict,
  ConsistencyClaim,
  SuppressionRecord,
  TurnTerminal,
} from "@adjudicate/core";
import { unwrapCanonical } from "@adjudicate/core";
import { localizeClaimEnum } from "./claims-labels.js";
import {
  clarifyWithCandidatesText,
  isPropositionFree,
  SAFE_CLARIFY_COUPON_CODE_TEMPLATE,
  SAFE_CLARIFY_DELIVERY_CEP_TEMPLATE,
  SAFE_TEMPLATES,
  SAFE_UNKNOWN_ALLERGEN_TEMPLATE,
  SAFE_ESCALATE_EMERGENCY_TEMPLATE,
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
 * Inv 6 1:1 binding — WHICH claim instance backs the slot:
 *   · When the slot names the LINE claim's OWN type (`slot.claimType === self.type`
 *     — the overwhelmingly common case; every `validated` template in the grammar
 *     self-references its own type), the slot resolves to THIS `self` claim's value.
 *     This is the fix for the literal falsehood: two VALIDATED claims of the SAME
 *     type on DISTINCT owned subjects (order A "preparing", order B "in_delivery")
 *     must each render THEIR OWN value — never the first-of-type from `byType`.
 *   · When the slot names a DIFFERENT (genuinely cross-referenced) type, it falls
 *     back to the by-type index (`byType.get`). Cross-type references are absent
 *     from the current representative grammar, but the fallback preserves the
 *     designed cross-type behavior for when one is added.
 *
 * `self` is optional so the proposition-free safe/terminal templates (which never
 * reach this function — they carry no PROPOSITION slot) can render without a claim.
 *
 * "non-empty" mirrors registry §5: an empty / default value resolves to absence,
 * never to a confident assertion (so an empty field cannot smuggle in a blank
 * proposition).
 */
function fillProposition(
  slot: Extract<TemplateSlot, { kind: "PROPOSITION" }>,
  byType: ReadonlyMap<string, RenderableClaim>,
  self?: RenderableClaim,
): string | null {
  const backing =
    self !== undefined && slot.claimType === self.type ? self : byType.get(slot.claimType);
  // Inv 6: the backing claim must EXIST, be VALIDATED, and carry the exact field.
  if (backing?.verdict !== "VALIDATED") return null;
  const value = backing.value;
  if (value === null || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (!Object.hasOwn(record, slot.field)) return null;
  const fieldValue = record[slot.field];
  if (fieldValue === null || fieldValue === undefined) return null;
  // CLOSED VALUE-GRAMMAR (Plan 1 Phase 3 / W6 C6) — the rendered proposition is
  // restricted to the SAME closed scalar grammar the kernel's C6 value-binding
  // compares over (`string | number | boolean`; `@adjudicate/core` soundness
  // `withinValueGrammar`). The previous `as string | number | boolean | bigint`
  // cast was a soft "any non-empty primitive" gap — it would coerce a `bigint`,
  // and (because the cast is erased) ANY value, to a string. We now NARROW at
  // runtime: a field outside the closed scalar grammar (object / array / bigint /
  // symbol / function) is NOT a single proposition value we may assert → the slot
  // is UNFILLABLE (abstain), never a coerced blob. This pairs with C6: a rendered
  // value is only ever the ledger-bound scalar the kernel licensed (value-from-
  // ledger), so the renderer cannot widen what soundness already narrowed.
  if (
    typeof fieldValue !== "string" &&
    typeof fieldValue !== "number" &&
    typeof fieldValue !== "boolean"
  ) {
    return null;
  }
  const text = String(fieldValue);
  // Empty/blank ⟹ absence (registry §5), not a blank proposition.
  if (text.trim() === "") return null;
  // F3 — PRESENTATION-ONLY pt-BR localization (Hard Rule #4). C6 has ALREADY
  // validated the BOUND value against the ledger upstream (the kernel's
  // valueBindingVerdict); the claim's `value` here is the raw ledger enum and is
  // NOT mutated — we localize ONLY the displayed string we emit. This is keyed by
  // the slot's exact `(claimType, field)` binding, so the same enum string can
  // localize differently per slot. An unmapped enum/member degrades SAFE to the
  // raw value (never crash, never fabricate). Because we localize the DISPLAY and
  // leave the bound value untouched, C6 keeps matching the ledger entry (the value
  // binding never sees this string).
  return localizeClaimEnum(slot.claimType, slot.field, text);
}

/**
 * Render ONE template to a string by concatenating its slots. A LITERAL slot
 * contributes its static text; a PROPOSITION slot contributes its backing field
 * value. Returns `null` IFF any PROPOSITION slot is UNFILLABLE — the whole
 * template abstains rather than emit a partial/half-asserted sentence (Inv 6: no
 * unbacked assertion). A proposition-free template (no PROPOSITION slots) can never
 * be unfillable, so it always renders.
 *
 * `self` is the specific claim this template is rendering FOR (the line claim). It
 * is threaded to `fillProposition` so a self-type proposition slot binds 1:1 to
 * THIS instance's value (Inv 6), not the first-of-type index. Proposition-free
 * templates ignore it.
 */
function renderTemplate(
  template: Template,
  byType: ReadonlyMap<string, RenderableClaim>,
  self?: RenderableClaim,
): string | null {
  const parts: string[] = [];
  for (const slot of template.slots) {
    if (slot.kind === "LITERAL") {
      parts.push(slot.text);
      continue;
    }
    const filled = fillProposition(slot, byType, self);
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
/**
 * BKL-170 — the render-only view of a `disambiguationCandidates` carrier entry: the
 * renderer reads ONLY the customer-facing `label` (the `kind`/`id` are the adopter's
 * routing handles, opaque here). Structural, so the fuller 0.8.0 context type is
 * assignable.
 */
export interface RenderDisambiguationCandidate {
  readonly label: string;
}

export function render(
  canonicalClaims: readonly CanonicalClaim[],
  terminal: TurnTerminal,
  suppressions: readonly SuppressionRecord[] = [],
  candidates: readonly RenderDisambiguationCandidate[] = [],
  // BKL-184 — when the request carries allergen-family phrasing (the adapter
  // computes it via the classifier's own net), an UNKNOWN terminal renders the
  // allergen abstain-plus-handoff-offer variant. Default false → byte-identical.
  allergenAsk: boolean = false,
  // BKL-209 — when the request carries medical-emergency phrasing (the adapter
  // computes it via the deterministic net), an ESCALATE terminal renders the
  // emergency safe template. Default false → byte-identical.
  emergencyAsk: boolean = false,
  // LE2-012 — the PLANE's validated-template table. Defaults to the customer
  // grammar (`VALIDATED_TEMPLATES`), so every existing caller is byte-identical;
  // the ops plane passes customer ∪ ops templates. Purity is unaffected — the
  // table is static data, and an un-templated VALIDATED type still ABSTAINS to
  // the proposition-free UNKNOWN (§O#3), never free-authored prose.
  templates: Readonly<Record<string, Template>> = VALIDATED_TEMPLATES,
  // LE2-002 — when the request carries delivery-coverage phrasing (the adapter
  // computes it via the classifier's own net), a CLARIFY terminal renders the
  // ask-for-the-CEP variant instead of the generic "qual pedido?" disambiguation.
  // Default false → byte-identical.
  deliveryCoverageAsk: boolean = false,
  // LE2-019 — when the request carries coupon phrasing (the adapter computes it
  // via the classifier's own net), a CLARIFY terminal renders the ask-for-the-code
  // variant instead of the generic disambiguation. Default false → byte-identical.
  couponValidityAsk: boolean = false,
): RenderResult {
  // ── inv.17 ENTRY BRAND: the renderer's REQUIRED input is the kernel-minted
  // CanonicalClaim. `unwrapCanonical` asserts WeakSet provenance and THROWS on a
  // forged literal cast `as CanonicalClaim`, so the renderer CANNOT author prose from
  // a raw claim + model value — only from a claim that fully VALIDATED (incl. C6
  // value-binding) AND survived P2 into the renderable set. Each minted claim is, by
  // construction, VALIDATED, so we tag the unwrapped carrier accordingly. This closes
  // the egress loop's ENTRY (CanonicalClaim) opposite RenderedReply's EXIT brand.
  const renderableClaims: readonly RenderableClaim[] = canonicalClaims.map((c) => {
    const { subject, type, value } = unwrapCanonical(c);
    return { subject, type, value, verdict: "VALIDATED" as const };
  });
  return renderRenderables(
    renderableClaims,
    terminal,
    suppressions,
    candidates,
    allergenAsk,
    emergencyAsk,
    templates,
    deliveryCoverageAsk,
    couponValidityAsk,
  );
}

/**
 * The PURE template-filler CORE (the §Q.7 algorithm). It is the implementation
 * `render` delegates to AFTER the inv.17 provenance unwrap; it is exported for the
 * UNIT tests of the deterministic filler logic (which exercise UNKNOWN/REFUSED
 * postures the kernel-minted renderable set never carries). PRODUCTION egress goes
 * exclusively through `render` (canonical-gated) — never call this from the egress
 * path with un-minted claims.
 */
export function renderRenderables(
  renderableClaims: readonly RenderableClaim[],
  terminal: TurnTerminal,
  suppressions: readonly SuppressionRecord[] = [],
  candidates: readonly RenderDisambiguationCandidate[] = [],
  allergenAsk: boolean = false,
  emergencyAsk: boolean = false,
  templates: Readonly<Record<string, Template>> = VALIDATED_TEMPLATES,
  deliveryCoverageAsk: boolean = false,
  couponValidityAsk: boolean = false,
): RenderResult {
  // ── 1. §O#5 render-half: a non-RENDER terminal emits ONLY the safe template. ──
  if (terminal !== "RENDER") {
    return renderTerminalResult(
      terminal,
      suppressions,
      candidates,
      allergenAsk,
      emergencyAsk,
      deliveryCoverageAsk,
      couponValidityAsk,
    );
  }

  // ── 2. RENDER path: index by type for the Inv 6 1:1 proposition lookup, then
  // render each claim — in input order — to its line. ──
  const byType = indexValidatedClaims(renderableClaims);
  const lines = renderableClaims.map((claim) =>
    renderClaimLine(claim, byType, templates),
  );
  const text = lines.map((l) => l.text).join(" ");
  return { text, terminal, lines };
}

/**
 * §O#5 render-half: a non-RENDER terminal emits ONLY the proposition-free safe
 * template. The suppressed proposition's value never reaches here
 * (`SuppressionRecord` carries no `value`), and we deliberately inspect NO claim's
 * value on this path — the customer sees only the system's safe posture.
 *
 * `suppressions` is accepted and structurally available, but we read NONE of its
 * content into the output — it has no `value` field, and we add nothing from it
 * to the rendered text. This is the §O#5 no-re-leak guarantee, made explicit: the
 * terminal template is the entire customer-facing output.
 *
 * §I terminals are DISTINCT (RENDER · UNKNOWN · ESCALATE · CLARIFY): only a true
 * human-handoff ESCALATE renders the handoff copy; an honest-ignorance UNKNOWN
 * renders the epistemic SELF-REPORT, and a CLARIFY renders the disambiguation ASK
 * (BKL-148) — both proposition-free (registry §5, Inv 6), never "vou encaminhar
 * para um atendente". Conflating UNKNOWN with ESCALATE would mis-assert that the
 * system is escalating when it is merely reporting that it could not confirm; and
 * (pre-BKL-148) collapsing CLARIFY into UNKNOWN answered a disambiguation turn with
 * a bare "não localizei" instead of asking which record the customer means.
 */
function renderTerminalResult(
  terminal: TurnTerminal,
  _suppressions: readonly SuppressionRecord[],
  candidates: readonly RenderDisambiguationCandidate[] = [],
  allergenAsk: boolean = false,
  emergencyAsk: boolean = false,
  deliveryCoverageAsk: boolean = false,
  couponValidityAsk: boolean = false,
): RenderResult {
  // BKL-170 — a CLARIFY the adopter enriched with first-party, owner-scoped
  // disambiguation candidates (0.8.0 `disambiguationCandidates` carrier) renders the
  // proposition-free CLARIFY-with-candidates ask that VOICES the specific handles,
  // superseding the generic clarify. Absent/empty → the generic clarify (byte-identical
  // to pre-0.8.0). The labels are ADOPTER carrier vocabulary (never a claim value / a
  // suppressed-value re-leak), so this stays within §O#5.
  if (terminal === "CLARIFY" && candidates.length > 0) {
    const text = clarifyWithCandidatesText(candidates.map((c) => c.label));
    return {
      text,
      terminal,
      lines: [{ kind: "TERMINAL", text, claimType: SAFE_TEMPLATES.clarify.claimType }],
    };
  }
  // BKL-184 — an allergen-family ask that lands on honest ignorance renders the
  // abstain-plus-handoff-offer variant (still proposition-free — the defensive
  // isPropositionFree gate below applies to it identically). Every other UNKNOWN
  // renders the generic template, byte-identical.
  const template =
    terminal === "ESCALATE"
      ? // BKL-209 — a medical-emergency ESCALATE renders the emergency safe
        // variant (number-free directive to seek emergency care + honest limit +
        // staff notice); every other ESCALATE renders the generic handoff line,
        // byte-identical.
        emergencyAsk
        ? SAFE_ESCALATE_EMERGENCY_TEMPLATE
        : SAFE_TEMPLATES.escalate
      : terminal === "CLARIFY"
        ? // LE2-002 — a delivery-COVERAGE ask that lands on CLARIFY renders the
          // ask-for-the-CEP variant: the resolver refused to nearest-neighbour an
          // unrecognised place onto a zone, so the turn asks for the ONE datum that
          // settles it. Still proposition-free (it asserts coverage in NEITHER
          // direction); every other CLARIFY renders the generic disambiguation ask,
          // byte-identical. Deliberately BELOW the BKL-170 candidates branch above:
          // an owner-scoped ≥2-record ambiguity keeps its specific voicing, and a
          // coverage turn never carries disambiguation candidates.
          deliveryCoverageAsk
          ? SAFE_CLARIFY_DELIVERY_CEP_TEMPLATE
          : // LE2-019 — a COUPON-VALIDITY ask that lands on CLARIFY renders the
            // ask-for-the-CODE variant: the resolver refused to guess WHICH coupon
            // an utterance with no (or two) code(s) meant, so the turn asks for the
            // one datum that settles it. Still proposition-free (it asserts validity
            // in NEITHER direction); every other CLARIFY renders the generic
            // disambiguation ask, byte-identical. Ordered BELOW the delivery arm
            // only for reading order — the two nets are disjoint by vocabulary (a
            // text cannot be both a CEP-coverage and a coupon-code question), so
            // this is documentation, not precedence.
            couponValidityAsk
            ? SAFE_CLARIFY_COUPON_CODE_TEMPLATE
            : SAFE_TEMPLATES.clarify
        : allergenAsk
          ? SAFE_UNKNOWN_ALLERGEN_TEMPLATE
          : SAFE_TEMPLATES.unknown;
  // Defensive: a TERMINAL template MUST be proposition-free (it cannot carry a
  // domain fact). If somehow it weren't, abstain to the bare unknown line rather
  // than risk a leak.
  const text = isPropositionFree(template)
    ? (renderTemplate(template, new Map()) ?? "")
    : "";
  const line: RenderedLine = { kind: "TERMINAL", text, claimType: template.claimType };
  return { text, terminal, lines: [line] };
}

/**
 * Index the renderable claims by type — the CROSS-TYPE fallback for a proposition
 * slot that references a type OTHER than its line claim's own (a self-type slot
 * resolves directly from the line claim instance in `fillProposition`, NOT from
 * this index, so same-type duplicates on distinct subjects each render their own
 * value — Inv 6 1:1). Only VALIDATED claims back a proposition (Inv 6); a
 * non-validated duplicate type must never become the backing of a slot, so we index
 * VALIDATED only (first wins — this ambiguity is why self-type slots bypass it).
 */
function indexValidatedClaims(
  renderableClaims: readonly RenderableClaim[],
): Map<string, RenderableClaim> {
  const byType = new Map<string, RenderableClaim>();
  for (const claim of renderableClaims) {
    if (claim.verdict === "VALIDATED" && !byType.has(claim.type)) {
      byType.set(claim.type, claim);
    }
  }
  return byType;
}

/**
 * Render ONE renderable claim to its RenderedLine on the RENDER path (Inv 6 / §O#3):
 *   · VALIDATED + a `validated` template exists → fill it. If any proposition slot
 *     is UNFILLABLE → ABSTAIN to the UNKNOWN safe template (never a fabricated fact).
 *   · VALIDATED but no modelled template → ABSTAIN (UNKNOWN) — we never free-author
 *     prose for an un-modelled type (§O#3).
 *   · UNKNOWN / REFUSED → the proposition-free safe template (registry §5).
 */
function renderClaimLine(
  claim: RenderableClaim,
  byType: ReadonlyMap<string, RenderableClaim>,
  templates: Readonly<Record<string, Template>> = VALIDATED_TEMPLATES,
): RenderedLine {
  if (claim.verdict !== "VALIDATED") {
    // UNKNOWN / REFUSED → proposition-free safe template (registry §5).
    const safe = safeTemplateForVerdict(claim.verdict);
    return {
      kind: "ABSTENTION",
      claimType: claim.type,
      text: renderTemplate(safe, byType) ?? "",
    };
  }
  const template = templates[claim.type];
  if (template === undefined) {
    // Un-modelled VALIDATED type: we have no template, and §O#3 forbids
    // free-authoring one → abstain (UNKNOWN), never invent prose.
    return {
      kind: "ABSTENTION",
      claimType: claim.type,
      text: renderTemplate(SAFE_TEMPLATES.unknown, byType) ?? "",
    };
  }
  // Inv 6 1:1: render THIS claim instance's own value — pass `claim` so a self-type
  // proposition slot resolves from it, not the first-of-type `byType` index (two
  // VALIDATED claims of the same type on distinct subjects each render their own).
  const filled = renderTemplate(template, byType, claim);
  if (filled === null) {
    // Inv 6 fail-safe: a proposition slot had no backing → abstain, no fact.
    return {
      kind: "UNFILLABLE",
      claimType: claim.type,
      text: renderTemplate(SAFE_TEMPLATES.unknown, byType) ?? "",
    };
  }
  return { kind: "ASSERTION", claimType: claim.type, text: filled };
}
