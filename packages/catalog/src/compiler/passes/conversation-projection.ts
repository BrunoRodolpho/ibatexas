// PASS 3 — CONVERSATION PROJECTION (LE2-033).
//
// The authored pt-BR trigger phrasings (`CapabilityDefinition.
// conversationTriggers`) are DATA with no runtime authority — but they are
// data whose whole value is a property no type can express: that the
// projection SEPARATES capabilities. This pass is what makes that property a
// build invariant instead of a hope.
//
// # Why the slot contract is not enough
//
// `slot-dataflow` already covers the STRUCTURAL half via `SLOT_SPECS`, and
// this pass deliberately does not restate any of it:
//
//   - absent on a chat-tier capability  → `slot-dataflow/missing-required-slot`
//   - present on an identity-tier one   → `slot-dataflow/orphan-slot`
//     (the slot is `scope: "chat-only"`)
//   - not an array of strings           → `slot-dataflow/slot-type-mismatch`
//   - a blank entry                     → `slot-dataflow/blank-slot-entry`
//   - a byte-identical repeat           → `slot-dataflow/duplicate-slot-entry`
//
// What remains is everything about the phrasings AS A RETRIEVAL SURFACE, which
// the slot contract cannot see:
//
//   1. `insufficient-trigger-coverage`     — too few phrasings to span the
//                                            registers a customer speaks in
//   2. `malformed-trigger-phrasing`        — a phrasing not in normal form
//   3. `duplicate-trigger-phrasing`        — two phrasings that differ only by
//                                            case/accent/punctuation
//   4. `cross-capability-trigger-collision`— two CAPABILITIES claiming one
//                                            phrasing
//
// # Rule 4 is the load-bearing one
//
// LE2-008 measured the register gap this projection exists to close, and the
// worst per-capability recall in that measurement came from CONFUSABLE pairs,
// not from obscure capabilities: the cart triad (`order.item.*`) against the
// post-checkout amend triad (`order.amend.*`) — "tira a coca do carrinho"
// against "tira a coca do meu pedido". A projection where both sides claim
// "tira a coca" would not merely fail to help, it would actively teach the
// retriever that the two are the same point in space.
//
// So a shared phrasing is a COMPILE ERROR, and the fix is never to delete one
// side: it is to add the disambiguating token the customer actually says
// ("do carrinho" vs "do pedido que já fiz"). The rule turns an authoring
// temptation into a build failure at the moment it is cheapest to fix.
//
// # Comparison is by NORMAL FORM, not by bytes
//
// All three duplicate/collision judgments compare
// `normalizeTriggerPhrasing(p)` (lowercase, diacritics folded, punctuation
// stripped, whitespace collapsed), because "Tira a Coca!" and "tira a coça"
// are the same phrasing for every purpose this projection has. Byte equality
// is `slot-dataflow`'s business; MEANING equality is this pass's.
//
// Pure: no clock, no RNG, no IO.

import {
  MIN_CONVERSATION_TRIGGERS,
  normalizeTriggerPhrasing,
} from "../../capability-definitions/conversation-triggers.js"
import type { CapabilityDefinition } from "../../capability-definitions/types.js"
import {
  capabilityObjectName,
  type CatalogDiagnostic,
  type CatalogPassResult,
} from "../diagnostics.js"
import { asRecord } from "../slots.js"

const PASS = "conversation-projection" as const

/** The slot this pass reads. */
const SLOT = "conversationTriggers"

/**
 * Why a phrasing is not in normal form, or `undefined` when it is.
 *
 * Normal form is deliberately modest: trimmed, single-spaced, no control
 * characters, and carrying at least one letter or digit. It does NOT require
 * lowercase — `aplica o cupom PROMO10` mirrors an authored extraction-schema
 * example verbatim, and a rule that forced it to `promo10` would either break
 * the mirror or silently fork two spellings of one sentence. Case is folded
 * for COMPARISON instead, which is where it actually matters.
 */
function malformation(phrasing: string): string | undefined {
  if (phrasing !== phrasing.trim()) return "it has leading or trailing whitespace"
  if (/[\u0000-\u001f\u007f]/.test(phrasing)) return "it contains a control character"
  if (/\s{2,}/.test(phrasing)) return "it contains a run of consecutive whitespace"
  if (normalizeTriggerPhrasing(phrasing) === "") {
    return "it carries no letter or digit once punctuation is stripped"
  }
  return undefined
}

/**
 * Run the conversation-projection pass.
 *
 * `checked` counts PHRASINGS examined — the pass's unit. A run reporting
 * `checked: 0` against the real catalog means the projection is gone, not
 * that it is clean (the anti-vacuous-gate signal `CatalogPassResult.checked`
 * exists for).
 */
export function runConversationProjectionPass(
  definitions: readonly CapabilityDefinition[],
): CatalogPassResult {
  const diagnostics: CatalogDiagnostic[] = []
  let checked = 0

  /** normal form -> the FIRST capability that claimed it. */
  const claimedBy = new Map<string, string>()

  definitions.forEach((def, index) => {
    const record = asRecord(def)
    const object = capabilityObjectName(record["kind"], index)
    const raw = record[SLOT]

    // Structural faults belong to `slot-dataflow` — see the module doc. This
    // pass only speaks about a well-shaped array, so anything else is skipped
    // here rather than double-reported with a second opinion.
    if (!Array.isArray(raw)) return

    const phrasings = raw
    if (record["tier"] === "chat" && phrasings.length < MIN_CONVERSATION_TRIGGERS) {
      diagnostics.push({
        pass: PASS,
        rule: "insufficient-trigger-coverage",
        severity: "error",
        object,
        field: SLOT,
        message:
          `declares ${phrasings.length} trigger phrasing(s); a parser-emittable ` +
          `capability needs at least ${MIN_CONVERSATION_TRIGGERS}. The projection ` +
          "exists to close a REGISTER gap (LE2-008 measured recall@5 = 73.8% on the " +
          "admin-register descriptions alone), and a handful of phrasings cannot span " +
          "the imperative, desiderative and interrogative ways a customer asks for " +
          "this. Add real phrasings — never pad the array to clear the floor.",
      })
    }

    /** normal form -> the first POSITION in this capability that used it. */
    const seenHere = new Map<string, number>()

    phrasings.forEach((value, position) => {
      checked += 1
      const field = `${SLOT}[${position}]`

      // A non-string / blank entry is `slot-dataflow`'s to report.
      if (typeof value !== "string" || value.trim() === "") return

      const fault = malformation(value)
      if (fault !== undefined) {
        diagnostics.push({
          pass: PASS,
          rule: "malformed-trigger-phrasing",
          severity: "error",
          object,
          field,
          message:
            `trigger phrasing ${JSON.stringify(value)} is not in normal form: ${fault}. ` +
            "Phrasings are embedded verbatim downstream, so stray whitespace and " +
            "control characters become part of the retrieval document.",
          reference: value,
        })
        return
      }

      const normal = normalizeTriggerPhrasing(value)

      const firstHere = seenHere.get(normal)
      if (firstHere !== undefined) {
        diagnostics.push({
          pass: PASS,
          rule: "duplicate-trigger-phrasing",
          severity: "error",
          object,
          field,
          message:
            `trigger phrasing ${JSON.stringify(value)} repeats ` +
            `${SLOT}[${firstHere}] under the projection's normal form ` +
            `("${normal}") — they differ only by case, accent, punctuation or ` +
            "spacing. A repeat adds no retrieval signal and inflates the " +
            "coverage floor without widening it.",
          reference: normal,
        })
        return
      }
      seenHere.set(normal, position)

      const owner = claimedBy.get(normal)
      if (owner !== undefined && owner !== object) {
        diagnostics.push({
          pass: PASS,
          rule: "cross-capability-trigger-collision",
          severity: "error",
          object,
          field,
          message:
            `trigger phrasing ${JSON.stringify(value)} is already claimed by ` +
            `${owner} (normal form "${normal}"). Two capabilities may not share a ` +
            "phrasing: the projection's entire purpose is to SEPARATE capabilities " +
            "in retrieval space, and a shared phrasing teaches the retriever they " +
            "are the same point. Fix it by adding the disambiguating token the " +
            'customer actually says — "do carrinho" vs "do pedido que já fiz" — ' +
            "not by deleting one side.",
          reference: owner,
        })
        return
      }
      if (owner === undefined) claimedBy.set(normal, object)
    })
  })

  return { pass: PASS, checked, diagnostics }
}
