// _store-channel.ts — BKL-193 shared helper for the live cart seeders.
//
// Cart creation defense-in-depth: when the publishable key is bound to MORE
// than one sales channel, Medusa rejects a bare `POST /store/carts` with
// "Please provide a sales channel ID in the request body". The seed now binds
// the key to exactly one channel (the sane default), but the seeders must not
// depend on that: resolve the STORE's `default_sales_channel_id` at runtime
// (the same pointer the seed's `ensureStore` maintains — never hardcoded) and
// pass it explicitly. `undefined` (unset / unreadable) falls back to the bare
// call, which single-channel keys accept.

type MedusaAdminFn = (path: string, options?: RequestInit) => Promise<unknown>

/**
 * Resolve the store singleton's default sales channel id via the admin API.
 * Returns `undefined` when the store has no default channel set — callers then
 * omit `sales_channel_id` (valid for a single-channel publishable key).
 */
export async function resolveDefaultSalesChannelId(
  medusaAdmin: MedusaAdminFn,
): Promise<string | undefined> {
  const res = (await medusaAdmin(
    "/admin/stores?fields=id,default_sales_channel_id&limit=1",
  )) as { stores?: Array<{ default_sales_channel_id?: string | null }> }
  return res.stores?.[0]?.default_sales_channel_id ?? undefined
}
