/**
 * Chat-capability auth-level mirror generator — FE-4 MIGRATE 4a (FE-T23),
 * presentation family, target 2 (docs Auth rows).
 *
 * Pure per-def field (FE-4.2 table: "Prompt hint, admin metadata
 * (description, auth, surface) — Yes — pure def fields"). Feeds the
 * `docs/architecture/design/agent-tools.md` Auth-row freshness check
 * (`packages/packs-composed`'s own test — the doc is a plain repo file, not
 * an app export, so reading it needs no `apps/*` import) for the SUBSET of
 * the 18 chat-tier kinds whose `legacyNames[0]` matches a real H3 heading in
 * that doc.
 *
 * Per FE-4.2 ("Docs rows … Partial — the mutating-tool tables generate and
 * stop drifting; the access-model/ADR prose stays hand-authored") and the
 * FE-T23 ticket's own instruction ("if the committed docs rows disagree with
 * the registry, the freshness gate should pin the CURRENT COMMITTED BYTES
 * and any real staleness gets REPORTED not silently 'fixed'"): re-grounding
 * for this ticket found the doc is MISSING an H3 entry for 3 of the 18 chat-
 * tier kinds entirely (`order.amend.request`/"amend_order",
 * `customer.pix.details.save`/"save_pix_details",
 * `payment.pix.regenerate`/"regenerate_pix" — none of these three legacy
 * names appears anywhere in the 345-line doc), a 4th
 * (`order.cart.ensure`/"get_or_create_cart") has no matching heading either
 * (the doc's `get_cart` entry is a DIFFERENT, read-only tool — "Retrieve the
 * current cart contents", not an ensure/create), and a 5th
 * (`whatsapp.handoff.request`/"request_human_handoff") is documented under a
 * MISMATCHED heading (`handoff_to_human`) whose own Notes prose nonetheless
 * cites `whatsapp.handoff.request` by name. All five are EXCLUDED from the
 * generated/asserted set here — see the freshness test's own doc for the
 * exact per-kind disposition. This generator does not special-case any of
 * that; it is a bare, tier-independent projection, and the doc-matching
 * logic lives entirely in the test that consumes it.
 *
 * Record key order carries no meaningful contract (compared by content).
 */

import type { CapabilityDefinition } from "./types.js"

/** Project `{ [kind]: auth }` for every `tier: "chat"` capability (18 entries). */
export function generateChatCapabilityAuthLevels(
  defs: readonly CapabilityDefinition[],
): Readonly<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const def of defs) {
    if (def.tier !== "chat") continue
    out[def.kind] = def.auth
  }
  return out
}
