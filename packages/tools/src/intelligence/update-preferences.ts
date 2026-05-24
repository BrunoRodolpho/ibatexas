// update_preferences tool
// Writes to both Prisma (via CustomerCommandService.updatePreferencesFromEnvelope)
// and Redis profile hash. Allergens must always be an explicit array — never
// inferred (CLAUDE.md hard rule).
//
// ── Kernel routing ──────────────────────────────────────────────────────────
//
// Previously this tool invoked `svc.updatePreferences(...)` directly,
// bypassing the adjudicate kernel even though
// `pack-customer-onboarding.customer.preferences.update` + the service-side
// `updatePreferencesFromEnvelope` wrapper already existed. Per CLAUDE.md
// rule #9 every mutating tool dispatch must flow through an IntentEnvelope.
//
// We now build a `customer.preferences.update` envelope (UNTRUSTED,
// principal="llm") and route via `updatePreferencesFromEnvelope`, which:
//   - Adjudicates against `customerOnboardingPolicyBundle`
//   - Enforces the allergen-explicit-array safety guard (CLAUDE.md rule #1)
//   - Emits a governance audit record via the configured AuditSink
//   - Delegates to the existing `updatePreferences()` for the Prisma write

import { randomUUID } from "node:crypto"
import { UpdatePreferencesInputSchema, NonRetryableError, type UpdatePreferencesInput, type AgentContext } from "@ibatexas/types"
import { createCustomerService } from "@ibatexas/domain"
import { buildEnvelope } from "@adjudicate/core"
import type {
  CustomerPreferencesUpdatePayload,
  CustomerOnboardingState,
} from "@ibatexas/pack-customer-onboarding"
import { getRedisClient } from "../redis/client.js"
import { rk } from "../redis/key.js"
import { PROFILE_TTL_SECONDS } from "./types.js"

export async function updatePreferences(
  input: UpdatePreferencesInput,
  ctx: AgentContext,
): Promise<{ success: boolean; message: string }> {
  const parsed = UpdatePreferencesInputSchema.parse(input)

  if (!ctx.customerId) {
    throw new NonRetryableError("Autenticação necessária para atualizar preferências.")
  }

  // ── Build the IntentEnvelope ────────────────────────────────────────
  // CLAUDE.md rule #1: allergens must be an explicit array. We force the
  // default to `[]` here so an LLM omission surfaces as the explicit
  // "no exclusions" shape rather than `undefined` — the pack's safety
  // guard REFUSEs the latter.
  const allergenExclusions = Array.isArray(parsed.allergenExclusions)
    ? parsed.allergenExclusions
    : []

  const payload: CustomerPreferencesUpdatePayload = {
    allergenExclusions,
    ...(parsed.dietaryRestrictions !== undefined
      ? { dietaryFlags: parsed.dietaryRestrictions }
      : {}),
    ...(parsed.favoriteCategories !== undefined
      ? { favoriteCategories: parsed.favoriteCategories }
      : {}),
  }

  // ── Project state for the pack policies ────────────────────────────
  // The pack's auth + state guards check `customerExists` + `isAuthenticated`.
  // We have a verified `ctx.customerId` (auth check above), so both are true.
  // The allergen safety guard is the LLM-relevant one; `now` lets future
  // rate-limit-style guards work without re-wiring this call site.
  const state: CustomerOnboardingState = {
    ctx: {
      actor: { principal: "user", id: ctx.customerId },
      customerId: ctx.customerId,
      customerExists: true,
      isAuthenticated: true,
      otpFresh: false,
      hasParkedAnonymize: false,
      now: new Date(),
    },
  }

  const envelope = buildEnvelope<"customer.preferences.update", CustomerPreferencesUpdatePayload>({
    kind: "customer.preferences.update",
    payload,
    nonce: randomUUID(),
    actor: {
      principal: "llm",
      sessionId: `customer:${ctx.customerId}`,
    },
    taint: "UNTRUSTED",
  })

  const svc = createCustomerService()
  const outcome = await svc.updatePreferencesFromEnvelope(envelope, state, {
    customerId: ctx.customerId,
  })

  if (outcome.decision.kind !== "EXECUTE" && outcome.decision.kind !== "REWRITE") {
    // Surface the kernel's pt-BR refusal copy. The mutation did NOT run.
    const message =
      outcome.decision.kind === "REFUSE"
        ? outcome.decision.refusal.userFacing
        : "Não foi possível atualizar suas preferências no momento."
    throw new NonRetryableError(message)
  }

  const prefs = outcome.result!

  // Update Redis profile hash + reset TTL (cache layer — stays in tools)
  const redis = await getRedisClient()
  const profileKey = rk(`customer:profile:${ctx.customerId}`)

  const pipeline = redis.multi()
  pipeline.hSet(profileKey, "preferences", JSON.stringify(prefs))
  pipeline.expire(profileKey, PROFILE_TTL_SECONDS)
  await pipeline.exec()

  const parts: string[] = []
  if (prefs.allergenExclusions.length > 0)
    parts.push(`alérgenos excluídos: ${prefs.allergenExclusions.join(", ")}`)
  if (prefs.dietaryRestrictions.length > 0)
    parts.push(`restrições: ${prefs.dietaryRestrictions.join(", ")}`)
  if (prefs.favoriteCategories.length > 0)
    parts.push(`categorias favoritas: ${prefs.favoriteCategories.join(", ")}`)

  return {
    success: true,
    message:
      parts.length > 0
        ? `Preferências salvas! ${parts.join("; ")}.`
        : "Preferências atualizadas.",
  }
}

export const UpdatePreferencesTool = {
  name: "update_preferences",
  description:
    "Salva as preferências alimentares do cliente (restrições, alérgenos, categorias favoritas). Alérgenos devem sempre ser uma lista explícita — nunca infira pelo nome do prato.",
  inputSchema: {
    type: "object",
    properties: {
      dietaryRestrictions: {
        type: "array",
        items: { type: "string" },
        description: "Ex: ['vegetariano', 'sem glúten']",
      },
      allergenExclusions: {
        type: "array",
        items: { type: "string" },
        description:
          "Lista ANVISA: gluten, lactose, castanhas, amendoim, ovos, peixes, frutos_do_mar, soja",
      },
      favoriteCategories: {
        type: "array",
        items: { type: "string" },
        description: "Handles de categoria, ex: ['churrasco', 'grelhados']",
      },
    },
    required: [],
  },
} as const
