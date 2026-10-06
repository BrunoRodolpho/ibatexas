// pairing-resolver.ts — LE2-029: the SHARED claustrum-side resolver behind the
// MENU_PAIRINGS / MENU_SUBSTITUTIONS claims ("o que combina com brisket?", "não
// tem costela, o que eu peço no lugar?").
//
// WHAT THIS EXISTS FOR (ticket 29): pairing and substitution advice becomes a
// GROUNDED READ over the house's OWN authored graph (`@ibatexas/catalog`'s
// `PAIRING_GRAPH`) instead of model prose. Today a "what goes with X" question
// has no grounded answer at all — the only thing that could produce one is the
// responder's prose path, which is precisely the confabulation surface this
// program is retiring. Every suggestion this module speaks is an edge a human
// authored and a reviewer approved.
//
// ── THE TWO RELATIONS ARE TWO CLAIMS, NOT ONE WITH A FLAG ────────────────────
// `pairs-with` invites an ADDITION ("vai bem com"); `substitutes-for` answers an
// ABSENCE ("no lugar"). They are different acts with different static frames, and
// under the frozen single-C6-field kernel one type would have to hide the whole
// difference inside its one scalar, leaving a template frame that can say nothing
// true in both branches. That is the same argument the DELIVERY_COVERAGE and
// COUPON_VALID pairs made, and it holds identically here.
//
// They are a PRESENCE COMPLEMENT: the utterance is classified as one ask or the
// other, so at most one key is ever recorded in a turn and the pair can never
// render a contradiction. Registered in PRESENCE_COMPLEMENT_PAIRS
// (required-claim-decomposer.ts) in the same commit as the §O#15 closure row —
// omitting that registration is the LE2-002 latent defect, and it would make this
// span's completeness STRUCTURALLY unsatisfiable.
//
// ── THE FOUR BRANCHES ────────────────────────────────────────────────────────
//
//   · `pairings`      — a subject resolved AND the graph has `pairs-with` edges
//                       for it whose objects EXIST in the live catalog. Carries
//                       the suggestion sentence, composed in CODE.
//   · `substitutions` — the same for `substitutes-for`.
//   · `unknown`       — everything else: no subject resolved, an item the graph
//                       has never heard of, or a subject with no edges of the
//                       asked-about relation. ALL of it degrades to the honest
//                       UNKNOWN, and the reason that is right rather than lazy is
//                       the next section.
//
// There is deliberately NO validated-negative branch, and this is where this
// module DIVERGES from its COUPON_VALID/COUPON_INVALID precedent. A promotion
// lookup is COMPLETE — Medusa holds every promotion the store has, so "no such
// code" is a FACT and COUPON_INVALID is an honest validated "no". The pairing
// graph is the opposite: it is an avowedly PARTIAL seed (ten edges, `PAIRING_GRAPH`
// says so in its own header), grown by owner review. "We have no pairing recorded
// for X" would reach the customer as "nothing goes with X", which is false — the
// house simply has not written it down yet. Absence of an edge is not evidence of
// absence of a pairing, so the empty case is Inv 7's "could not check", never a
// confident negative. Ticket 29 asks for exactly this: "unknown item or empty
// pairing data → honest unknown".
//
// ── EVERY SPOKEN NAME IS LEDGER-SOURCED ──────────────────────────────────────
// The graph holds kebab-case HANDLES, which no customer should ever be shown, and
// which the catalog deliberately never proves resolve to anything (a compiler that
// read the live store would compile differently on two machines — see
// `src/pairing-graph.ts` on the deferred reconciliation decision).
//
// So the runtime closes that hole where it CAN be closed honestly: every handle is
// resolved through `resolveMenuItem` — the SAME per-turn-memoized read
// MENU_ITEM_PRICE uses — and what gets spoken is the product's OWN `title` from the
// live catalog, never the handle and never a de-kebabed guess at its pt-BR spelling
// (Hard Rule 4). A handle that resolves to NOTHING is silently DROPPED from the
// suggestion list, which is the only honest thing to do with an edge pointing at
// something the store no longer sells; if every object drops, the branch is
// `unknown`. A typo'd handle therefore costs a suggestion, never a wrong one.
//
// ── ALIAS-CANONICALIZED INPUT (LE2-025b) ─────────────────────────────────────
// The subject is found by running the catalog's OWN canonicalizer over the request
// text, so "o que combina com brisket" and "o que combina com brisket-americano"
// reach the same edges. Canonicalization is otherwise PLANNER-LOCAL (it never
// mutates `perception.text`, so a handle can never leak into responder prose), and
// this module calls the same pure function rather than depending on that rewrite —
// which is what lets the read work identically on every surface.
//
// An AMBIGUOUS surface ("costela" — two products, different prices and different
// fulfilment) resolves to nothing here, exactly as it does at parse entry: the
// canonicalizer declines to guess, so this read finds no subject and degrades to
// the honest UNKNOWN rather than answering about the wrong costela.
//
// ── WHAT THIS MODULE IS NOT ──────────────────────────────────────────────────
// It is a PURE READ. There is no cart mutation, no intent envelope, and no
// "shall I add it for you" — a suggestion is information, and turning it into an
// offer to act would put a mutation on a read span (the BKL-201/206 discipline).
//
// It is also NOT allergen-aware and must never be read as though it were. The
// graph asserts TASTE, never ingredients, and the compiler forbids it from
// encoding allergen or dietary semantics at all (see
// `packages/catalog/src/compiler/passes/pairing-graph.ts`).
//
// This header previously asserted that §O#9's closed-taxonomy safety routing
// escalates a marker-carrying utterance ("o que combina com brisket que seja sem
// glúten?") before this read is consulted. MEASURED, IT DOES NOT — the read now
// carries its own `isAllergenFamilyAsk` guard, and the whole argument is written
// out at that guard in `resolvePairingsUncached` below.
//
// PURE-ish: the only IO is `resolveMenuItem`'s catalog read. The memo is
// process-scoped, bounded, and keyed by turnId so entries never leak across turns.

import {
  PAIRING_GRAPH,
  type PairingEdge,
  type PairingRelation,
} from "@ibatexas/catalog";
import { canonicalizeAliases } from "./alias-canonicalization.js";
// The ASK classifier lives in the PURE `required-claim-decomposer.ts` (no IO)
// precisely so that module — which the render adapter and most of the claims
// layer import — never gains a catalog client just to classify a span. The same
// split `isCouponValidityAsk` takes, and the reason the span and this read can
// never disagree about which relation was asked for.
import {
  classifyPairingAsk,
  isAllergenFamilyAsk,
  isBothPairingAsk,
} from "./required-claim-decomposer.js";
import {
  resolveMenuItem,
  type MenuItemResolveContext,
} from "./menu-item-resolver.js";

/**
 * The LEDGER EVIDENCE KEYS this resolver's states are recorded under. Declared
 * HERE, next to the states that produce them, and imported by BOTH the
 * investigator (which records) and the claim registry / classify-only seam (which
 * read) — so a key can never drift from the state it witnesses.
 *
 * The COMPLEMENTARY pair backing MENU_PAIRINGS / MENU_SUBSTITUTIONS: at most one
 * is ever PRESENT in a turn.
 */
export const MENU_PAIRINGS_KEY = "menu:pairings";
export const MENU_SUBSTITUTIONS_KEY = "menu:substitutions";

/** The resolved pairing state for a turn — see the module's four branches. */
export type PairingResolution =
  | {
      readonly kind: "pairings";
      /** The C6-bound pre-composed pt-BR scalar the positive template renders. */
      readonly suggestionsText: string;
      /** The subject handle the read answered about (audit/debug). */
      readonly subject: string;
    }
  | {
      readonly kind: "substitutions";
      /** The C6-bound pre-composed pt-BR scalar the substitution template renders. */
      readonly substitutionsText: string;
      readonly subject: string;
    }
  | { readonly kind: "unknown" };

// ── Finding the SUBJECT ──────────────────────────────────────────────────────

/** Every handle the graph can answer about, as whole-token search keys. */
const SUBJECT_HANDLES: ReadonlySet<string> = new Set(
  PAIRING_GRAPH.map((edge) => edge.subject),
);

/**
 * The pairing-graph subject this utterance names, or `undefined`.
 *
 * Runs the catalog's OWN canonicalizer first, so a colloquial ("brisket") and the
 * canonical handle ("brisket-americano") find the same subject. An AMBIGUOUS
 * surface resolves to nothing — the canonicalizer declines to guess, and so does
 * this. Pure.
 *
 * Matching is on whole handle occurrences in the canonical text, longest first,
 * so `pulled-pork-congelado` is never read as `pulled-pork`.
 */
/** Does `needle` occur in `haystack` as a whole token (not inside a longer one)? */
function occursWholeToken(haystack: string, needle: string): boolean {
  for (let from = 0; ; ) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) return false;
    const before = at === 0 ? "" : (haystack[at - 1] ?? "");
    const after = haystack[at + needle.length] ?? "";
    if (!/[a-z0-9-]/.test(before) && !/[a-z0-9-]/.test(after)) return true;
    from = at + 1;
  }
}

export function findPairingSubject(text: string): string | undefined {
  const canonical = canonicalizeAliases(text).text.toLowerCase();
  // Longest first, so `pulled-pork-congelado` is never read as `pulled-pork`.
  const candidates = [...SUBJECT_HANDLES].sort((a, b) => b.length - a.length);
  return candidates.find(
    (handle) =>
      occursWholeToken(canonical, handle) ||
      // …and the SPACED form of the same handle.
      //
      // MEASURED GAP, not a defensive extra. A customer who types the product's
      // real name writes it with spaces ("o que combina com a costela bovina
      // defumada?"), and the alias canonicaliser does NOT turn that into the
      // handle: its idempotence pre-pass CONSUMES an already-canonical spaced
      // name without rewriting it, deliberately, so a second pass cannot corrupt
      // it. Matching only the hyphenated form therefore missed every customer who
      // used the full pt-BR name — and it made the SUBSTITUTION branch close to
      // unreachable, because none of its three subjects has an unambiguous
      // one-word alias to arrive by: `costela` is the gazetteer's declared
      // AMBIGUOUS surface (two products), and the other two have no alias at all.
      occursWholeToken(canonical, handleAsText(handle)),
  );
}

// ── The pt-BR scalars (composed in CODE, never model-authored) ───────────────

/**
 * Join names as a pt-BR list: "a", "a e b", "a, b e c". Pure. The Oxford comma
 * is not a pt-BR convention, so the last separator is always " e ".
 */
export function joinPtBrList(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} e ${names[names.length - 1]}`;
}

/**
 * The DETERMINISTIC pt-BR PAIRING scalar (the DELIVERY_COVERAGE / COUPON_VALID
 * "pre-composed serialized scalar under the frozen single-C6-field kernel"
 * idiom). Composed in CODE from titles the LIVE CATALOG returned — never
 * model-authored (Hard Rule 4 / SDD §O#3). Pure.
 *
 * The sentence attributes the advice to the HOUSE ("aqui na casa a gente
 * costuma servir"), which is what the graph actually is: authored, reviewed
 * house knowledge. It does not say "combina bem" as a claim about the world's
 * taste, because the edge is the restaurant's opinion and the sentence should
 * read as one.
 */
export function composePairingsText(args: {
  readonly subjectTitle: string;
  readonly objectTitles: readonly string[];
}): string {
  return (
    `Com ${args.subjectTitle}, aqui na casa a gente costuma servir ` +
    `${joinPtBrList([...args.objectTitles])}`
  );
}

/**
 * The DETERMINISTIC pt-BR SUBSTITUTION scalar. Its own frame, because answering
 * an absence is a different act from suggesting an addition. Pure.
 */
export function composeSubstitutionsText(args: {
  readonly subjectTitle: string;
  readonly objectTitles: readonly string[];
}): string {
  return (
    `No lugar de ${args.subjectTitle}, a casa indica ` +
    `${joinPtBrList([...args.objectTitles])}`
  );
}

// ── The read ─────────────────────────────────────────────────────────────────

/** The graph's edges out of `subject` with `relation`, in DECLARATION order. */
function edgesFor(subject: string, relation: PairingRelation): readonly PairingEdge[] {
  return PAIRING_GRAPH.filter(
    (edge) => edge.subject === subject && edge.relation === relation,
  );
}

/** A handle as search text — the resolver matches on words, not on hyphens. */
function handleAsText(handle: string): string {
  return handle.replace(/-/g, " ");
}

/**
 * Resolve a handle to the product's OWN live title, or `undefined` when the store
 * has no such product. This is what keeps a stale edge from ever being spoken.
 */
async function titleOf(
  turnId: string,
  handle: string,
  ctx: MenuItemResolveContext,
): Promise<string | undefined> {
  const item = await resolveMenuItem(turnId, handleAsText(handle), ctx);
  return item?.title;
}

async function resolvePairingsUncached(
  turnId: string,
  text: string,
  ctx: MenuItemResolveContext,
): Promise<PairingResolution> {
  // A TWO-question utterance degrades rather than half-answering. The pair is a
  // presence complement, so answering both is structurally forbidden; answering
  // the one the precedence happens to pick would pass half an answer off as a
  // whole one for any subject carrying edges of both relations (the seed's
  // `costela-bovina-defumada` is exactly that). See `isBothPairingAsk`.
  if (isBothPairingAsk(text)) return { kind: "unknown" };

  // An ALLERGEN- or DIET-marked ask never gets a suggestion. MEASURED, not
  // assumed, and this module's header used to say the opposite.
  //
  // The header (and ticket 29, and `pairing-graph.ts`) claimed §O#9's
  // closed-taxonomy safety routing escalates "o que combina com brisket que seja
  // sem glúten?" before this read is consulted. It does not. §O#9's
  // DETERMINISTIC contribution is `detectMedicalEmergencyMarkers`, which keys on
  // ACTIVE DISTRESS and is deliberately DISJOINT from merely naming a diet (its
  // own header says so, and that disjointness is correct — the ratified
  // BKL-143/123/184 policy for an allergen INFO question is honest self-report,
  // not a human handoff). The remaining §O#8 channel is the 4B's `safetyMarkers`
  // array, i.e. model luck. So that utterance flagged NO marker, `routeSafety`
  // returned `undefined`, and a real turn through the customer seam rendered the
  // full grounded suggestion list — measured at `pairings.e2e.test.ts`.
  //
  // Which is the BKL-143 forbidden implication reached by a different road: the
  // customer asked which of these is gluten-free and received a list, reading as
  // an assurance sourced from a hand-authored TASTE table, rendered as the
  // house's own advice, with no staff member in the loop. The graph asserts taste
  // and the catalog holds no ingredient knowledge at all, so no reading of this
  // data could support the answer.
  //
  // The guard sits HERE rather than on the PAIRING_Q span for the same reason the
  // both-ask degrade does: suppressing the span would drop the turn out of the
  // deterministic path entirely and let the responder author prose about gluten,
  // which is worse. Keeping the span means the question stays accounted for by
  // §O#15, both claims resolve ABSENT → UNKNOWN, and the customer gets the
  // deterministic honest abstain. DEMOTE-ONLY by construction: this can only ever
  // remove a confident answer, never add one.
  if (isAllergenFamilyAsk(text)) return { kind: "unknown" };

  const relation = classifyPairingAsk(text);
  if (relation === undefined) return { kind: "unknown" };

  const subject = findPairingSubject(text);
  // No subject the graph knows, or an ambiguous surface the canonicalizer
  // declined to resolve → honest UNKNOWN. Never a guess at which item was meant.
  if (subject === undefined) return { kind: "unknown" };

  const edges = edgesFor(subject, relation);
  // The graph is a PARTIAL seed — no edge is "not written down yet", never
  // "nothing goes with this" (see the module header).
  if (edges.length === 0) return { kind: "unknown" };

  try {
    const subjectTitle = await titleOf(turnId, subject, ctx);
    // The thing the customer asked ABOUT is not in the live catalog — answering
    // would be advice about a product the store does not sell.
    if (subjectTitle === undefined) return { kind: "unknown" };

    const resolved = await Promise.all(
      edges.map((edge) => titleOf(turnId, edge.object, ctx)),
    );
    // Drop the objects the store no longer sells; a stale edge costs a
    // suggestion, never produces a wrong one.
    const objectTitles = resolved.filter((title): title is string => title !== undefined);
    if (objectTitles.length === 0) return { kind: "unknown" };

    return relation === "pairs-with"
      ? {
          kind: "pairings",
          suggestionsText: composePairingsText({ subjectTitle, objectTitles }),
          subject,
        }
      : {
          kind: "substitutions",
          substitutionsText: composeSubstitutionsText({ subjectTitle, objectTitles }),
          subject,
        };
  } catch {
    // Inv 7 — an unreadable catalog is "could not check", never "nothing goes
    // with it".
    return { kind: "unknown" };
  }
}

// ── The per-turn memo (the coupon-validity-resolver.ts shape, verbatim) ───────

const PAIRING_MEMO_MAX = 256;
const pairingMemo = new Map<string, Promise<PairingResolution>>();

function pairingMemoSet(key: string, value: Promise<PairingResolution>): void {
  pairingMemo.set(key, value);
  if (pairingMemo.size > PAIRING_MEMO_MAX) {
    const oldest = pairingMemo.keys().next().value;
    if (oldest !== undefined) pairingMemo.delete(oldest);
  }
}

/** Test seam — clear the per-turn memo between cases. */
export function clearPairingMemoForTests(): void {
  pairingMemo.clear();
}

/**
 * Resolve this turn's pairing state. `turnId` + `text` scope the memo: the
 * investigator and the claim planner MUST pass the SAME pair (`cognition.turnId`,
 * `cognition.perception.text`) so they compose the IDENTICAL scalar — the
 * same-resolver-same-text invariant menu-item-resolver.ts pins, which is what
 * makes the kernel's C6 value-binding pass by construction rather than by luck.
 */
export function resolvePairings(
  turnId: string,
  text: string,
  ctx: MenuItemResolveContext,
): Promise<PairingResolution> {
  const key = `${turnId} ${text}`;
  const cached = pairingMemo.get(key);
  if (cached !== undefined) return cached;
  const pending = resolvePairingsUncached(turnId, text, ctx);
  pairingMemoSet(key, pending);
  return pending;
}
