# Egress-brand (Plan 1) — red-until-published state

> Branch: `feat/plan1-egress-app`. This note documents why this branch is
> **red against the npm registry** and the exact steps to turn it green after
> the kernel packages publish.

## Why this branch is currently red

The egress-brand work (Plan 1 / Theorem E-1) retypes every customer-facing
WhatsApp egress sink to accept a runtime-non-forgeable `RenderedReply` minted by
the closed factory set in `@adjudicate/core`. F4 closes the last sole-emitter
hole by retyping `sendMedia` / `sendInteractiveList` / `sendInteractiveButtons`
in `apps/api/src/whatsapp/client.ts` so the **caller (producer)** mints, not
these functions internally.

Those minters (`mintReceiptReply`, `mintBroadcastReply`, `mintRenderedReply`,
`unwrapRendered`, `RenderedReply`) ship in:

- **`@adjudicate/core` 1.8.0** (registry-pinned today at `1.6.0` — 1.8.0 not yet
  on npm; it is `1.7.0` on the platform `main` branch and the changeset version
  computes **1.8.0**).
- **`@claustrum/channel-whatsapp` 0.3.0** (registry-pinned today at `^0.2.0` —
  0.3.0 not yet on npm).

Until those two packages publish, the registry-pinned versions resolve to a
kernel WITHOUT the minters, so a clean `pnpm install` from the registry cannot
typecheck this branch. The branch was developed/verified by temporarily linking
local kernel tarballs via `pnpm.overrides`; those temporary overrides are NOT
committed.

## Post-publish steps (turn it green)

1. **Publish the kernel packages** (in dependency order):
   - `@adjudicate/core` **1.8.0**
   - `@claustrum/channel-whatsapp` **0.3.0**

2. **Bump the override** in the root `package.json` `pnpm.overrides`:
   - `@adjudicate/core`: `1.6.0` → `1.8.0`

3. **Bump every workspace specifier** `@adjudicate/core` `^1.6.0` → `^1.8.0`
   (apps/api + all `packages/*` that declare it as a dep or peer):
   - `apps/api`, `packages/{tools,types,agents,cli,domain,audit-sink,journeys,packs-composed,pack-orders,pack-payments,pack-reservations,pack-customer-onboarding,pack-whatsapp}`

4. **Bump the channel specifier** in `apps/api/package.json`:
   - `@claustrum/channel-whatsapp`: `^0.2.0` → `^0.3.0`

5. **Update the stale override rationale comment** in the root `package.json`
   `pnpm.overrideNotes["@adjudicate/core"]`. It currently describes the
   `1.5.0 -> 1.6.0` bump and states the published `@adjudicate/*` deps pin core
   to EXACTLY `1.5.0`; update it to describe the `1.6.0 -> 1.8.0` bump
   (the egress-brand minters in 1.7.0/1.8.0 are purely additive — `1.8.0 ⊇
   1.6.0 ⊇ 1.5.0`, no existing export changed/removed).

6. `pnpm install` then re-run the verification:
   - `pnpm exec turbo run typecheck --filter=@ibatexas/api --force`
   - `pnpm exec turbo run build --filter=@ibatexas/api --force`
   - `pnpm exec turbo run lint --filter=@ibatexas/api --force`
   - `pnpm exec turbo run test --filter=@ibatexas/api --force`
