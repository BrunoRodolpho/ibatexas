/**
 * Refusal localization — Task 11 (M2 migration).
 *
 * Wraps `@adjudicate/core`'s `localizeDecision` with a guard for Pack-emitted
 * refusals whose codes aren't in the canonical pt-BR dictionary (and would
 * therefore degrade to the dictionary's generic `fallback` string).
 *
 * Policy:
 *
 *   - If the refusal `code` is present in `portugueseRefusalMessages.byCode`
 *     (a kernel-emitted code like `kill_switch_active`, `taint_level_insufficient`,
 *     `default_deny`, `kernel_deadline_exceeded`, ...), use the localized
 *     `userFacing` string — the canonical dictionary is the source of truth.
 *   - Otherwise the code is Pack-specific (e.g. `auth.required`, `cart.empty`,
 *     `order.already_shipped`). The Pack already emits pt-BR via its
 *     `refuse(...)` factory in `refusal-taxonomy.ts`, so we keep the original
 *     `userFacing` text instead of falling back to the canonical's generic
 *     "Essa ação não é permitida neste momento." default.
 *
 * Pack-specific codes that *should* live in the canonical dictionary are
 * tracked for upstream follow-up (see Task 11 PR description). Once they
 * land in `@adjudicate/locales-pt-BR`, this layer becomes a pure pass-through.
 */

import type { Decision } from "@adjudicate/core"
import { portugueseRefusalMessages } from "@adjudicate/locales-pt-br"

/**
 * Pick the best user-facing text given the original kernel decision and the
 * already-`localizeDecision`-d copy. Only meaningful for REFUSE decisions; the
 * caller is responsible for branching.
 */
export function resolveLocalizedRefusalText(
  original: Decision,
  localized: Decision,
): string {
  if (original.kind !== "REFUSE" || localized.kind !== "REFUSE") {
    // Defensive: callers should only invoke for REFUSE. Fall back to whatever
    // the localized branch carries to keep the surface non-crashing.
    if (localized.kind === "REFUSE") return localized.refusal.userFacing
    if (original.kind === "REFUSE") return original.refusal.userFacing
    return portugueseRefusalMessages.fallback
  }

  const code = original.refusal.code
  const canonical = Object.prototype.hasOwnProperty.call(
    portugueseRefusalMessages.byCode,
    code,
  )
  return canonical
    ? localized.refusal.userFacing
    : original.refusal.userFacing
}
