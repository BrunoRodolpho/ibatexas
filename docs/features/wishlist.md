# Wishlist

## Scope

Client-only feature. No backend sync.

## Implementation

- **Store:** `apps/web/src/domains/wishlist/wishlist.store.ts`
- **Persistence:** Zustand with `persist` middleware → `localStorage` key `wishlist_v1`
- **Data:** Array of product IDs stored per browser

## Intentional Limitations

- No server-side storage or API endpoints
- Not synced across devices or sessions
- Lost on browser data clear
- Not accessible via WhatsApp agent

This is an intentional MVP decision. Backend sync would require a `CustomerWishlist` table and session-aware hydration — planned for a future iteration if user demand warrants it.
