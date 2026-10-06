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
//      repo file — reading it needs no apps/* import). Covers the 17 of 20
//      chat-tier kinds whose `legacyNames[0]` matches a real H3 heading; the
//      remaining 3 are the granular `order.amend.*` kinds (legacyNames: [],
//      no name to key a heading by — asserted present, not absent, below).
//
//      FE-D16 UPDATE: FE-T23 originally pinned 7 of these as KNOWN GAPS and
//      reported them (per FE-4.3 — "pin committed bytes, report staleness,
//      never silently generate around it"). FE-D16 is the fix ticket: the doc
//      now carries a row for get_or_create_cart / save_pix_details /
//      regenerate_pix (moved into MATCHED), the handoff heading was renamed
//      handoff_to_human → request_human_handoff (also MATCHED now), and the
//      three granular amend kinds got descriptive-heading rows. The two
//      "orphans" (change_delivery_address / switch_order_type) turned out to
//      be REAL order-actions-HTTP-route tools (not chat capabilities), so
//      their rows are KEPT but annotated not-LLM-callable, not deleted. The
//      former known-gap tests below are flipped to pin the RECONCILED state.
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
} from "@ibatexas/catalog"
import type { CapabilityDefinition } from "@ibatexas/catalog"

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
  it("projects exactly 19 auth levels, one per chat-tier capability (post-FE-T09 D-a: 18→20; LE2-024: 20→19)", () => {
    expect(Object.keys(generateChatCapabilityAuthLevels(CAPABILITY_DEFINITIONS))).toHaveLength(
      19,
    )
  })

  it("hand-corrupt one definition's auth → diverges from the real value (required negative direction)", () => {
    // LE2-024 — RE-POINTED off `order.cancel`, which left the chat tier when the
    // ad-hoc cancel path was retired. The projection reads chat-tier rows only,
    // so corrupting an identity-tier one changes nothing and this negative would
    // have passed VACUOUSLY. `order.checkout.create` is the nearest kind that is
    // still chat-tier and still `auth: "customer"`.
    const corrupted: readonly CapabilityDefinition[] = CAPABILITY_DEFINITIONS.map((def) =>
      def.kind === "order.checkout.create" && def.tier === "chat"
        ? { ...def, auth: "guest" as const }
        : def,
    )
    expect(generateChatCapabilityAuthLevels(corrupted)["order.checkout.create"]).not.toBe(
      "customer",
    )
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
    { kind: "order.note.add", toolName: "add_order_note" },
    { kind: "order.review.submit", toolName: "submit_review" },
    { kind: "reservation.create", toolName: "create_reservation" },
    { kind: "reservation.modify", toolName: "modify_reservation" },
    { kind: "reservation.cancel", toolName: "cancel_reservation" },
    { kind: "reservation.waitlist.join", toolName: "join_waitlist" },
    { kind: "customer.preferences.update", toolName: "update_preferences" },
    // FE-D16 reconcile — these 4 previously-KNOWN-GAP kinds now carry a real,
    // byte-identical doc row (added / renamed in this PR):
    { kind: "order.cart.ensure", toolName: "get_or_create_cart" },
    { kind: "customer.pix.details.save", toolName: "save_pix_details" },
    { kind: "payment.pix.regenerate", toolName: "regenerate_pix" },
    // handoff heading renamed handoff_to_human → request_human_handoff (its
    // real legacyNames[0]); the Auth value already agreed (guest), so it is a
    // plain MATCHED row now.
    { kind: "whatsapp.handoff.request", toolName: "request_human_handoff" },
  ]

  it("covers exactly 16 of the 19 chat-tier kinds (the remaining 3 are the granular order.amend.* kinds — no legacy name to key a heading by; asserted present below)", () => {
    // LE2-024 — 17→16 of 20→19: `cancel_order` left this table with
    // `order.cancel`'s chat tier. The doc section it keyed is now the retirement
    // note, which carries no Auth row by design.
    expect(MATCHED).toHaveLength(16)
  })

  for (const { kind, toolName } of MATCHED) {
    it(`"${toolName}" (${kind}): committed doc Auth row is byte-identical to the registry's auth field`, () => {
      const docAuth = extractDocAuthRow(docText, toolName)
      expect(docAuth, `doc must have a "${toolName}" H3 section with an Auth row`).toBeDefined()
      expect(docAuth).toBe(generatedAuth[kind])
    })
  }

  // ── FE-D16 reconcile: the FE-T23 known gaps are now FIXED ────────────────
  //
  // FE-T23 pinned these as absences (per FE-4.3 — "report staleness, never
  // silently generate around it"). FE-D16 is the fix ticket; each assertion
  // below now pins the RECONCILED state (the row exists / the orphan is
  // gone) — the flip-on-fix the FE-D16 tracker row called for.

  it('FIXED (was KNOWN GAP): order.cart.ensure now has a "get_or_create_cart" doc row (byte-identical Auth pinned in MATCHED above); the read-only "get_cart" row still exists and is a DIFFERENT tool', () => {
    expect(extractDocAuthRow(docText, "get_or_create_cart")).toBeDefined()
    expect(docText).toContain("### `get_cart`")
  })

  it("FIXED (was KNOWN GAP): the three granular order.amend.* kinds now have doc rows, though they still carry legacyNames: [] (no legacy name to key a MATCHED heading by — documented under descriptive headings instead)", () => {
    for (const kind of [
      "order.amend.add_item",
      "order.amend.update_qty",
      "order.amend.remove_item",
    ] as const) {
      const def = CAPABILITY_DEFINITIONS.find((d) => d.kind === kind)
      expect(def?.legacyNames, kind).toEqual([])
      expect(generatedAuth[kind], kind).toBe("customer")
    }
    expect(docText).toContain("### `amend_order_add_item`")
    expect(docText).toContain("### `amend_order_update_qty`")
    expect(docText).toContain("### `amend_order_remove_item`")
  })

  it('FIXED (was KNOWN GAP): customer.pix.details.save now has a "save_pix_details" doc row (Auth pinned in MATCHED above)', () => {
    expect(extractDocAuthRow(docText, "save_pix_details")).toBeDefined()
  })

  it('FIXED (was KNOWN GAP): payment.pix.regenerate now has a "regenerate_pix" doc row (Auth pinned in MATCHED above)', () => {
    expect(extractDocAuthRow(docText, "regenerate_pix")).toBeDefined()
  })

  it('FIXED (was KNOWN NAME DISCREPANCY): whatsapp.handoff.request\'s doc heading is now "request_human_handoff" (its real legacyNames[0]); the old "handoff_to_human" heading is gone and the prose still cites the kind by name', () => {
    expect(docText).not.toContain("### `handoff_to_human`")
    expect(extractDocAuthRow(docText, "request_human_handoff")).toBe(
      generatedAuth["whatsapp.handoff.request"],
    )
    expect(docText).toContain("`whatsapp.handoff.request`")
  })

  it("RECONCILED (were mislabeled 'orphans'): change_delivery_address / switch_order_type are REAL tools (invoked from apps/api/src/routes/order-actions.ts), NOT chat capabilities — the doc KEEPS their rows but now annotates them not-LLM-callable; they still match NO CapabilityDefinition legacyName and map to the identity-tier kernel kinds order.address.change / order.type.switch", () => {
    const allLegacyNames = new Set(CAPABILITY_DEFINITIONS.flatMap((d) => d.legacyNames ?? []))
    expect(allLegacyNames.has("change_delivery_address")).toBe(false)
    expect(allLegacyNames.has("switch_order_type")).toBe(false)
    // Rows remain (they are real customer tools), now annotated not-LLM-callable.
    expect(docText).toContain("### `change_delivery_address`")
    expect(docText).toContain("### `switch_order_type`")
    expect(docText).toContain("**Not LLM-callable**")
    // The underlying kernel kinds are real but identity-tier (never chat tools).
    for (const kind of ["order.address.change", "order.type.switch"] as const) {
      const def = CAPABILITY_DEFINITIONS.find((d) => d.kind === kind)
      expect(def?.tier, kind).toBe("identity")
    }
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
