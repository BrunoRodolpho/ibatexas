// delivery-coverage-resolver.ts — LE2-002 / tracker NEW-007: the SHARED
// claustrum-side resolver behind the DELIVERY_COVERAGE / DELIVERY_NO_COVERAGE
// claims ("vocês entregam em Ibaté?", "entregam no CEP 14815000?").
//
// WHY THIS EXISTS (the bug it closes): the delivery subsystem was DONE — the
// estimation tool (`@ibatexas/tools` estimateDelivery) and the admin zone CRUD
// (routes/admin/delivery-zones.ts, with its Redis cache invalidation) both shipped
// — but nothing connected either to the conversational turn. A coverage question
// therefore fell through to the lie-capable prose path, which on 2026-07-20 shipped
// an UNGROUNDED "Sim, entregamos em Ibate" with no zone read behind it. This module
// is the grounding: every coverage answer now derives from the delivery-zones
// projection or the estimation tool, and renders ONLY through claim-gated templates.
//
// WHY a SHARED per-turn-memoized resolver (the store-info-resolver.ts /
// menu-item-resolver.ts discipline): the investigator's evidence read AND the claim
// planner's value derivation BOTH need the IDENTICAL scalar within a turn so the
// kernel's C6 compares byte-equal values (PASS by construction). The memo is keyed
// on turnId + the request text; both call sites pass `cognition.turnId` and
// `perception.text`, so the ONE zone read serves both.
//
// THE THREE BRANCHES (spec Implementation Decision 4) — and the fourth, honest one:
//
//   · `covered`     — the utterance NAMES an active zone, or supplies a CEP that
//                     the estimation tool matched to one. Carries the zone name,
//                     the fee in INTEGER CENTAVOS (Hard Rule 2) and the ETA
//                     minutes, pre-composed into ONE pt-BR scalar.
//   · `not_covered` — a CEP the estimation tool resolved OUTSIDE every zone. This
//                     is a FACT read off the zone data, not an absence of one, so
//                     it is a VALIDATED negative claim ("não entregamos aí"), NOT
//                     an UNKNOWN. (The tool marks this branch by echoing the
//                     cleaned `cep` on an unsuccessful result — an invalid /
//                     unknown CEP echoes none, so the two can never be confused.)
//   · `needs_cep`   — a coverage question with NO CEP and NO zone-name match (an
//                     unrecognised place name, or a bare "vocês fazem entrega?").
//                     The resolver NEVER nearest-neighbours a place to a zone; the
//                     turn CLARIFIES and asks for the CEP.
//   · `unknown`     — the zone projection / estimation tool was UNREADABLE (a
//                     throw). "Could not check" is NOT "we don't deliver" (Inv 7),
//                     so this degrades to the honest UNKNOWN, never a negative.
//
// NO NEW READ PATH TO THE DB: the zone-name arm goes through the SAME
// `createDeliveryZoneService()` projection the admin CRUD and the estimation tool
// use; the CEP arm goes through the estimation tool VERBATIM (so the admin route's
// `invalidateDeliveryCache()` is what makes a zone edit show up in chat).
//
// PURE-ish: the only IO is the zone projection + the estimation tool. No clock/RNG.
// The memo is process-scoped and bounded; keyed by turnId so entries never leak
// across turns.

import { createDeliveryZoneService } from "@ibatexas/domain";
import { estimateDelivery } from "@ibatexas/tools";

/**
 * The LEDGER EVIDENCE KEYS this resolver's states are recorded under. Declared HERE,
 * next to the states that produce them, and imported by BOTH the investigator (which
 * records) and the claim registry / classify-only seam (which read) — so a key can
 * never drift from the state it witnesses.
 *
 * `delivery:coverage` / `delivery:no_coverage` are the COMPLEMENTARY pair backing
 * DELIVERY_COVERAGE / DELIVERY_NO_COVERAGE (claim-registry.ts): at most one is ever
 * PRESENT in a turn.
 */
export const DELIVERY_COVERAGE_KEY = "delivery:coverage";
export const DELIVERY_NO_COVERAGE_KEY = "delivery:no_coverage";

/**
 * The ledger MARKER recorded (PRESENT) when a delivery-coverage question resolved to
 * "I cannot answer this without the CEP": a place name that matched NO active zone,
 * or no place at all. Recorded ONLY on that positive determination — a READ ERROR
 * records nothing (Inv 7), so "ask me for the CEP" can never be confused with "I
 * could not check".
 *
 * It backs NO registry claim and matches no owner-scoped key prefix — it is a pure
 * routing witness, the FE-T17b marker idiom (`active_orders:` / `active_cart:`), read
 * by `deliveryCoverageNeedsCep` (classify-only-reads.ts) to force the CLARIFY.
 */
export const DELIVERY_NEEDS_CEP_MARKER_KEY = "delivery:needs_cep";

/** The resolved coverage state for a turn — see the module header's four branches. */
export type DeliveryCoverageResolution =
  | {
      readonly kind: "covered";
      /** The C6-bound pre-composed pt-BR scalar the template renders. */
      readonly coverageText: string;
      /** The matched zone's name (audit/debug; never rendered on its own). */
      readonly zoneName: string;
      /** INTEGER centavos (Hard Rule 2) — never a float, never model-authored. */
      readonly feeInCentavos: number;
      readonly estimatedMinutes: number;
    }
  | {
      readonly kind: "not_covered";
      /** The C6-bound pre-composed pt-BR scalar the negative template renders. */
      readonly noCoverageText: string;
    }
  | { readonly kind: "needs_cep" }
  | { readonly kind: "unknown" };

/**
 * Hard Rule 2 — format INTEGER centavos as pt-BR currency ("R$ 15,00"). The ONLY
 * place this module turns money into text; the model never authors a price. Pure.
 * A non-finite / non-integer input is refused by the caller before it gets here.
 */
export function formatCentavosBRL(centavos: number): string {
  const negative = centavos < 0;
  const abs = Math.abs(Math.trunc(centavos));
  const reais = Math.trunc(abs / 100);
  const cents = abs % 100;
  return `${negative ? "-" : ""}R$ ${reais},${String(cents).padStart(2, "0")}`;
}

/**
 * The DETERMINISTIC pt-BR coverage scalar (the CART_CONTENTS / STORE_INFO
 * "pre-composed serialized scalar under the frozen single-C6-field kernel" idiom).
 * Composed in CODE from the zone row's integer centavos + minutes — NEVER
 * model-authored (Hard Rule 2 / SDD §O#3). Pure.
 *
 * The soft caveat ("confirmo certinho pelo endereço no checkout") is NOT part of
 * this scalar: it is STATIC LITERAL text in the validated template (slot-grammar.ts),
 * because it asserts nothing about the world — it describes what the SYSTEM will do
 * next. Keeping it out of the proposition keeps the C6-bound value purely factual.
 */
export function composeDeliveryCoverageText(args: {
  readonly zoneName: string;
  readonly feeInCentavos: number;
  readonly estimatedMinutes: number;
}): string {
  return (
    `Sim, entregamos em ${args.zoneName} — taxa de ${formatCentavosBRL(args.feeInCentavos)} ` +
    `e prazo estimado de cerca de ${args.estimatedMinutes} minutos`
  );
}

/**
 * The DETERMINISTIC pt-BR NEGATIVE scalar. A definitive "outside every zone" from
 * the zone data is a FACT, so it renders as a VALIDATED claim — but the sentence
 * stays narrow: it says we do not deliver TO THAT CEP, never a broader claim about
 * places the zone data says nothing about. Pure.
 */
export function composeDeliveryNoCoverageText(cep: string): string {
  return `Ainda não entregamos no CEP ${formatCepForDisplay(cep)}`;
}

/** pt-BR CEP display form ("14815000" → "14815-000"). Pure. */
export function formatCepForDisplay(cep: string): string {
  const digits = cep.replaceAll(/\D/g, "");
  return digits.length === 8 ? `${digits.slice(0, 5)}-${digits.slice(5)}` : digits;
}

/**
 * Extract the ONE CEP the customer supplied, or `undefined`. Accepts the two forms
 * a customer actually types — `14815000` and `14815-000` (an internal space is NOT
 * accepted: "14815 000" is indistinguishable from two unrelated numbers). Returns
 * `undefined` when the text carries ZERO or ≥2 DISTINCT CEPs — with two, there is
 * no non-guessing way to pick one, so the turn asks (never nearest-neighbours).
 * Pure.
 *
 * The negative lookarounds keep a CEP-shaped run from matching INSIDE a longer
 * digit run (an order display number, a phone), so "pedido 148150001" is not a CEP.
 */
export function detectCepInText(text: string): string | undefined {
  const found = new Set<string>();
  for (const match of text.matchAll(/(?<!\d)(\d{5})-?(\d{3})(?!\d)/g)) {
    found.add(`${match[1]}${match[2]}`);
  }
  return found.size === 1 ? [...found][0] : undefined;
}

/**
 * Accent/case-insensitive normalization for zone-name matching ("Ibaté" ≡ "ibate").
 * Non-alphanumerics collapse to single spaces so "São Carlos" matches "sao carlos"
 * regardless of punctuation. Pure.
 */
function normalizeForMatch(value: string): string {
  return value
    .normalize("NFD")
    .replaceAll(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Does `haystack` contain `needle` as a WHOLE-TOKEN sequence? Both are already
 * normalized to single-space-separated tokens, so a padded-substring test is an
 * exact token-run test — "ibate" never matches inside "ibatezinho", and the
 * multi-word "araraquara centro" matches only as the full phrase. Pure.
 */
function containsTokenRun(haystack: string, needle: string): boolean {
  if (needle === "") return false;
  return ` ${haystack} `.includes(` ${needle} `);
}

/** The zone-projection row shape this resolver reads (a subset of DeliveryZone). */
interface DeliveryZoneRow {
  readonly name: string;
  readonly feeInCentavos: number;
  readonly estimatedMinutes: number;
  readonly active: boolean;
}

/**
 * Zone-NAME grounding: does the utterance NAME exactly one ACTIVE zone? Returns the
 * matched row, or `undefined` when zero match (→ ask for the CEP) or ≥2 distinct
 * zones match (→ ask for the CEP; two named places is not a question we may answer
 * by picking one). NEVER a nearest-neighbour / fuzzy guess — the ticket's
 * "the resolver never guesses" is enforced HERE, structurally. Pure over the rows.
 */
export function matchZoneByName(
  zones: readonly DeliveryZoneRow[],
  text: string,
): DeliveryZoneRow | undefined {
  const haystack = normalizeForMatch(text);
  const matched = zones.filter(
    (zone) => zone.active && containsTokenRun(haystack, normalizeForMatch(zone.name)),
  );
  if (matched.length === 0) return undefined;
  // A LONGER zone name is the more specific match and SUBSUMES a shorter one it
  // contains ("Araraquara Centro" vs a hypothetical "Araraquara"): keep the longest
  // and treat the rest as subsumed. Two names that do NOT subsume each other are a
  // genuine ambiguity → undefined (ask for the CEP), never a pick.
  const byLength = [...matched].sort(
    (a, b) => normalizeForMatch(b.name).length - normalizeForMatch(a.name).length,
  );
  const best = byLength[0] as DeliveryZoneRow;
  const bestNorm = normalizeForMatch(best.name);
  const unsubsumed = byLength
    .slice(1)
    .filter((zone) => !containsTokenRun(bestNorm, normalizeForMatch(zone.name)));
  return unsubsumed.length === 0 ? best : undefined;
}

/**
 * Is a zone row renderable as a coverage FACT? Guards the two numbers the template
 * asserts: a non-integer / negative fee or a non-positive ETA is corrupt data, not
 * a fact we may voice, so the caller degrades to the honest UNKNOWN. Pure.
 */
function isRenderableZone(zone: DeliveryZoneRow): boolean {
  return (
    Number.isInteger(zone.feeInCentavos) &&
    zone.feeInCentavos >= 0 &&
    Number.isInteger(zone.estimatedMinutes) &&
    zone.estimatedMinutes > 0 &&
    zone.name.trim() !== ""
  );
}

async function resolveDeliveryCoverageUncached(
  text: string,
): Promise<DeliveryCoverageResolution> {
  const cep = detectCepInText(text);

  if (cep !== undefined) {
    // CEP ARM — THROUGH THE EXISTING ESTIMATION TOOL, verbatim. It owns the
    // ViaCEP confirmation, the zone-prefix matching, and the Redis per-CEP cache
    // the admin route invalidates on every zone edit; re-implementing any of that
    // here would be a second, drifting source of truth.
    try {
      const estimate = await estimateDelivery({ cep });
      if (
        estimate.success &&
        typeof estimate.zoneName === "string" &&
        estimate.zoneName.trim() !== "" &&
        typeof estimate.feeInCentavos === "number" &&
        typeof estimate.estimatedMinutes === "number"
      ) {
        const zone = {
          name: estimate.zoneName,
          feeInCentavos: estimate.feeInCentavos,
          estimatedMinutes: estimate.estimatedMinutes,
          active: true,
        };
        if (!isRenderableZone(zone)) return { kind: "unknown" };
        return {
          kind: "covered",
          coverageText: composeDeliveryCoverageText({
            zoneName: zone.name,
            feeInCentavos: zone.feeInCentavos,
            estimatedMinutes: zone.estimatedMinutes,
          }),
          zoneName: zone.name,
          feeInCentavos: zone.feeInCentavos,
          estimatedMinutes: zone.estimatedMinutes,
        };
      }
      // The tool ECHOES the cleaned `cep` on exactly one unsuccessful branch: the
      // one where a VALID, EXISTING CEP matched NO zone (estimate-delivery.ts
      // `outOfZone`). An invalid-format or ViaCEP-unknown CEP echoes NO cep, so
      // "we checked and you're outside every zone" (a fact) is structurally
      // distinguishable from "we could not check this CEP" (not a fact).
      if (!estimate.success) {
        if (typeof estimate.cep === "string" && estimate.cep !== "") {
          return {
            kind: "not_covered",
            noCoverageText: composeDeliveryNoCoverageText(estimate.cep),
          };
        }
        // An INVALID-format or ViaCEP-unknown CEP: the customer's own datum is the
        // problem, so ASK for it again rather than assert anything in either
        // direction. (This is the only unsuccessful branch that echoes no cep.)
        return { kind: "needs_cep" };
      }
      // SUCCESS with an unusable shape (no zone name / non-numeric fee or ETA — the
      // tool's zone-LIST branch, or corrupt data). We could not determine coverage
      // for this CEP, and re-asking for a CEP the customer already gave correctly
      // would loop — so this is the honest UNKNOWN.
      return { kind: "unknown" };
    } catch {
      // Inv 7 — "could not check" is a DISTINCT state from "we don't deliver".
      return { kind: "unknown" };
    }
  }

  // ZONE-NAME ARM — the delivery-zones projection (the SAME service the admin CRUD
  // and the estimation tool read), never a new DB path.
  try {
    const zones = (await createDeliveryZoneService().listAll()) as readonly DeliveryZoneRow[];
    const zone = matchZoneByName(zones, text);
    // No named zone (an unrecognised place, or no place at all) → ask for the CEP.
    // NEVER a nearest-neighbour guess (the ticket's load-bearing constraint).
    if (zone === undefined) return { kind: "needs_cep" };
    if (!isRenderableZone(zone)) return { kind: "unknown" };
    return {
      kind: "covered",
      coverageText: composeDeliveryCoverageText({
        zoneName: zone.name,
        feeInCentavos: zone.feeInCentavos,
        estimatedMinutes: zone.estimatedMinutes,
      }),
      zoneName: zone.name,
      feeInCentavos: zone.feeInCentavos,
      estimatedMinutes: zone.estimatedMinutes,
    };
  } catch {
    return { kind: "unknown" };
  }
}

const DELIVERY_COVERAGE_MEMO_MAX = 256;
const deliveryCoverageMemo = new Map<string, Promise<DeliveryCoverageResolution>>();

function deliveryCoverageMemoSet(
  key: string,
  value: Promise<DeliveryCoverageResolution>,
): void {
  deliveryCoverageMemo.set(key, value);
  if (deliveryCoverageMemo.size > DELIVERY_COVERAGE_MEMO_MAX) {
    const oldest = deliveryCoverageMemo.keys().next().value;
    if (oldest !== undefined) deliveryCoverageMemo.delete(oldest);
  }
}

/** Test seam — clear the per-turn memo between cases. */
export function clearDeliveryCoverageMemoForTests(): void {
  deliveryCoverageMemo.clear();
}

/**
 * Resolve this turn's delivery-coverage state. `turnId` + `text` scope the memo:
 * the investigator and the claim planner MUST pass the SAME pair
 * (`cognition.turnId`, `cognition.perception.text`) so they compose the IDENTICAL
 * scalar — the same-resolver-same-text invariant menu-item-resolver.ts pins, which
 * is what makes the kernel's C6 value-binding pass by construction rather than by
 * luck.
 */
export function resolveDeliveryCoverage(
  turnId: string,
  text: string,
): Promise<DeliveryCoverageResolution> {
  const key = `${turnId} ${text}`;
  const cached = deliveryCoverageMemo.get(key);
  if (cached !== undefined) return cached;
  const pending = resolveDeliveryCoverageUncached(text);
  deliveryCoverageMemoSet(key, pending);
  return pending;
}
