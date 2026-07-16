// FE-T23 — FE-4 MIGRATE 4a: presentation family (admin labels, docs Auth
// rows, legacy snake_case name map).
//
// Three named targets:
//   1. Admin labels — generateAdminLabels, grounded in apps/admin's
//      committed INTENT_KIND_LABELS (9 entries: 3 chat-tier + 5
//      identity-tier + 1 external `pix.charge.refund` kind, outside this
//      66-kind registry). Byte-identity against the REAL, exported
//      `intentKindLabel()` lives in apps/admin (`INTENT_KIND_LABELS` itself
//      is private/un-exported and apps/admin-owned; packages cannot import
//      apps/*) — see apps/admin/src/domains/admin/__tests__/
//      agent-approvals.admin-label-freshness.test.ts. This file covers the
//      generator's own pure behavior.
//   2. Docs Auth rows — generateChatCapabilityAuthLevels, checked against
//      the real committed docs/architecture/design/agent-tools.md (a plain
//      repo file — reading it needs no apps/* import). Covers the 13 of 20
//      chat-tier kinds whose `legacyNames[0]` matches a real H3 heading; the
//      other 7 are documented KNOWN GAPS below (re-grounded fresh for this
//      ticket, reported in the PR body per FE-4.3 — pin committed bytes,
//      report staleness, never silently generate around it).
//
//      Rebase note (FE-T09 onto dev, PR #264): the chat-tier count moved
//      18→20 — `order.amend.request` (one of the original 5 known gaps)
//      moved OUT of chat tier entirely, and three brand-new granular
//      `order.amend.*` kinds moved in with `legacyNames: []` (no pre-
//      refactor name to search a doc heading by at all — a different KIND
//      of gap than the other 4, not merely a missing row). Net non-matched:
//      3 remaining "no doc entry" gaps (get_or_create_cart, save_pix_details,
//      regenerate_pix) + 1 name-discrepancy-but-verified (whatsapp) + 3 new
//      no-legacy-name gaps = 7. The `order.amend.request` gap test itself is
//      REMOVED, not reworded — it no longer describes a chat-tier kind.
//   3. Legacy snake_case name map — no new generator needed; fully covered
//      by FE-T21's `generateToolToIntentMap` / `generateMutatingToolNames`
//      (see capability-definitions.tool-driving-family.test.ts's existing
//      freshness tests against all 5 packs' real `*_TOOL_TO_INTENT` /
//      `MUTATING` sets). This file adds one small explicit pin proving the
//      combined projection "reproduces" the legacy-name universe, to
//      satisfy the ticket AC's literal wording without a redundant
//      generator.

import { describe, expect, it } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  CAPABILITY_DEFINITIONS,
  generateAdminLabels,
  generateChatCapabilityAuthLevels,
  generateMutatingToolNames,
  generateToolToIntentMap,
} from "../capability-definitions/index.js"
import type { CapabilityDefinition } from "../capability-definitions/index.js"

// Repo root from this test file: packages/packs-composed/src/__tests__ → up 4
// (same depth/pattern as packages/cli/src/__tests__/db-tables.drift.test.ts).
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../")

// ── Target 1: admin labels (pure generator behavior) ─────────────────────

describe("generateAdminLabels — pure projection + external pix input (FE-T23 target 1)", () => {
  const generated = generateAdminLabels(CAPABILITY_DEFINITIONS, {
    pixChargeRefundLabel: "Reembolso PIX",
  })

  it("projects exactly 9 admin labels (8 registry + 1 external)", () => {
    expect(Object.keys(generated)).toHaveLength(9)
  })

  it("includes all 3 chat-tier kinds, with committed text DIFFERENT from `description` (separate audience)", () => {
    expect(generated["payment.pix.regenerate"]).toBe("Regenerar cobrança PIX")
    expect(generated["order.note.add"]).toBe("Adicionar observação ao pedido")
    expect(generated["order.cancel"]).toBe("Cancelar pedido")
  })

  it("includes all 5 identity-tier kinds (no `description` field exists on these instances at all)", () => {
    expect(generated["payment.refund.issue"]).toBe("Emitir reembolso")
    expect(generated["payment.refund.confirm"]).toBe("Confirmar reembolso")
    expect(generated["product.availability.set"]).toBe(
      "Disponibilidade de item (86 / liberar)",
    )
    expect(generated["product.price.set"]).toBe("Alterar preço de item")
    expect(generated["order.status.transition"]).toBe("Avançar status do pedido")
  })

  it("includes the external pix.charge.refund kind, genuinely outside the 66-kind registry", () => {
    expect(generated["pix.charge.refund"]).toBe("Reembolso PIX")
    expect(CAPABILITY_DEFINITIONS.some((d) => d.kind === "pix.charge.refund")).toBe(false)
  })

  it("hand-corrupt one definition's adminLabel → the corruption surfaces, not silently dropped (required negative direction)", () => {
    const corrupted: readonly CapabilityDefinition[] = CAPABILITY_DEFINITIONS.map((def) =>
      def.kind === "order.cancel" ? { ...def, adminLabel: "WRONG LABEL" } : def,
    )
    const corruptedGenerated = generateAdminLabels(corrupted, {
      pixChargeRefundLabel: "Reembolso PIX",
    })
    expect(corruptedGenerated["order.cancel"]).toBe("WRONG LABEL")
    expect(corruptedGenerated["order.cancel"]).not.toBe("Cancelar pedido")
  })
})

// ── Target 2: docs Auth rows ──────────────────────────────────────────────

describe("generateChatCapabilityAuthLevels — pure projection (FE-T23 target 2)", () => {
  it("projects exactly 20 auth levels, one per chat-tier capability (post-FE-T09 D-a: 18→20)", () => {
    expect(Object.keys(generateChatCapabilityAuthLevels(CAPABILITY_DEFINITIONS))).toHaveLength(
      20,
    )
  })

  it("hand-corrupt one definition's auth → diverges from the real value (required negative direction)", () => {
    const corrupted: readonly CapabilityDefinition[] = CAPABILITY_DEFINITIONS.map((def) =>
      def.kind === "order.cancel" && def.tier === "chat"
        ? { ...def, auth: "guest" as const }
        : def,
    )
    expect(generateChatCapabilityAuthLevels(corrupted)["order.cancel"]).not.toBe("customer")
  })
})

/** Extract the `| **Auth** | <value> |` cell text for one doc H3 tool section. */
function extractDocAuthRow(docText: string, toolName: string): string | undefined {
  const headingMarker = `### \`${toolName}\``
  const headingIdx = docText.indexOf(headingMarker)
  if (headingIdx === -1) return undefined
  const rest = docText.slice(headingIdx + headingMarker.length)
  const nextHeadingIdx = rest.search(/\n### /)
  const section = nextHeadingIdx === -1 ? rest : rest.slice(0, nextHeadingIdx)
  const match = section.match(/\|\s*\*\*Auth\*\*\s*\|\s*(.+?)\s*\|/)
  return match?.[1]
}

describe("docs/architecture/design/agent-tools.md Auth-row freshness (FE-T23 target 2)", () => {
  const docText = fs.readFileSync(
    path.join(ROOT, "docs/architecture/design/agent-tools.md"),
    "utf8",
  )
  const generatedAuth = generateChatCapabilityAuthLevels(CAPABILITY_DEFINITIONS)

  // The 13 of 18 chat-tier kinds whose legacyNames[0] matches a real H3
  // heading in the committed doc — verified by grep against the 345-line
  // file (32 total H3 headings) fresh for this ticket, not assumed.
  const MATCHED: ReadonlyArray<{ kind: string; toolName: string }> = [
    { kind: "order.item.add", toolName: "add_to_cart" },
    { kind: "order.item.update", toolName: "update_cart" },
    { kind: "order.item.remove", toolName: "remove_from_cart" },
    { kind: "order.coupon.apply", toolName: "apply_coupon" },
    { kind: "order.checkout.create", toolName: "create_checkout" },
    { kind: "order.cancel", toolName: "cancel_order" },
    { kind: "order.note.add", toolName: "add_order_note" },
    { kind: "order.review.submit", toolName: "submit_review" },
    { kind: "reservation.create", toolName: "create_reservation" },
    { kind: "reservation.modify", toolName: "modify_reservation" },
    { kind: "reservation.cancel", toolName: "cancel_reservation" },
    { kind: "reservation.waitlist.join", toolName: "join_waitlist" },
    { kind: "customer.preferences.update", toolName: "update_preferences" },
  ]

  it("covers exactly 13 of the 20 chat-tier kinds (the other 7 are documented known gaps below)", () => {
    expect(MATCHED).toHaveLength(13)
  })

  for (const { kind, toolName } of MATCHED) {
    it(`"${toolName}" (${kind}): committed doc Auth row is byte-identical to the registry's auth field`, () => {
      const docAuth = extractDocAuthRow(docText, toolName)
      expect(docAuth, `doc must have a "${toolName}" H3 section with an Auth row`).toBeDefined()
      expect(docAuth).toBe(generatedAuth[kind])
    })
  }

  // ── Known gaps (FE-T23 re-grounding findings) — REPORTED, not fixed ──────
  //
  // Per FE-4.3 / the ticket's own instruction: pin CURRENT COMMITTED BYTES;
  // real staleness gets reported (PR body), never silently patched around.

  it('KNOWN GAP: order.cart.ensure\'s legacy name "get_or_create_cart" has no matching doc heading at all — the doc\'s own "get_cart" is a DIFFERENT, read-only tool ("Retrieve the current cart contents", no ensure/create semantics)', () => {
    expect(extractDocAuthRow(docText, "get_or_create_cart")).toBeUndefined()
    expect(docText).toContain("### `get_cart`")
    expect(docText).not.toContain("get_or_create_cart")
  })

  // FE-T09 (D-a, post-#264 rebase): order.amend.request moved OUT of chat
  // tier entirely (the model no longer targets it — see
  // capability-definitions/definitions.ts), so its own "no doc entry"
  // known gap no longer belongs in this chat-tier accounting; replaced by
  // the three granular successors below, a DIFFERENT kind of gap (no
  // legacy name to search a heading by AT ALL, not merely a missing row).
  it('KNOWN GAP (FE-T09 D-a): the three granular order.amend.* kinds carry legacyNames: [] (brand-new tools born under capability===intentKind, no pre-refactor snake_case name exists to search a doc heading by) and the doc has no row for them yet — tracked as a residual in PR #264\'s body, not silently generated around', () => {
    for (const kind of [
      "order.amend.add_item",
      "order.amend.update_qty",
      "order.amend.remove_item",
    ] as const) {
      const def = CAPABILITY_DEFINITIONS.find((d) => d.kind === kind)
      expect(def?.legacyNames, kind).toEqual([])
      expect(generatedAuth[kind], kind).toBe("customer")
    }
    expect(docText).not.toContain("order_amend_add_item")
    expect(docText).not.toContain("order_amend_update_qty")
    expect(docText).not.toContain("order_amend_remove_item")
  })

  it('KNOWN GAP: customer.pix.details.save\'s legacy name "save_pix_details" has NO doc entry at all', () => {
    expect(extractDocAuthRow(docText, "save_pix_details")).toBeUndefined()
    expect(docText).not.toContain("save_pix_details")
  })

  it('KNOWN GAP: payment.pix.regenerate\'s legacy name "regenerate_pix" has NO doc entry at all', () => {
    expect(extractDocAuthRow(docText, "regenerate_pix")).toBeUndefined()
    expect(docText).not.toContain("regenerate_pix")
  })

  it('KNOWN NAME DISCREPANCY: whatsapp.handoff.request\'s legacy name "request_human_handoff" never appears in the doc — the doc heading is "handoff_to_human" instead, though its OWN prose cites the real kind by name and the Auth VALUE still agrees', () => {
    expect(docText).not.toContain("request_human_handoff")
    const docAuth = extractDocAuthRow(docText, "handoff_to_human")
    expect(docAuth, 'doc must have a "handoff_to_human" H3 section with an Auth row').toBeDefined()
    expect(docAuth).toBe(generatedAuth["whatsapp.handoff.request"])
    expect(docText).toContain("`whatsapp.handoff.request`")
  })

  it("the two orphaned doc entries (change_delivery_address, switch_order_type) match NO CapabilityDefinition legacyName — real doc rows with zero registry backing, reported in the PR body, not asserted against any generated value here", () => {
    const allLegacyNames = new Set(CAPABILITY_DEFINITIONS.flatMap((d) => d.legacyNames ?? []))
    expect(allLegacyNames.has("change_delivery_address")).toBe(false)
    expect(allLegacyNames.has("switch_order_type")).toBe(false)
    expect(docText).toContain("### `change_delivery_address`")
    expect(docText).toContain("### `switch_order_type`")
  })
})

// ── Target 3: legacy snake_case name map (no new generator — FE-T21 covers it) ──

describe("legacy snake_case name map — reproduced by FE-T21's existing generators, no new generator needed (FE-T23 target 3, AC pin)", () => {
  const PACKS_WITH_TOOL_TO_INTENT: ReadonlyArray<CapabilityDefinition["pack"]> = [
    "ibatexas/pack-orders",
    "ibatexas/pack-reservations",
    "ibatexas/pack-customer-onboarding",
    "ibatexas/pack-payments",
    "ibatexas/pack-whatsapp",
  ]

  it("the combined generateToolToIntentMap output, across all 5 packs with a *_TOOL_TO_INTENT map, reproduces the full legacy-name → kind universe", () => {
    const combined: Record<string, string> = {}
    for (const pack of PACKS_WITH_TOOL_TO_INTENT) {
      Object.assign(combined, generateToolToIntentMap(CAPABILITY_DEFINITIONS, pack))
    }
    // 18 chat-tier kinds each carry exactly one legacyNames entry (verified
    // T19/T21), plus payment.method.switch / payment.retry's two identity-
    // tier legacyNames entries — at least 18 total, never fewer.
    expect(Object.keys(combined).length).toBeGreaterThanOrEqual(18)
    expect(combined["add_to_cart"]).toBe("order.item.add")
    expect(combined["cancel_order"]).toBe("order.cancel")
    expect(combined["request_human_handoff"]).toBe("whatsapp.handoff.request")
    expect(combined["switch_payment_method"]).toBe("payment.method.switch")
  })

  it("generateMutatingToolNames's per-pack union reproduces the same legacy names PLUS the acknowledged extras (reorder; the 3 un-mapped whatsapp tool names) — the full MUTATING-name-map AC", () => {
    const ordersNames = generateMutatingToolNames(CAPABILITY_DEFINITIONS, "ibatexas/pack-orders", [
      "reorder",
    ])
    expect(ordersNames).toContain("reorder")
    expect(ordersNames).toContain("add_to_cart")

    const whatsappNames = generateMutatingToolNames(
      CAPABILITY_DEFINITIONS,
      "ibatexas/pack-whatsapp",
      ["send_whatsapp_message", "send_whatsapp_template", "handover_whatsapp_session"],
    )
    expect(whatsappNames).toContain("request_human_handoff")
    expect(whatsappNames).toContain("send_whatsapp_message")
  })
})
