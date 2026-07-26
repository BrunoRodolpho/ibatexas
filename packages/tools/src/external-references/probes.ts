// STORE PROBES — "does this key exist over there?" (LE2-018).
//
// One probe per `ExternalReferenceStore`. Each answers a single yes/no
// question against a LIVE store, and each reuses the access path the rest of
// the repo already uses — `medusaAdmin` for Medusa, `createDeliveryZoneService`
// for the zones table. LE2-018 adds no new way to reach a store; a second
// client for the same data would be a second thing to keep in sync and a
// second thing to get wrong at 3am.
//
// # Why a probe returns a verdict and never a boolean
//
// "Not found" and "could not ask" are different facts with the same shape if
// you return a boolean, and collapsing them is how a fail-closed gate quietly
// becomes fail-open (or the reverse). A probe therefore returns
// {@link ProbeVerdict}, and the reconciler decides what each one means — which
// for LE2-018's strict form is: both refuse the boot, with different
// diagnostics. A store we cannot reach has not proved the reference exists,
// and Decision 16 does not have a "probably fine" tier.
//
// # Injectability
//
// {@link ExternalReferenceProbe} is a plain function, and the reconciler takes
// the probe map as a parameter. Tests pass fakes; nothing needs a module mock
// of Medusa or Prisma, and nothing needs a `__setXForTests` global. The
// defaults below are the only place the real clients are named.

import type { ExternalReferenceStore } from "@ibatexas/catalog"
import { createDeliveryZoneService } from "@ibatexas/domain"
import { medusaAdmin, MedusaRequestError } from "../medusa/client.js"

/** What a probe found. */
export type ProbeVerdict =
  | { readonly status: "present" }
  | { readonly status: "absent" }
  /** The store could not be asked. `detail` is the operator's next lead. */
  | { readonly status: "unreachable"; readonly detail: string }

/** Ask one live store whether `key` names something that exists. */
export type ExternalReferenceProbe = (key: string) => Promise<ProbeVerdict>

/** Every probe, keyed by the store id the catalog declares. */
export type ExternalReferenceProbes = Readonly<
  Partial<Record<ExternalReferenceStore, ExternalReferenceProbe>>
>

function describe(err: unknown): string {
  if (err instanceof MedusaRequestError) {
    return `Medusa responded ${err.statusCode} (${err.message})`
  }
  return err instanceof Error ? err.message : String(err)
}

/**
 * PROMOTION — a Medusa promotion with this exact `code`.
 *
 * Uses the same admin query the coupon-validation route runs
 * (`apps/api/src/routes/cart.ts`), narrowed to existence. The `code=` filter is
 * re-verified against each returned row on purpose: a filter that ever widened
 * to a prefix or case-insensitive match would turn this gate into a rubber
 * stamp, and the check costs one string comparison.
 *
 * Deliberately NOT checked here: whether the promotion is active, in budget or
 * within its campaign window. Those are per-order questions the checkout path
 * already answers; this gate asks the boot-time question — does the thing the
 * code names exist at all — and answering more would make a paused campaign
 * refuse to start the API.
 */
export const probeMedusaPromotion: ExternalReferenceProbe = async (key) => {
  try {
    const data = (await medusaAdmin(
      `/admin/promotions?code=${encodeURIComponent(key)}&limit=1`,
    )) as { promotions?: readonly { code?: string }[] }
    const found = (data.promotions ?? []).some((promotion) => promotion.code === key)
    return found ? { status: "present" } : { status: "absent" }
  } catch (err) {
    return { status: "unreachable", detail: describe(err) }
  }
}

/**
 * DELIVERY-ZONE — a row in `ibx_domain.delivery_zones` whose `name` or `id`
 * matches.
 *
 * Both are accepted because the table has no stable slug: `id` is a per-
 * environment cuid (so a declaration could only ever use it for a
 * hand-provisioned row) and `name` is the human handle every seed, admin
 * screen and pt-BR delivery message uses. Matching either lets a declaration
 * name whichever one is actually stable in that deployment.
 *
 * Inactive zones count as PRESENT, for the same reason a paused promotion
 * does: `active` is an operational toggle, and a gate that refused to boot
 * over one would hand operators a reason to route around the gate.
 */
export const probeDeliveryZone: ExternalReferenceProbe = async (key) => {
  try {
    const zones = await createDeliveryZoneService().listAll()
    const found = zones.some((zone) => zone.name === key || zone.id === key)
    return found ? { status: "present" } : { status: "absent" }
  } catch (err) {
    return { status: "unreachable", detail: describe(err) }
  }
}

/** The production probe map — the only place the real clients are named. */
export const DEFAULT_EXTERNAL_REFERENCE_PROBES: ExternalReferenceProbes = {
  promotion: probeMedusaPromotion,
  "delivery-zone": probeDeliveryZone,
}
