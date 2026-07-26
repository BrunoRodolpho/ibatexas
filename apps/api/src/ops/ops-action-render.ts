// ops-action-render.ts — deterministic pt-BR rendering of an ops EXECUTE
// (mutation-success) reply from the ADJUDICATED envelope + dispatch result
// (BKL-149).
//
// The ops persona's staff-facing EXECUTE replies used to be authored by the raw
// model responder: the grounded branch prompted the model with a bounded summary
// of the acted envelope ("não inventar") and let it PROSE the "what I did"
// sentence. A live probe (turn 377ca7a1) proved that decouples the reply from the
// verb — a `schedule.override.set{date:2026-07-11, isOpen:false}` that CLOSED the
// store TOMORROW drew a model reply asserting the store was OPEN TODAY ("Hoje, a
// loja estará aberta o dia inteiro, incluindo o intervalo de almoço" — wrong day +
// wrong state). That is the BKL-100 confabulation class resurfacing on the ops
// ACTION plane: the model authored the FACT of what a mutation did.
//
// This module closes it. On a COMMITTED ops mutation the statement of WHAT THE VERB
// DID renders DETERMINISTICALLY from the executed IntentEnvelope (kind + resolved
// payload) and its dispatch result — NEVER from the model. It is the ACTION-plane
// analog of ops-read-render.ts: per-kind templates for the registered ops verbs
// (ops-tool-registry.ts) + a safe generic fallback ("Pronto — ação concluída.") so
// a newly-registered verb is never a FALSEHOOD, only LESS SPECIFIC.
//
// Only the three EXECUTED dispatch kinds render here (executed /
// rewritten_and_executed / executed_plan). A deferred / awaiting_confirmation /
// escalated / refused / FAILED dispatch ran nothing, so this returns
// `undefined` and the responder falls through to its existing (honest) grounded
// path — a failed EXECUTE must never be dressed as a success. BKL-240: that holds
// for a tool that FAILS WITHOUT THROWING too. An `executed` dispatch proves only
// that `tool.execute` did not throw, so a template ALSO abstains when the executor's
// own result does not prove its write committed. The two REACHABLE signals on this
// registry are `ops.alert.resolve.staff` / `incident.ticket.close.staff` reporting no
// `status` (their SYSTEM write's inner adjudication did not EXECUTE) and
// `menu.special.set` reporting a write that touched no row; `executorReportedFailure`
// adds a forward-looking `{ success:false }` arm for future tools.
//
// pt-BR per Hard Rule #4; money via Intl.NumberFormat pt-BR/BRL (the same idiom as
// ops-read-render.ts). A `schedule.override.set`/`menu.special.set` `date` is a
// PLAIN business-day label ("2026-07-11"), NOT an instant — it is formatted by
// splitting the ISO parts, NEVER via `new Date()` (which would shift it across the
// server/UTC boundary, the exact off-by-a-day the live falsehood already carried).

import type { OpsScheduleBlock } from "@ibatexas/pack-ops";

// ── pt-BR money + date/label formatting (self-contained; pack-ops-leaf idiom) ──

// pt-BR BRL. Node pt-BR emits U+00A0/U+202F between "R$" and the number; normalize
// to a regular space for stable rendering across Node/ICU versions (the exact
// ops-read-render.ts / interactive-builders.ts idiom).
const BRL = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });

/** Format integer centavos as "R$ 1.200,00" (space-normalized). */
function brl(centavos: number): string {
  return BRL.format(centavos / 100).replace(/[\u00a0\u202f]/g, " ");
}

/**
 * Format a PLAIN "YYYY-MM-DD" business-day label as "DD/MM/YYYY" by splitting the
 * ISO parts — never `new Date()`, so a calendar date can never shift a day across a
 * timezone boundary. A non-matching string is returned verbatim (fail-safe; the
 * caller's structural guard already vetted the field is a string).
 */
function fmtIsoDateLabel(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m === null ? iso : `${m[3]}/${m[2]}/${m[1]}`;
}

/** Format one open-day window as "Jantar das 18:00 às 23:00". */
function fmtBlock(b: OpsScheduleBlock): string {
  return `${b.label} das ${b.start} às ${b.end}`;
}

/** pt-BR labels for the six kitchen/fulfilment enum values the transition verb
 *  emits (the CLOSED contract in ops-tool-registry.ts); raw fallback otherwise. */
const ORDER_STATUS_LABELS_PTBR: Readonly<Record<string, string>> = {
  confirmed: "confirmado",
  preparing: "em preparo",
  ready: "pronto",
  in_delivery: "em entrega",
  delivered: "entregue",
  canceled: "cancelado",
};

function orderStatusLabel(status: string): string {
  return ORDER_STATUS_LABELS_PTBR[status] ?? status;
}

// ── Structural narrowing of the `unknown` payload / result ────────────────────

function isRecord(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === "object";
}

function isNum(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

/**
 * BKL-240 — the COMMITTED status the two resolution executors report, or
 * `undefined` when they reported NONE.
 *
 * `ops.alert.resolve.staff` / `incident.ticket.close.staff` are the ops verbs whose
 * failure is reachable WITHOUT a throw. Their SYSTEM-write layer adjudicates the
 * inner SYSTEM envelope itself (`withAdjudicate`) and its contract makes `result`
 * OPTIONAL — `Promise<{ readonly result?: { readonly status: string } | null }>`
 * (ops-tool-registry.ts:199 alert, :211 incident) — so a non-EXECUTE inner decision
 * yields NO result, and the executors coerce that to `status: null`
 * (ops-tool-registry.ts:732 alert, :761 incident). Nothing threw, so the dispatch is
 * `executed`, and the fixed lines ("Pronto — alerta operacional resolvido.") were
 * stated over an alert that is still OPEN.
 *
 * Both executors ALWAYS include the key (string or null), so requiring a real status
 * here misses no committed write.
 */
function committedStatusOf(result: unknown): string | undefined {
  if (!isRecord(result)) return undefined;
  const status = result.status;
  return typeof status === "string" && status.trim() !== "" ? status.trim() : undefined;
}

/**
 * BKL-156 — the resolver-stamped display-only product name (see the ops
 * resolver + `ProductAvailabilitySetPayload.productName`), or `undefined` when
 * absent/blank. When absent the render DEGRADES to the generic, name-less form
 * — never a fabricated name (the resolver only stamps a first-party resolved
 * name; a direct-id availability hit carries none).
 */
function productNameOf(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  const name = payload.productName;
  return typeof name === "string" && name.trim() !== "" ? name.trim() : undefined;
}

function isScheduleBlock(x: unknown): x is OpsScheduleBlock {
  return (
    isRecord(x) &&
    typeof x.label === "string" &&
    typeof x.start === "string" &&
    typeof x.end === "string"
  );
}

// ── The generic fallback (truthful for ANY committed verb; never a falsehood) ──

/** The safe generic success line for a committed verb with no specific template
 *  (or a payload/result that slipped structural narrowing). States only that the
 *  action completed — true of every committed mutation, specific to none. */
export const OPS_ACTION_GENERIC_PTBR = "Pronto — ação concluída.";

// ── Per-kind deterministic success templates (payload + dispatch result) ──────

/** `schedule.override.set` — the live-falsehood verb. Renders CLOSED / OPEN(+blocks)
 *  strictly from the resolved payload's `date` + `isOpen` (+ `blocks`). */
function renderScheduleOverride(payload: unknown): string {
  if (
    !isRecord(payload) ||
    typeof payload.date !== "string" ||
    typeof payload.isOpen !== "boolean"
  ) {
    return OPS_ACTION_GENERIC_PTBR;
  }
  const date = fmtIsoDateLabel(payload.date);
  if (!payload.isOpen) {
    return `Pronto — fechei a loja em ${date}.`;
  }
  const blocks = Array.isArray(payload.blocks)
    ? payload.blocks.filter(isScheduleBlock)
    : [];
  if (blocks.length === 0) {
    // Defensive: the pack validator forbids an OPEN day with no windows, so this
    // is a should-never-happen — render the truthful state without inventing hours.
    return `Pronto — marquei a loja como aberta em ${date}.`;
  }
  return `Pronto — atualizei o horário de ${date}: ${blocks.map(fmtBlock).join("; ")}.`;
}

/** `product.availability.set` — BKL-156: names the product when the resolver
 *  stamped a display name ("produto \"Picanha\" marcado como esgotado"),
 *  degrading to the generic "produto marcado…" when absent. The quoted-name +
 *  masculine "produto" head keeps pt-BR agreement safe without knowing the
 *  product noun's gender. */
function renderAvailability(payload: unknown): string {
  if (!isRecord(payload) || typeof payload.available !== "boolean") {
    return OPS_ACTION_GENERIC_PTBR;
  }
  const name = productNameOf(payload);
  const subject = name ? `produto "${name}"` : "produto";
  return payload.available
    ? `Pronto — ${subject} marcado como disponível novamente.`
    : `Pronto — ${subject} marcado como esgotado (86).`;
}

/** `product.price.set` — integer centavos → pt-BR BRL (Hard Rule #2); names the
 *  product when the resolver stamped it (BKL-156), else the generic form. */
function renderPriceSet(payload: unknown): string {
  if (!isRecord(payload) || !isNum(payload.priceCentavos)) {
    return OPS_ACTION_GENERIC_PTBR;
  }
  const name = productNameOf(payload);
  const subject = name ? `produto "${name}"` : "produto";
  return `Pronto — preço do ${subject} atualizado para ${brl(payload.priceCentavos)}.`;
}

/**
 * BKL-240 — TRUE when the `menu.special.set` executor reported that its write
 * touched NO row: `specialId: null`, propagated from the ROW-OR-NULL
 * `OpsDailySpecialWriter.update` when the day's row vanished between the `list` and
 * the `update` (ops-tool-registry.ts's `executeMenuSpecialSet`). Nothing threw, so
 * the dispatch is `executed` — but no special exists to announce.
 *
 * An ABSENT `specialId` is NOT a reported failure: this template renders from the
 * PAYLOAD, and the committed SCN-114 fixtures carry no result at all, so demanding
 * the id would silently stop rendering every one of them (the same false-FAILURE
 * trap the `!== false` polarity avoids elsewhere).
 */
function specialWriteTouchedNoRow(result: unknown): boolean {
  return (
    isRecord(result) && "specialId" in result && typeof result.specialId !== "string"
  );
}

/** `menu.special.set` — the featured business-day (+ optional promo price);
 *  names the product when the resolver stamped it (BKL-156), else the generic
 *  form. `undefined` when the executor reported that no row was written (BKL-240). */
function renderMenuSpecial(payload: unknown, result: unknown): string | undefined {
  if (specialWriteTouchedNoRow(result)) return undefined;
  if (!isRecord(payload) || typeof payload.date !== "string") {
    return OPS_ACTION_GENERIC_PTBR;
  }
  const date = fmtIsoDateLabel(payload.date);
  const name = productNameOf(payload);
  const lead = name
    ? `"${name}" definido como especial de ${date}`
    : `especial de ${date} definido`;
  return isNum(payload.promoPriceCentavos)
    ? `Pronto — ${lead} por ${brl(payload.promoPriceCentavos)}.`
    : `Pronto — ${lead}.`;
}

/** `order.note.add` — the AddNoteResult carries only ids (no display number), so
 *  the render is generic-but-truthful. */
function renderNoteAdd(): string {
  return "Pronto — observação adicionada ao pedido.";
}

/** `order.status.transition` — the committed write result carries the projection
 *  `displayId` + `newStatus` (never the model payload), so render the human order
 *  number + the pt-BR status. */
function renderStatusTransition(_payload: unknown, result: unknown): string {
  if (!isRecord(result) || typeof result.newStatus !== "string") {
    return OPS_ACTION_GENERIC_PTBR;
  }
  const status = orderStatusLabel(result.newStatus);
  return isNum(result.displayId)
    ? `Pronto — pedido #${result.displayId} agora está ${status}.`
    : `Pronto — pedido atualizado para ${status}.`;
}

/** `payment.refund.issue` — the committed write result carries the real
 *  `refundAmountCentavos` (never the model), rendered as pt-BR BRL. */
function renderRefund(_payload: unknown, result: unknown): string {
  if (!isRecord(result) || !isNum(result.refundAmountCentavos)) {
    return OPS_ACTION_GENERIC_PTBR;
  }
  return `Pronto — reembolso de ${brl(result.refundAmountCentavos)} emitido.`;
}

/** `ops.alert.resolve.staff` — the committed resolve. `undefined` when the SYSTEM
 *  write reported NO status (BKL-240: the inner adjudication did not EXECUTE, so the
 *  alert is still open — see `committedStatusOf`). */
function renderAlertResolve(_payload: unknown, result: unknown): string | undefined {
  if (committedStatusOf(result) === undefined) return undefined;
  return "Pronto — alerta operacional resolvido.";
}

/** `incident.ticket.close.staff` — the committed close. `undefined` when the SYSTEM
 *  write reported NO status (BKL-240 — same posture as the alert sibling). */
function renderIncidentClose(_payload: unknown, result: unknown): string | undefined {
  if (committedStatusOf(result) === undefined) return undefined;
  return "Pronto — incidente fechado.";
}

/**
 * The template registry: executed ops verb KIND → deterministic renderer over
 * `(payload, result)`. The exported KEYS feed a boot/drift parity gate + the tests
 * so a registered ops EXECUTE verb with no specific template is caught rather than
 * silently falling back to the generic line.
 *
 * BKL-240 — a template returns `undefined` when the executor's OWN result proves no
 * commit for that kind (`ops.alert.resolve.staff` / `incident.ticket.close.staff`
 * reporting no status; `menu.special.set` reporting a write that touched no row).
 * The whole turn then falls to the honest grounded path.
 */
const OPS_ACTION_TEMPLATES: Readonly<
  Record<string, (payload: unknown, result: unknown) => string | undefined>
> = {
  "schedule.override.set": renderScheduleOverride,
  "product.availability.set": renderAvailability,
  "product.price.set": renderPriceSet,
  "menu.special.set": renderMenuSpecial,
  "order.note.add": renderNoteAdd,
  "order.status.transition": renderStatusTransition,
  "payment.refund.issue": renderRefund,
  "ops.alert.resolve.staff": renderAlertResolve,
  "incident.ticket.close.staff": renderIncidentClose,
};

/** The ops EXECUTE verb kinds with a specific success template (parity-gate input). */
export const OPS_ACTION_RENDER_TEMPLATE_KEYS: readonly string[] =
  Object.keys(OPS_ACTION_TEMPLATES);

/** One committed mutation extracted from the dispatch result (kind + resolved
 *  payload + the executor's return). */
export interface ExecutedOpsAction {
  readonly kind: string;
  readonly payload: unknown;
  readonly result: unknown;
}

/**
 * Extract the DISPATCHED mutations from a `DispatchResult` (`acted`, typed `unknown`
 * at the responder seam). Only the three dispatched-successfully variants yield
 * actions:
 *   - `executed` / `rewritten_and_executed` → the single `{ envelope, result }`;
 *   - `executed_plan` → each `{ envelope, result }` in plan order.
 * Every other kind (refused / awaiting_confirmation / deferred / escalated /
 * FAILED) ran nothing ⇒ `[]`. Never throws (structural, defensive).
 *
 * BKL-240 — a returned action means the tool call RETURNED WITHOUT THROWING, NOT
 * that the executor COMMITTED: @claustrum's dispatcher decides `executed` vs
 * `failed` purely on whether `tool.execute` threw (execution/dispatch.js — it never
 * inspects the returned value), so a tool that RETURNS a `{ success:false }` result
 * lands here as fully `executed`. Callers that state a business outcome MUST consult
 * `result.success` themselves (see `renderOpsActionAnswer` below); this function is
 * deliberately outcome-BLIND, because `customer-action-render.ts` reuses it as the
 * plane-neutral envelope+result extractor and applies its own per-kind gates.
 */
export function executedOpsActions(acted: unknown): ExecutedOpsAction[] {
  if (!isRecord(acted) || typeof acted.kind !== "string") return [];
  if (acted.kind === "executed" || acted.kind === "rewritten_and_executed") {
    const env = acted.envelope;
    if (isRecord(env) && typeof env.kind === "string") {
      return [{ kind: env.kind, payload: env.payload, result: acted.result }];
    }
    return [];
  }
  if (acted.kind === "executed_plan") {
    const execs = acted.executions;
    if (!Array.isArray(execs)) return [];
    const out: ExecutedOpsAction[] = [];
    for (const e of execs) {
      if (isRecord(e) && isRecord(e.envelope) && typeof e.envelope.kind === "string") {
        out.push({ kind: e.envelope.kind, payload: e.envelope.payload, result: e.result });
      }
    }
    return out;
  }
  return [];
}

/** Render ONE dispatched action: its per-kind template, or the generic fallback for
 *  an unregistered kind. `undefined` when the template proved the executor did NOT
 *  commit (BKL-240). The template call is try/caught so a bad-but-plausible
 *  shape that slips structural narrowing DEGRADES to the generic line, never crashes
 *  the turn (a render throw would propagate out of respond() and ghost the staff
 *  turn entirely — the exact fail-honest posture ops-read-render.ts uses). */
function renderExecutedAction(action: ExecutedOpsAction): string | undefined {
  const template = OPS_ACTION_TEMPLATES[action.kind];
  if (template === undefined) return OPS_ACTION_GENERIC_PTBR;
  try {
    return template(action.payload, action.result);
  } catch {
    return OPS_ACTION_GENERIC_PTBR;
  }
}

/**
 * BKL-240 — did the executor EXPLICITLY report failure via a `success` flag? Every
 * template above states a COMPLETED mutation ("Pronto — fechei a loja em
 * 11/07/2026."), and template selection keyed on `action.kind` alone asserts that on
 * the strength of DISPATCH MECHANICS (see `executedOpsActions`): a tool that RETURNS
 * a failure instead of throwing draws the full success line — a false success
 * reported to STAFF, who then act on it (the operator believes the store is closed
 * for the day, the refund is out, the incident is shut).
 *
 * This is the FORWARD-LOOKING arm of the gate. No ops executor sets `success` today —
 * they return domain-shaped write projections (`{ newStatus, displayId }`,
 * `{ refundAmountCentavos, … }`, `{ date, isOpen }`) — so it fires on nothing in the
 * current registry; the REACHABLE ops failure signals are per-kind committed SHAPES
 * (`committedStatusOf` for the two resolution verbs, `specialWriteTouchedNoRow` for
 * menu.special.set) and are enforced inside those templates. It is kept because the
 * cost is one comparison and any future ops tool that adopts the customer plane's
 * `{ success:false }` convention inherits the safety without touching this file.
 *
 * Polarity is `success === false` — abstain only on a REPORTED failure, never on a
 * merely unproven one — the ratified BKL-247 gate rather than checkout's `=== true`.
 * Since every current result omits `success`, `=== true` would silently stop
 * rendering EVERY registered verb and reintroduce the false-FAILURE this module was
 * built to kill.
 */
function executorReportedFailure(action: ExecutedOpsAction): boolean {
  return isRecord(action.result) && action.result.success === false;
}

/**
 * Render the deterministic ops EXECUTE (mutation-success) reply from `acted`, or
 * `undefined` when NO mutation was dispatched this turn (the responder then falls
 * through to its existing grounded model path — a deferred/failed dispatch is NOT a
 * success), or when any dispatched executor's own result FAILS to prove it committed
 * (BKL-240). Otherwise the return is a string built from the executed envelope(s) +
 * result(s) — the model authors NONE of it. Multiple executions (a transactional
 * plan) render in plan order, joined.
 *
 * BKL-240 — the outcome check is turn-WIDE, not per-action: on a mixed transactional
 * plan (one committed, one not) rendering only the successful lines would read as a
 * COMPLETE success for the turn and silently swallow the failure. Abstaining hands the
 * whole turn to the SAFE path this function already uses for a failed dispatch — the
 * grounded model path, which voices the executor's own failure from the bounded acted
 * summary, exactly as it did before BKL-149.
 */
export function renderOpsActionAnswer(acted: unknown): string | undefined {
  const actions = executedOpsActions(acted);
  if (actions.length === 0) return undefined;
  if (actions.some(executorReportedFailure)) return undefined;
  const lines: string[] = [];
  for (const action of actions) {
    const line = renderExecutedAction(action);
    // A template that abstained proved the executor did not commit for its kind.
    if (line === undefined) return undefined;
    lines.push(line);
  }
  return lines.join("\n\n");
}
