# Step 5 Implementation Plan — Fix & Complete the Restaurant Storefront

## Current State

The `apps/web` storefront is ~50% done. It builds cleanly (87 kB first load JS).

**What works:**
- Next.js 14 App Router + next-intl i18n (pt-BR) + Tailwind CSS
- 12 atoms, 11 molecules, 1 organism — all fully implemented
- Layout shell: Header + Footer + ChatWidget
- API client layer: `apiFetch` + `apiStream` (SSE)
- Custom hooks: `useProducts`, `useProductDetail`, `useCategories`, `useChat`
- Pages exist: Home, Search, Product Detail, Cart, Account, Reservations

**What's broken — full bug inventory:**

---

## Bug Inventory (20 issues found)

### CRITICAL — Runtime Crashes

| # | File(s) | Issue |
|---|---------|-------|
| 1 | `store/` vs `stores/` | **Two conflicting store directories with incompatible interfaces.** `store/index.ts` has `CartItem extends ProductDTO` (fields: `id`, `title`, `imageUrl`). `stores/useCartStore.ts` has a separate `CartItem` (fields: `productId`, `name`, `imageSrc`). Product detail adds items via `@/store`, cart page reads via `@/stores` → **field mismatch crash**. |
| 2 | `store/` vs `stores/` | **Inconsistent imports.** 7 files import from `@/store` (Home, Product Detail, Account, Reservations, ChatWidget, Header, hooks/api). 2 files import from `@/stores` (Search, Cart). Both directories export `useCartStore` but with different shapes. |
| 3 | `store/` vs `stores/` | **Session store mismatch.** `store/index.ts` SessionStore has `sessionId` + `initSession()` (used by ChatWidget). `stores/useSessionStore.ts` has `customerId` + `authToken` + `login()` + `isAuthenticated()` but no `sessionId` or `initSession()`. |
| 4 | `store/` vs `stores/` | **Chat store mismatch.** `store/index.ts` ChatStore has `isLoading` + `setLoading()` + `updateLastMessage()`. `stores/useChatStore.ts` has `isStreaming` + `setStreaming()` but no `updateLastMessage()`. `hooks/api.ts` calls `setLoading(true)` and `updateLastMessage()` via `@/store`. |

### HIGH — Features Non-Functional

| # | File(s) | Issue |
|---|---------|-------|
| 5 | `[locale]/page.tsx` | **Home page fetches from wrong URL.** Uses raw `fetch('/api/products?...')` which routes to Next.js (no such route), not Fastify at `localhost:3001`. Should use `apiFetch` from `lib/api.ts`. |
| 6 | `[locale]/search/page.tsx` | **Search page never queries API.** `handleSearch` is a no-op `setTimeout`. Products array is hardcoded `[]`. The `useProducts` hook exists but is never called. |
| 7 | `hooks/api.ts` | **`useProducts` hook has URL double-nesting bug.** Builds `endpoint = '/api/products?query=...'` then passes it to `apiFetch('/api/products?' + endpoint)` → produces `/api/products?/api/products?query=...`. |
| 8 | `ProductCard.tsx` | **Field name mismatch with ProductDTO.** ProductCard expects `name` + `image` props. ProductDTO has `title` + `imageUrl`. ProductGrid spreads `{...product}` → `name` and `image` are both `undefined`. |
| 9 | `ProductCard.tsx` | **Links to wrong route.** `<Link href={/product/${id}}>` but the actual route is `[locale]/products/[id]`. Missing locale prefix too. |
| 10 | `ChatWidget.tsx` | **Desktop panel always visible.** The desktop chat (`md:flex`) renders permanently, eating 320px of viewport width. No toggle — `isChatOpen` from UI store is never checked. |
| 11 | `CartItem.tsx` | **Expects wrong field names.** Props expect `productId` + `name` + `imageSrc`. If items come from `store/index.ts` (via product detail), they have `id` + `title` + `imageUrl` instead. |

### MEDIUM — i18n & Navigation

| # | File(s) | Issue |
|---|---------|-------|
| 12 | 8+ files | **All internal links missing locale prefix.** `href="/search"`, `href="/cart"`, etc. don't include `/{locale}/`. With `[locale]` App Router segment, these resolve to `/search` which has no route. Affects: Header, Footer, Home, Cart, Product Detail, Account, Reservations, CategoryCarousel. |
| 13 | No file | **Missing next-intl middleware.** No `middleware.ts` exists. next-intl App Router needs middleware for locale detection, redirects (`/` → `/pt-BR`), and URL locale extraction. |
| 14 | `app/page.tsx` | **Root page doesn't redirect.** Shows a static "IbateXas" heading. Should redirect to `/pt-BR` (default locale). |
| 15 | `[locale]/page.tsx` | **Missing i18n key.** Uses `t('home.no_categories')` but `pt-BR.json` has no such key (only `home.no_products`). |
| 16 | Home page | **Uses `<a>` tags instead of `<Link>`.** Home page CTAs use `<Button><a href="/search">` — should use `next/link` `<Link>` for client-side navigation. |

### LOW — Cleanup & Polish

| # | File(s) | Issue |
|---|---------|-------|
| 17 | `Footer.tsx` | **Copyright year hardcoded.** `&copy; 2024` — should use current year dynamically. |
| 18 | `organisms/index.ts` | **Wrong-level re-export.** Re-exports `CategoryCarousel` from molecules — a molecule shouldn't be exported from organisms barrel. |
| 19 | `package.json` | **Unused dependencies.** `@tanstack/react-query` (no `QueryClientProvider`, hooks use raw `useState`/`useEffect`), `react-hook-form` (never imported), `recharts` (never imported), `posthog-js` (never initialized). |
| 20 | `tailwind.config.ts` | **Dead content path.** References `./src/pages/**` but no `pages/` directory exists. |

---

## Plan — 8 Tasks in Order

### Task 1: Consolidate Stores (fix critical bugs #1–4)

**Problem:** Two store directories with incompatible interfaces cause runtime crashes.

**Action:**
- Keep `stores/` as canonical (it has the better architecture: separate files, `useUIStore` with toasts/filters, `useCartStore` with `getTotal()`/`getItemCount()`, `useSessionStore` with `isAuthenticated()`)
- Merge what's unique from `store/index.ts` into `stores/`:
  - `useSessionStore`: add `sessionId`, `initSession()` (from `store/`)
  - `useChatStore`: add `updateLastMessage(delta)`, rename `isStreaming` → `isLoading` + `setLoading()` (to match `hooks/api.ts`)
  - `useCartStore`: update `addItem` to accept `ProductDTO` + `quantity` + `specialInstructions?` (like `store/`), map ProductDTO fields internally
- Delete `store/index.ts` (the monolith)
- Update ALL imports: `@/store` → `@/stores` (7 files)
- Update `hooks/api.ts` to match the consolidated chat store method names

**Files modified:** `stores/useSessionStore.ts`, `stores/useChatStore.ts`, `stores/useCartStore.ts`, `hooks/api.ts`, `components/ChatWidget.tsx`, `components/Header.tsx`, `[locale]/page.tsx`, `[locale]/products/[id]/page.tsx`, `[locale]/account/page.tsx`, `[locale]/account/reservations/page.tsx`

**Files deleted:** `store/index.ts`

### Task 2: Fix i18n Routing (fix bugs #12–14, #16)

**Problem:** No middleware, no locale-aware links, root page doesn't redirect.

**Action:**
- Create `apps/web/middleware.ts` with next-intl locale detection + redirect (`/` → `/pt-BR`)
- Create `hooks/useLocalePath.ts` utility: `useLocalePath()` returns a function `(path: string) => /${locale}${path}`
- Replace root `app/page.tsx` with a redirect to `/${defaultLocale}`
- Update ALL internal `href` values across all files to use locale-prefixed paths via the hook or `useLocale()` from next-intl
- Replace all `<a href>` with `<Link href>` (next/link)

**Files created:** `middleware.ts`, `hooks/useLocalePath.ts`
**Files modified:** `app/page.tsx`, `Header.tsx`, `Footer.tsx`, `[locale]/page.tsx`, `[locale]/cart/page.tsx`, `[locale]/products/[id]/page.tsx`, `[locale]/account/page.tsx`, `[locale]/account/reservations/page.tsx`, `CategoryCarousel.tsx`, `ProductCard.tsx`

### Task 3: Fix API Integration (fix bugs #5–7)

**Problem:** Home page fetches from wrong URL, search page never queries, hooks have URL bug.

**Action:**
- Fix `useProducts` hook: rebuild URL construction so it doesn't double-nest `/api/products`
- Home page: replace raw `fetch('/api/...')` with the fixed `useProducts` hook
- Wire `handleAddToCart` on home page to actually call store's `addItem()` with proper ProductDTO
- Add missing i18n key `home.no_categories` to `pt-BR.json`

**Files modified:** `hooks/api.ts`, `[locale]/page.tsx`, `messages/pt-BR.json`

### Task 4: Fix ProductCard + ProductGrid Field Mapping (fix bugs #8–9)

**Problem:** ProductCard expects `name`+`image` but ProductDTO has `title`+`imageUrl`.

**Action:**
- Update `ProductCard.tsx` props to accept `title` + `imageUrl` (matching ProductDTO)
- Fix internal rendering to use the correct field names
- Fix link: `/product/${id}` → use locale-aware path to `/products/${id}`
- Update `ProductGrid.tsx` Product interface to match ProductDTO fields
- Ensure `onAddToCart` passes the full product data (not just ID)

**Files modified:** `ProductCard.tsx`, `ProductGrid.tsx`

### Task 5: Wire Search Page to Real API (fix bug #6)

**Problem:** Search page renders empty products, `handleSearch` is a setTimeout stub.

**Action:**
- Import and call `useProducts(query, tags, limit)` driven by search state
- Map filter state (tags, category) to API query params
- Pass real products to `ProductGrid` (with corrected field names from Task 4)
- Wire `onAddToCart` callback to `useCartStore.addItem()`
- Replace hardcoded `"Resultados"` and `"Filtrar"` etc. with `t()` i18n calls

**Files modified:** `[locale]/search/page.tsx`

### Task 6: Fix Cart Page + CartItem (fix bug #11)

**Problem:** CartItem molecule expects `productId`+`name`+`imageSrc` but store has `id`+`title`+`imageUrl` (from ProductDTO).

**Action:**
- Update `CartItem.tsx` props to match the consolidated store's `CartItem` shape
- Fix cart page to use the consolidated `@/stores` (done in Task 1)
- Replace `alert()` in reservation submit with toast (`useUIStore.addToast()`)
- Replace `alert()` in product detail with toast

**Files modified:** `CartItem.tsx`, `[locale]/cart/page.tsx`

### Task 7: Fix Chat Widget (fix bug #10)

**Problem:** Desktop chat panel permanently visible, no toggle button on desktop.

**Action:**
- Import `useUIStore` (`isChatOpen`, `toggleChat`) from consolidated stores
- Desktop: hide panel by default. Show floating button (bottom-right). Click opens 400px side panel.
- Both mobile + desktop: check `isChatOpen` before rendering panel
- Fix deprecated `onKeyPress` → `onKeyDown`
- Ensure `main` content doesn't shift when chat opens (chat overlays, doesn't push)

**Files modified:** `ChatWidget.tsx`

### Task 8: Cleanup & Polish (fix bugs #17–20)

**Problem:** Unused deps, dead code, hardcoded year.

**Action:**
- Remove unused deps: `@tanstack/react-query`, `react-hook-form`, `recharts` (add back when actually needed in later steps)
- Remove `posthog-js` initialization comment (keep dep — needed in Step 14)
- Fix copyright year: `new Date().getFullYear()`
- Remove `CategoryCarousel` re-export from `organisms/index.ts`
- Remove `./src/pages/**` from `tailwind.config.ts` content

**Files modified:** `package.json`, `Footer.tsx`, `organisms/index.ts`, `tailwind.config.ts`

---

## Verification

After all 8 tasks:

```bash
pnpm --filter @ibatexas/web build        # compiles clean, no TS errors
```

Verify:
1. Zero imports from `@/store` remain (only `@/stores`)
2. `grep -r "@/store[^s]" apps/web/src/` returns nothing
3. Home page loads featured products from Fastify API (`NEXT_PUBLIC_API_URL`)
4. Search page queries real API with typed query + filters
5. Product cards show `title` and `imageUrl` correctly
6. Add-to-cart flow: product detail → add → cart page shows correct item with name, price, image
7. Chat widget hidden by default, toggleable on both mobile + desktop
8. All internal links include locale prefix (`/pt-BR/search`, not `/search`)
9. Root `/` redirects to `/pt-BR`
10. `pnpm --filter @ibatexas/web build` succeeds with no warnings

---

## Out of Scope (deferred to later steps)

- Checkout flow / payment (Step 10)
- Auth / OTP login (Step 11)
- Shop / merchandise pages (Step 6)
- Admin panel (Step 7)
- Real reservation API (Step 8)
- Customer intelligence / reviews submission (Step 9)
- PostHog analytics initialization (Step 14)
