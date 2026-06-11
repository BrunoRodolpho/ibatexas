# Product Card Variants — IbateXas Web

Several product-card components coexist with overlapping but deliberately
distinct visual roles. They are not unified yet; this README is the source of
truth for which card to use and where they intentionally (or accidentally)
disagree. Code is authoritative — when in doubt, read the file.

## The variants

| Component | Purpose | File |
|---|---|---|
| `ProductCardVertical` | The canonical grid card. | `product-card/ProductCardVertical.tsx` |
| `ProductCardHorizontal` | Compact row card (square thumb + inline price/add). Wired into the facade as `variant="horizontal"` but **not used by any call-site yet**. | `product-card/ProductCardHorizontal.tsx` |
| `ProductCardFeatured` | Hero/landscape card, rendered as the first item in featured grids. | `molecules/ProductCardFeatured.tsx` |
| `CarouselCard` | Wide showcase card for the home product carousel. | `molecules/CarouselCard.tsx` |
| `HomeRecommendations` (inline) | Small horizontal-scroll personalization card, inlined — not extracted. | `app/[locale]/HomeRecommendations.tsx` |

### The `ProductCard` facade

`product-card/index.tsx` exports a `ProductCard` facade (re-exported via
`molecules/ProductCard.tsx`) that owns the shared state and handlers
(quick-add, inline quantity, analytics tracking, pre-computed image/price/
discount values) and delegates to `ProductCardVertical` (default) or
`ProductCardHorizontal` based on its `variant` prop. Consumers never touch the
variant components directly — they render `ProductCard` (and the grid also
renders `ProductCardFeatured` for its hero slot):

- `organisms/ProductGrid.tsx` → used by `/loja`, `/loja/[category]`, search,
  favorites (`HomeFavorites`), wishlist, and PDP.
- `organisms/RecentlyViewedCarousel.tsx` → home personalization islands.

## When to use which

- **Product grid?** Render `ProductCard` (defaults to the vertical card). Always.
- **Hero "first card" feeling?** `ProductCardFeatured`.
- **Wide carousel banner that scrolls horizontally with auto-play?** `CarouselCard`.
- **Tight horizontal-scroll personalization strip?** Use the inline pattern from
  `HomeRecommendations`. Promote to a real component when a third surface needs it.

## What is normalized

- **Border radius** — every variant uses `rounded-card` (10px).
- **WishlistButton** — `<WishlistButton size="sm" />` top-right of the image on
  `ProductCardVertical`, `ProductCardFeatured`, and `CarouselCard`. The inline
  personalization card is exempt (too cramped at ~172px wide; revisit).
- **Click target** — every variant nests a `<Link>` carrying
  `after:absolute after:inset-0 after:content-['']` so the whole card is
  clickable, with interactive children raised above via z-index. Never nest a
  `<button>` inside an `<a>`.

## What deliberately diverges

- **Image ratio** — encodes the card's *role*; don't unify without a design pass.
  - `ProductCardVertical`: `aspect-[4/3]` (editorial portrait)
  - `ProductCardFeatured`: `aspect-[4/5] md:aspect-auto md:min-h-[360px]` (mobile portrait, desktop free-flow)
  - `CarouselCard`: `aspect-[16/10]` (wide cinematic banner)
  - personalization inline: `aspect-square` (compact thumb)

- **Internal padding** — varies per ratio. No single token covers all variants.

## Hover styling is NOT yet normalized

These classes drifted and are documented here exactly as they are in code so the
divergence is visible (not a contract — fix toward one when you touch them):

| Variant | Transition | Lift |
|---|---|---|
| `ProductCardVertical` | `transition-premium` | `group-hover:-translate-y-0.5` |
| `ProductCardHorizontal` | `transition-premium` | none |
| `ProductCardFeatured` | `transition-all duration-500 ease-luxury` | `group-hover:-translate-y-0.5` |
| inline (`HomeRecommendations`) | `transition-all duration-500 ease-luxury` | `group-hover:-translate-y-0.5` |
| `CarouselCard` | `transition-all duration-500 ease-luxury` | `hover:-translate-y-1` |

Notes: only `CarouselCard` lifts by `-1`, and it is the only one using a bare
`hover:` (whole-card) rather than the group-scoped `group-hover:` the rest use.

## Future unification (out of scope right now)

The facade is the seam to grow when the time comes:
1. Fold the remaining standalone variants (`ProductCardFeatured`, `CarouselCard`,
   the inline card) into the `ProductCard` facade as additional `variant` values.
2. Move shared bits (image with hover swap, wishlist heart, price block,
   add-to-cart with quantity controls) into sub-components.

The risk of doing this now is high — `ProductCardVertical` already composes
several sub-pieces (`ProductImage`, `PriceBlock`, `QuantityControls`,
`SocialProof`, `Badge`, `WishlistButton`) and is consumed across many surfaces
through the facade.
