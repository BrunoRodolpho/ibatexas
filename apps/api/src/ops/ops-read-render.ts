// ops-read-render.ts — deterministic pt-BR rendering of a staff ops READ answer
// (BKL-100).
//
// The ops persona's staff-facing READ answers used to be ungoverned model prose:
// the planner ran the ops read (ops_snapshot / ops_sales_analytics) in its
// one-hop enrichment loop but DISCARDED the result, so a pure read turn fell
// through to an empty plan → REFUSE → the responder's conversational branch,
// which AUTHORED numbers ("hoje foram 12 pedidos") with zero read data. That is a
// confabulated fact reaching an operator making decisions on it.
//
// This module closes that hole. A staff read answer is now EITHER deterministically
// rendered from the ACTUAL captured read result, OR an honest "não consegui
// consultar" line with ZERO digits — NEVER a model-authored number.
//
// Two seams:
//   - renderOpsReadAnswer(captures, turnId): the responder's REFUSE-empty-plan
//     branch calls this; a non-undefined return IS the reply (no model call).
//   - clampUngroundedOpsFact(text): the demote-only clamp the responder applies to
//     the model's conversational draft when NO read was captured this turn — a
//     declarative sentence stating a domain number it cannot have grounded is
//     replaced by an honest nudge to consult the panorama/vendas.
//
// pt-BR per Hard Rule #4; money via Intl.NumberFormat pt-BR/BRL (the same idiom as
// whatsapp/interactive-builders.ts); the snapshot timestamp renders in
// RESTAURANT_TIMEZONE (Hard Rule #3 — never server-local).

import {
  OPS_SNAPSHOT_READ_TOOL,
  OPS_SALES_ANALYTICS_READ_TOOL,
} from "@ibatexas/pack-ops";
import type { OpsSnapshot } from "./ops-snapshot-compose.js";
import type { SalesAnalytics } from "./sales-analytics-compose.js";

/**
 * One captured ops read from THIS turn's enrichment loop. The ops conductor wraps
 * each read executor so a run records `{name, turnId, result}` (or `{name,
 * turnId, error}` on a throw, which it RETHROWS so the planner's allSettled
 * behaviour is unchanged). `turnId` is the read executor's `CognitiveState.turnId`
 * — the SAME id the responder passes to `render` — so a render can only ever pick
 * up a read captured for its own turn.
 */
export interface CapturedOpsRead {
  readonly name: string;
  readonly turnId: string;
  /** Present on a successful read (the composer's return; validated before use). */
  readonly result?: unknown;
  /** Present on a failed read (the executor threw). */
  readonly error?: unknown;
}

// ── User-facing lines (pt-BR; the honest-degrade lines carry ZERO digits) ─────

/** The unavailable marker a degraded signal renders as — NEVER its fallback zeros. */
const INDISPONIVEL = "indisponível no momento";

/** Honest "couldn't check the snapshot" line (executor threw / bad shape). No digits. */
export const OPS_SNAPSHOT_UNAVAILABLE_PTBR =
  "Não consegui consultar o panorama operacional agora. Tenta de novo em instantes.";

/** Honest "couldn't check sales" line (executor threw / bad shape). No digits. */
export const OPS_SALES_UNAVAILABLE_PTBR =
  "Não consegui consultar as vendas de hoje agora. Tenta de novo em instantes.";

/** Honest line for an unknown/unrenderable read name. No digits. */
export const OPS_READ_UNAVAILABLE_PTBR =
  "Não consegui consultar essa informação agora. Tenta de novo em instantes.";

/** The demote-only clamp: what an ungrounded numeric claim becomes. No digits. */
export const OPS_UNGROUNDED_CLAMP_PTBR =
  "Não tenho esse número em mãos agora. Posso consultar o panorama operacional ou as vendas do dia pra te passar os valores certos.";

// ── Money + time formatting (idioms shared with the WhatsApp builders) ────────

// pt-BR BRL. Node pt-BR emits U+00A0/U+202F between "R$" and the number; normalize
// to a regular space for stable rendering across Node/ICU versions (the exact
// interactive-builders.ts idiom).
const BRL = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });

/** Format integer centavos as "R$ 1.200,00" (space-normalized). */
function brl(centavos: number): string {
  return BRL.format(centavos / 100).replace(/[\u00a0\u202f]/g, " ");
}

/**
 * Render an ISO instant as "às HH:MM" in RESTAURANT_TIMEZONE (default
 * America/Sao_Paulo) — the SAME business zone the reporting reads resolve their
 * day boundary in, never the server's local clock.
 */
function instantInRestaurantTz(iso: string): string {
  const tz = process.env.RESTAURANT_TIMEZONE ?? "America/Sao_Paulo";
  const time = new Intl.DateTimeFormat("pt-BR", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
  return `às ${time}`;
}

/** pt-BR labels for the active kitchen fulfillment statuses; raw fallback otherwise. */
const KITCHEN_STATUS_LABELS_PTBR: Readonly<Record<string, string>> = {
  pending: "pendente",
  confirmed: "confirmado",
  preparing: "preparando",
  ready: "pronto",
  in_delivery: "em entrega",
  delivered: "entregue",
  canceled: "cancelado",
};

/** Map a queue status to its pt-BR label, or the raw status if unmapped. */
function kitchenStatusLabel(status: string): string {
  return KITCHEN_STATUS_LABELS_PTBR[status] ?? status;
}

/** pt-BR labels for reservation statuses (BKL-127); raw fallback otherwise. */
const RESERVATION_STATUS_LABELS_PTBR: Readonly<Record<string, string>> = {
  pending: "pendente",
  confirmed: "confirmada",
  seated: "na mesa",
  completed: "concluída",
  cancelled: "cancelada",
  no_show: "não compareceu",
};

/** Map a reservation status to its pt-BR label, or the raw status if unmapped. */
function reservationStatusLabel(status: string): string {
  return RESERVATION_STATUS_LABELS_PTBR[status] ?? status;
}

// ── Structural validators (narrow the captured `unknown` composer return) ─────

function isRecord(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === "object";
}

function isNum(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

function isStrArray(x: unknown): x is string[] {
  return Array.isArray(x) && x.every((s) => typeof s === "string");
}

/** Structural guard for {@link OpsSnapshot} — every field the template reads. */
function isOpsSnapshot(x: unknown): x is OpsSnapshot {
  if (!isRecord(x) || typeof x.now !== "string" || !isStrArray(x.degraded)) {
    return false;
  }
  const a = x.opsAlerts;
  if (!isRecord(a) || !isNum(a.open) || !isRecord(a.bySeverity)) return false;
  const sev = a.bySeverity;
  if (!isNum(sev.low) || !isNum(sev.medium) || !isNum(sev.high)) return false;
  if (!isRecord(x.incidents) || !isNum(x.incidents.open)) return false;
  const k = x.kitchen;
  if (!isRecord(k) || !isNum(k.activeTickets) || !isNum(k.oldestTicketAgeMs)) {
    return false;
  }
  if (!Array.isArray(k.queueDepth)) return false;
  for (const q of k.queueDepth) {
    if (!isRecord(q) || typeof q.status !== "string" || !isNum(q.count)) {
      return false;
    }
  }
  const r = x.reservations;
  if (!isRecord(r) || typeof r.date !== "string" || !isNum(r.total)) return false;
  if (!Array.isArray(r.byStatus)) return false;
  for (const b of r.byStatus) {
    if (!isRecord(b) || typeof b.status !== "string" || !isNum(b.count)) {
      return false;
    }
  }
  const c = x.caixa;
  return (
    isRecord(c) &&
    typeof c.date === "string" &&
    isNum(c.ordersCount) &&
    isNum(c.grossCentavos) &&
    isNum(c.settledCentavos) &&
    isNum(c.refundedCentavos) &&
    isNum(c.netCentavos)
  );
}

/** Structural guard for {@link SalesAnalytics} — every field the template reads. */
function isSalesAnalytics(x: unknown): x is SalesAnalytics {
  if (!isRecord(x) || typeof x.now !== "string" || !isStrArray(x.degraded)) {
    return false;
  }
  const o = x.orders;
  if (
    !isRecord(o) ||
    !isNum(o.ordersCount) ||
    !isNum(o.revenueCentavos) ||
    !isNum(o.aovCentavos)
  ) {
    return false;
  }
  if (!isNum(x.activeCarts) || !isNum(x.newCustomers30d)) return false;
  const w = x.whatsapp;
  return (
    isRecord(w) &&
    isNum(w.conversionRatePct) &&
    isNum(w.avgMessagesToCheckout) &&
    isNum(w.outreachWeekly)
  );
}

// ── Deterministic templates (FULL panorama — no model-selected field extraction) ─

/** Render the situational snapshot. A degraded signal renders as INDISPONIVEL,
 *  never its fallback zeros; a bad shape returns the honest snapshot line. */
function renderSnapshot(result: unknown): string {
  if (!isOpsSnapshot(result)) return OPS_SNAPSHOT_UNAVAILABLE_PTBR;
  const degraded = new Set(result.degraded);
  const lines: string[] = [
    `Panorama operacional (${instantInRestaurantTz(result.now)}):`,
  ];

  lines.push(
    degraded.has("opsAlerts")
      ? `- Alertas abertos: ${INDISPONIVEL}.`
      : `- Alertas abertos: ${result.opsAlerts.open} (${result.opsAlerts.bySeverity.high} de alta, ${result.opsAlerts.bySeverity.medium} de média, ${result.opsAlerts.bySeverity.low} de baixa).`,
  );

  lines.push(
    degraded.has("incidents")
      ? `- Incidentes abertos: ${INDISPONIVEL}.`
      : `- Incidentes abertos: ${result.incidents.open}.`,
  );

  if (degraded.has("kitchen")) {
    lines.push(`- Cozinha: ${INDISPONIVEL}.`);
  } else {
    const mins = Math.round(result.kitchen.oldestTicketAgeMs / 60_000);
    const queue =
      result.kitchen.queueDepth.length > 0
        ? result.kitchen.queueDepth
            .map((q) => `${kitchenStatusLabel(q.status)} ${q.count}`)
            .join(", ")
        : "sem itens na fila";
    lines.push(
      `- Cozinha: ${result.kitchen.activeTickets} tickets ativos, mais antigo há ${mins} min (fila: ${queue}).`,
    );
  }

  if (degraded.has("caixa")) {
    lines.push(`- Caixa: ${INDISPONIVEL}.`);
  } else {
    lines.push(
      `- Caixa (${result.caixa.date}): ${result.caixa.ordersCount} pedidos, bruto ${brl(result.caixa.grossCentavos)}, líquido ${brl(result.caixa.netCentavos)} (recebido ${brl(result.caixa.settledCentavos)}, reembolsado ${brl(result.caixa.refundedCentavos)}).`,
    );
  }

  // BKL-127 — today's reservations ("quantas reservas hoje?").
  if (degraded.has("reservations")) {
    lines.push(`- Reservas de hoje: ${INDISPONIVEL}.`);
  } else if (result.reservations.total === 0) {
    lines.push(`- Reservas de hoje: nenhuma.`);
  } else {
    const tally = result.reservations.byStatus
      .map((b) => `${reservationStatusLabel(b.status)} ${b.count}`)
      .join(", ");
    lines.push(
      `- Reservas de hoje: ${result.reservations.total}${tally.length > 0 ? ` (${tally})` : ""}.`,
    );
  }

  return lines.join("\n");
}

/** Render today's sales analytics. A degraded signal renders as INDISPONIVEL,
 *  never its fallback zeros; a bad shape returns the honest sales line. The
 *  `orders` signal backs BOTH the pedidos + faturamento lines. */
function renderSalesAnalytics(result: unknown): string {
  if (!isSalesAnalytics(result)) return OPS_SALES_UNAVAILABLE_PTBR;
  const degraded = new Set(result.degraded);
  const lines: string[] = [`Vendas de hoje (${instantInRestaurantTz(result.now)}):`];

  if (degraded.has("orders")) {
    lines.push(`- Pedidos: ${INDISPONIVEL}.`);
    lines.push(`- Faturamento: ${INDISPONIVEL}.`);
  } else {
    lines.push(
      `- Pedidos: ${result.orders.ordersCount} (ticket médio ${brl(result.orders.aovCentavos)}).`,
    );
    lines.push(`- Faturamento: ${brl(result.orders.revenueCentavos)}.`);
  }

  lines.push(
    degraded.has("activeCarts")
      ? `- Carrinhos ativos: ${INDISPONIVEL}.`
      : `- Carrinhos ativos: ${result.activeCarts}.`,
  );

  lines.push(
    degraded.has("newCustomers30d")
      ? `- Novos clientes (30 dias): ${INDISPONIVEL}.`
      : `- Novos clientes (30 dias): ${result.newCustomers30d}.`,
  );

  lines.push(
    degraded.has("whatsapp")
      ? `- WhatsApp: ${INDISPONIVEL}.`
      : `- WhatsApp: conversão ${result.whatsapp.conversionRatePct}%, média de ${result.whatsapp.avgMessagesToCheckout} mensagens até o checkout, ${result.whatsapp.outreachWeekly} contatos proativos na semana.`,
  );

  return lines.join("\n");
}

/**
 * The template registry: advertised ops read NAME → deterministic renderer. The
 * exported KEYS feed the boot-time advertised⊆renderable drift gate
 * (`opsPlaneDriftProblems`, BKL-112 idiom) so a read advertised with no template
 * fails boot rather than silently falling back to model prose.
 */
const OPS_READ_TEMPLATES: Readonly<Record<string, (result: unknown) => string>> = {
  [OPS_SNAPSHOT_READ_TOOL]: renderSnapshot,
  [OPS_SALES_ANALYTICS_READ_TOOL]: renderSalesAnalytics,
};

/** The read names with a deterministic render template (drift-gate input). */
export const OPS_READ_RENDER_TEMPLATE_KEYS: readonly string[] =
  Object.keys(OPS_READ_TEMPLATES);

/** The honest "couldn't check" line for a read name (specific where known). */
function honestLineFor(name: string): string {
  if (name === OPS_SNAPSHOT_READ_TOOL) return OPS_SNAPSHOT_UNAVAILABLE_PTBR;
  if (name === OPS_SALES_ANALYTICS_READ_TOOL) return OPS_SALES_UNAVAILABLE_PTBR;
  return OPS_READ_UNAVAILABLE_PTBR;
}

/** Render ONE capture: honest line on a throw / unknown name, else the template
 *  (which itself degrades to the honest line on a bad shape). The template call
 *  is try/caught (adversarial-review fix): a bad-but-plausible shape that slips
 *  the structural narrowing (e.g. an unparseable `now` making
 *  Intl.DateTimeFormat.format throw RangeError) must DEGRADE to the honest line,
 *  never crash the turn — a render throw would propagate out of respond() and
 *  ghost the staff turn entirely. */
function renderCapture(capture: CapturedOpsRead): string {
  if (capture.error !== undefined) return honestLineFor(capture.name);
  const template = OPS_READ_TEMPLATES[capture.name];
  if (template === undefined) return honestLineFor(capture.name);
  try {
    return template(capture.result);
  } catch {
    return honestLineFor(capture.name);
  }
}

/**
 * Render the deterministic staff read answer for `turnId` from the captured
 * reads, or `undefined` when NO read was captured this turn (the responder then
 * falls through to its conversational model reply). When ≥1 read WAS captured the
 * return is ALWAYS a string — the full deterministic panorama for a good read, or
 * an honest zero-digit "couldn't check" line for a throw / bad shape / unknown
 * name — so a captured read can NEVER become a model-authored number.
 *
 * Multiple DISTINCT reads render as a joined panorama; a read captured more than
 * once (defensive) keeps only its LAST capture.
 */
export function renderOpsReadAnswer(
  captures: readonly CapturedOpsRead[],
  turnId: string,
): string | undefined {
  const byName = new Map<string, CapturedOpsRead>();
  for (const c of captures) {
    if (c.turnId === turnId) byName.set(c.name, c);
  }
  if (byName.size === 0) return undefined;
  return [...byName.values()].map(renderCapture).join("\n\n");
}

// ── The demote-only ungrounded-numeric-fact clamp (ops plane only) ────────────

/** Strip diacritics + lowercase so the lexicon matches accented model output. */
function normalizePtBr(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

// A domain noun whose stated number the ops persona could only know from a read.
const OPS_DOMAIN_NOUN =
  "pedidos?|vendas?|faturamento|caixas?|alertas?|incidentes?|reservas?|clientes?|tickets?|carrinhos?";
// A number, optionally money-prefixed (R$).
const OPS_NUMBER = String.raw`(?:r\$\s*)?\d`;
// number … noun (within a short window) OR noun … number — a stated domain figure.
const NUMBER_NEAR_NOUN = new RegExp(
  String.raw`${OPS_NUMBER}[\d.,]*[^.!?]{0,20}\b(?:${OPS_DOMAIN_NOUN})\b`,
);
const NOUN_NEAR_NUMBER = new RegExp(
  String.raw`\b(?:${OPS_DOMAIN_NOUN})\b[^.!?]{0,20}${OPS_NUMBER}`,
);

/** Split normalized text into sentences (window boundaries for noun adjacency). */
function sentencesOf(normalized: string): readonly string[] {
  const out: string[] = [];
  const re = /([^.!?\n;]+)[.!?\n;]*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(normalized)) !== null) {
    const body = m[1].trim();
    if (body.length > 0) out.push(body);
  }
  return out;
}

/**
 * CANONICAL number tokens in a text: contiguous digit groups possibly separated
 * by `.`/`,` collapse to their bare digits — so the model's pt-BR money format
 * ("R$ 50,00" / "R$ 4.350,00") and the acted summary's integer centavos
 * (5000 / 435000) canonicalize to the SAME token and grounded amounts are not
 * false-clamped by formatting.
 */
function numberTokens(text: string): string[] {
  return (text.match(/\d(?:[\d.,]*\d)?/g) ?? []).map((t) => t.replace(/\D/g, ""));
}

/** All canonical number tokens present in the given texts, diacritic-normalized. */
function allowedNumberTokens(sources: readonly string[]): ReadonlySet<string> {
  const tokens = new Set<string>();
  for (const source of sources) {
    if (typeof source !== "string") continue;
    for (const token of numberTokens(normalizePtBr(source))) tokens.add(token);
  }
  return tokens;
}

/** Every number token in `sentence` appears in `allowed` (grounded-by-source). */
function sentenceDigitsGrounded(
  sentence: string,
  allowed: ReadonlySet<string>,
): boolean {
  return numberTokens(sentence).every((token) => allowed.has(token));
}

/**
 * Demote-only clamp for the ops conversational fallback. Returns the honest nudge
 * {@link OPS_UNGROUNDED_CLAMP_PTBR} when the draft states a domain number (a digit
 * or R$ adjacent to a domain noun) it could not have grounded — else null (the
 * draft passes through). Two adversarial-review fixes baked in:
 *
 *  - NO question exemption: on a no-read turn EVERY domain number in the draft is
 *    ungrounded regardless of phrasing — the model's habitual trailing-engagement
 *    register ("Hoje tivemos 12 pedidos, quer que eu detalhe?") was one comma away
 *    from bypassing the whole clamp when questions were exempt.
 *  - `allowedSources` (the staff's own message, the schedule note, the acted
 *    summary on the grounded path): a sentence whose digit runs ALL appear in a
 *    source the model legitimately saw is NOT ungrounded (echoing "pedido 4242"
 *    back to the staff member must not nudge). Digit-run membership — demote-safe.
 *
 * Applied by the responder ONLY on the ops plane (the dep is present).
 */
export function clampUngroundedOpsFact(
  text: string,
  allowedSources: readonly string[] = [],
): string | null {
  if (typeof text !== "string") return null;
  const normalized = normalizePtBr(text);
  const allowed = allowedNumberTokens(allowedSources);
  for (const sentence of sentencesOf(normalized)) {
    if (!NUMBER_NEAR_NOUN.test(sentence) && !NOUN_NEAR_NUMBER.test(sentence)) {
      continue;
    }
    if (sentenceDigitsGrounded(sentence, allowed)) continue;
    return OPS_UNGROUNDED_CLAMP_PTBR;
  }
  return null;
}

/**
 * Govern a GROUNDED (EXECUTE/REWRITE/DEFER) ops draft (adversarial-review fix —
 * the grounded branch previously delivered model-authored staff numbers with
 * neither render nor clamp, and a mixed read+act turn dropped its captured read
 * entirely). Deterministic, demote-only:
 *
 *  1. When a read WAS captured this turn, the deterministic render is APPENDED to
 *     the draft — the read half of a mixed turn is answered from the ACTUAL read,
 *     never from model memory.
 *  2. The model half is digit-run clamped: a domain number not grounded in an
 *     allowed source (the acted dispatch summary, the staff's own message, the
 *     schedule note) or in the appended render replaces the model half with the
 *     honest nudge — the render half (when present) is preserved, and the
 *     dashboard's decision/executado chips carry the action outcome regardless.
 */
export function governGroundedOpsDraft(
  text: string,
  captures: readonly CapturedOpsRead[],
  turnId: string,
  allowedSources: readonly string[],
): string {
  const rendered = renderOpsReadAnswer(captures, turnId);
  const sources = rendered === undefined ? allowedSources : [...allowedSources, rendered];
  const clamped = clampUngroundedOpsFact(text, sources);
  const modelHalf = clamped ?? text;
  return rendered === undefined ? modelHalf : `${modelHalf}\n\n${rendered}`;
}
