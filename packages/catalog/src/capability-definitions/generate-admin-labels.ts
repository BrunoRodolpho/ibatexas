/**
 * Admin-inbox label mirror generator — FE-4 MIGRATE 4a (FE-T23),
 * presentation family, target 1.
 *
 * Grounds `apps/admin/src/domains/admin/agent-approvals.mappers.ts`'s
 * `INTENT_KIND_LABELS` (a private, un-exported `Record<string, string>` — the
 * ONLY intentKind→label register on the admin surface; 59 admin API routes
 * checked, label mapping confirmed purely client-side). That map has 9
 * entries: 3 map to `tier: "chat"` kinds in this registry (with DIFFERENT
 * text from `description` — a separate audience, admin operator vs. chat
 * prompt hint, not a duplicate to reconcile), 5 map to `tier: "identity"`
 * kinds (structurally carry no `description`, only `adminLabel`), and the
 * 9th — `pix.charge.refund` — is genuinely OUTSIDE this registry (owned by
 * the external, FROZEN `@adjudicate/pack-payments-pix` pack; not one of our
 * 6 first-party packs, so no `CapabilityDefinition` instance exists for it
 * — the exact boundary `generate-known-intent-kinds.ts`'s `pixIntentKinds`
 * external input documents). Unlike that generator's inputs, there is no
 * separate LIVE runtime materialization for this one string (the committed
 * admin mapper file IS the source), so the freshness test (apps/admin, since
 * `INTENT_KIND_LABELS` is apps/admin-owned and packages cannot import
 * apps/*) supplies the literal committed text as this external input, never
 * inventing a fresh value — mirroring the byte-identity-first discipline
 * FE-4.3 requires.
 *
 * Record key order carries no meaningful contract (compared by content,
 * like `generate-capability-descriptions.ts` / `generate-refusal-codes.ts`).
 */

import type { CapabilityDefinition } from "./types.js"

export interface AdminLabelExternalInputs {
  /**
   * pt-BR admin label for `pix.charge.refund` — see this module's own doc
   * for why it rides an explicit external input rather than a
   * `CapabilityDefinition` field.
   */
  readonly pixChargeRefundLabel: string
}

/**
 * Project `{ [kind]: adminLabel }` for every capability (either tier) that
 * carries one, plus the one external `pix.charge.refund` input. Exactly 9
 * entries for the current registry (8 + 1).
 */
export function generateAdminLabels(
  defs: readonly CapabilityDefinition[],
  external: AdminLabelExternalInputs,
): Readonly<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const def of defs) {
    if (def.adminLabel !== undefined) out[def.kind] = def.adminLabel
  }
  out["pix.charge.refund"] = external.pixChargeRefundLabel
  return out
}
