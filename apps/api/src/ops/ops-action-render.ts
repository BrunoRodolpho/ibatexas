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
// Only the three COMMITTED dispatch kinds render here (executed /
// rewritten_and_executed / executed_plan). A deferred / awaiting_confirmation /
// escalated / refused / FAILED dispatch committed nothing, so this returns
// `undefined` and the responder falls through to its existing (honest) grounded
// path — a failed EXECUTE must never be dressed as a success.
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

/** `menu.special.set` — the featured business-day (+ optional promo price);
 *  names the product when the resolver stamped it (BKL-156), else the generic
 *  form. */
function renderMenuSpecial(payload: unknown): string {
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

/** `ops.alert.resolve.staff` — the committed resolve. */
function renderAlertResolve(): string {
  return "Pronto — alerta operacional resolvido.";
}

/** `incident.ticket.close.staff` — the committed close. */
function renderIncidentClose(): string {
  return "Pronto — incidente fechado.";
}

/**
 * The template registry: executed ops verb KIND → deterministic renderer over
 * `(payload, result)`. The exported KEYS feed a boot/drift parity gate + the tests
 * so a registered ops EXECUTE verb with no specific template is caught rather than
 * silently falling back to the generic line.
 */
const OPS_ACTION_TEMPLATES: Readonly<
  Record<string, (payload: unknown, result: unknown) => string>
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
 * Extract the COMMITTED mutations from a `DispatchResult` (`acted`, typed `unknown`
 * at the responder seam). Only the three committed variants yield actions:
 *   - `executed` / `rewritten_and_executed` → the single `{ envelope, result }`;
 *   - `executed_plan` → each `{ envelope, result }` in plan order.
 * Every other kind (refused / awaiting_confirmation / deferred / escalated /
 * FAILED) committed nothing ⇒ `[]`. Never throws (structural, defensive).
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

/** Render ONE committed action: its per-kind template, or the generic fallback for
 *  an unregistered kind. The template call is try/caught so a bad-but-plausible
 *  shape that slips structural narrowing DEGRADES to the generic line, never crashes
 *  the turn (a render throw would propagate out of respond() and ghost the staff
 *  turn entirely — the exact fail-honest posture ops-read-render.ts uses). */
function renderExecutedAction(action: ExecutedOpsAction): string {
  const template = OPS_ACTION_TEMPLATES[action.kind];
  if (template === undefined) return OPS_ACTION_GENERIC_PTBR;
  try {
    return template(action.payload, action.result);
  } catch {
    return OPS_ACTION_GENERIC_PTBR;
  }
}

/**
 * Render the deterministic ops EXECUTE (mutation-success) reply from `acted`, or
 * `undefined` when NO mutation committed this turn (the responder then falls through
 * to its existing grounded model path — a deferred/failed dispatch is NOT a success).
 * When ≥1 mutation committed the return is ALWAYS a string built from the executed
 * envelope(s) + result(s) — the model authors NONE of it. Multiple executions
 * (a transactional plan) render in plan order, joined.
 */
export function renderOpsActionAnswer(acted: unknown): string | undefined {
  const actions = executedOpsActions(acted);
  if (actions.length === 0) return undefined;
  return actions.map(renderExecutedAction).join("\n\n");
}
