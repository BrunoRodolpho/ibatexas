/**
 * Seed file — the DECLARED external-reference promotions (BKL-263).
 *
 * LE2-018 made the two coupon codes declared external references and put a
 * refuse-to-start gate on them: apps/api reconciles every declaration in
 * `@ibatexas/catalog` against its live store during `bootstrapClaustrum()`,
 * before `server.listen`, and a missing promotion kills the boot. That gate is
 * strict by owner decision (LE2 Implementation Decision 16) — no flag, no
 * dev-mode warning, no allowlist — so the ONLY way an environment starts is
 * for the promotions to actually exist in its Medusa.
 *
 * This script is how an ephemeral environment gets them. The dev and staging
 * stores were provisioned by hand once; a per-run CI store cannot be, and a
 * `// create these in Medusa admin` note is exactly what LE2-018 deleted.
 *
 * # Which promotions, and where the codes come from
 *
 * Neither is hardcoded here. The SET is every declaration whose store is
 * `promotion` (`externalReferencesForStore`), and each CODE is read from the
 * env var that declaration names (`requireExternalReferenceKey` → `keyFrom`).
 * So this seeder and the boot gate are reading the same table through the same
 * functions: declare a third promotion and it gets seeded, rename a config
 * variable and both move together. A local list would have gone stale silently
 * and the gate would have reported it as a refused boot.
 *
 * The AMOUNT is the one thing the catalog does not hold — a declaration says a
 * reference must exist, deliberately not what it is worth. So the amounts live
 * in {@link SEED_AMOUNTS_BRL}, keyed by declaration id, and a declaration with
 * no entry FAILS this script by name rather than being seeded at R$0 (which
 * would satisfy the gate and quietly lie to a customer at checkout). The two
 * values match the .env.example annotations: R$15 welcome credit, R$20
 * punch-card reward.
 *
 * # Idempotent
 *
 * Find-or-create by exact `code`. An existing promotion is left UNTOUCHED and
 * reported — never updated, because a store may legitimately carry a hand-tuned
 * campaign, budget or expiry on it and this script's job is existence, not
 * ownership. That is the same question the boot probe asks
 * (packages/tools/src/external-references/probes.ts deliberately ignores
 * active/budget/campaign), which is why re-running against an already-good
 * store is a clean no-op.
 *
 * Run: pnpm --filter @ibatexas/commerce db:seed:promotions
 *   or: ibx db seed:promotions
 * Check: ibx catalog check --live  (the gate's own standalone entry point)
 */

import type { ExecArgs, IPromotionModuleService } from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"
import {
  externalReferencesForStore,
  requireExternalReferenceKey,
} from "@ibatexas/tools"

/**
 * What each declared promotion is worth, in BRL major units (reais), keyed by
 * declaration id.
 *
 * Major units on purpose: LE2-019's coupon-validity read voices
 * `application_method.value` as the store currency's major unit, so 15 here is
 * the "R$ 15" a customer hears. Every entry is `fixed`/`order`/`across` and
 * plainly `active` with no campaign — the simplest promotion that is a real
 * one, since a paused or out-of-budget coupon still satisfies the gate but
 * would fail at checkout for reasons this seeder should not be inventing.
 */
const SEED_AMOUNTS_BRL: Readonly<Record<string, number>> = {
  "promotion.welcome-credit": 15,
  "promotion.loyalty-reward": 20,
}

export default async function seedPromotions({ container }: ExecArgs) {
  const promotionModule = container.resolve<IPromotionModuleService>(Modules.PROMOTION)

  const declarations = externalReferencesForStore("promotion")
  console.log(
    `🎟️  Seeding declared promotion references — ${declarations.length} declared in @ibatexas/catalog`,
  )

  // Resolve EVERY code and amount before creating anything: a misconfigured
  // environment should fail with the whole list, not half a store and a throw.
  const wanted = declarations.map((declaration) => {
    const amount = SEED_AMOUNTS_BRL[declaration.id]
    if (amount === undefined) {
      throw new Error(
        `[seed-promotions] ${declaration.id} is declared in @ibatexas/catalog ` +
          "(src/external-references.ts) but has no amount in SEED_AMOUNTS_BRL " +
          `(apps/commerce/src/seed-promotions.ts). Add one — the api refuses to ` +
          "boot without the promotion, and seeding it at an invented value would " +
          "hand a customer the wrong discount.",
      )
    }
    // Throws ExternalReferenceConfigError naming the unset variable — the same
    // diagnostic the boot gate's `config-unset` miss would print later.
    return { declaration, amount, code: requireExternalReferenceKey(declaration.id) }
  })

  let created = 0
  let reused = 0

  for (const { declaration, amount, code } of wanted) {
    // Exact-match re-verification, like the boot probe: a filter that ever
    // widened to a prefix would make this seeder skip a promotion that is not
    // really there, and the api would refuse to boot with the store "seeded".
    const existing = (
      await promotionModule.listPromotions({ code }, { select: ["id", "code", "status"] })
    ).find((promotion) => promotion.code === code)

    if (existing !== undefined) {
      reused += 1
      console.log(
        `  ✓ ${declaration.id} — "${code}" already present (${existing.id}, ${existing.status}) — left untouched`,
      )
      continue
    }

    const promotion = await promotionModule.createPromotions({
      code,
      type: "standard",
      status: "active",
      is_automatic: false,
      application_method: {
        type: "fixed",
        target_type: "order",
        allocation: "across",
        value: amount,
        currency_code: "brl",
      },
    })
    created += 1
    console.log(
      `  + ${declaration.id} — created "${code}" (${promotion.id}) — R$${amount} off the order`,
    )
  }

  console.log(
    `\n✅ Declared promotions reconciled: ${created} created, ${reused} already present.`,
  )
  console.log("   Verify with: ibx catalog check --live")
}
