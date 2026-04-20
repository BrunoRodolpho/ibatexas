# Product Card Variants — IbateXas Web

This codebase has **four** product-card components today. They serve different
visual purposes and we are not unifying them yet — instead this README is the
source of truth for which card to use, and where they currently disagree.

## The four variants

| Component | Purpose | File |
|---|---|---|
| `ProductCardVertical` | The canonical card. Used in grids on `/loja`, `/loja/[category]`, search, favorites, home favorites. | `components/molecules/product-card/ProductCardVertical.tsx` |
| `ProductCardFeatured` | Hero/landscape card used as the first item in featured grids on `/loja`. | `components/molecules/ProductCardFeatured.tsx` |
| `CarouselCard` | Wide showcase card used by the home product carousel (`HomeCarousel` → `ProductCarousel`). | `components/molecules/CarouselCard.tsx` |
| `HomeRecommendations` (inline) | Small horizontal-scroll personalization card. Inlined into `HomeRecommendations.tsx`, not extracted yet. | `app/[locale]/HomeRecommendations.tsx` |

## When to use which

- **New surface that shows products in a grid?** `ProductCardVertical`. Always.
- **Need a hero "first card" feeling?** `ProductCardFeatured`.
- **Wide carousel banner that scrolls horizontally with auto-play?** `CarouselCard`.
- **Tight horizontal-scroll personalization strip?** Use the inline pattern from `HomeRecommendations`. Promote to a real component when a third surface needs it.

## What is normalized (Phase 4.C4)

- **Border radius** — all variants use `rounded-card` (10px). `CarouselCard`
  was on `rounded-sm`, fixed.
- **WishlistButton** — top-right of the image on every variant.
  `ProductCardVertical`, `ProductCardFeatured`, and `CarouselCard` now all
  render `<WishlistButton size="sm" />` in the same slot. The personalization
  card is exempt for now (too cramped at 172px wide; revisit).
- **Hover effects** — all variants use `transition-all duration-500 ease-luxury`.
- **Click target pattern** — all variants nest a `<Link>` with the
  `after:absolute after:inset-0 after:content-['']` pseudo-element trick so
  the entire card is clickable, with interactive children sitting above via
  z-index. Never nest `<button>` inside `<a>`.

## What deliberately diverges

- **Image ratio** —
  - `ProductCardVertical`: `aspect-[4/3]` (editorial portrait)
  - `ProductCardFeatured`: `aspect-[4/5] md:aspect-auto md:min-h-[360px]` (mobile portrait, desktop free-flow)
  - `CarouselCard`: `aspect-[16/10]` (wide cinematic banner)
  - personalization inline: `aspect-square` (compact thumb)

  These ratios encode the card's **role**, not a styling whim. Don't unify them
  without a design pass.

- **Hover lift amount** —
  - small/standard cards (`ProductCardVertical`, `CarouselCard`): `hover:-translate-y-1`
  - large cards (`ProductCardFeatured`, personalization inline): `hover:-translate-y-0.5`

  Larger cards use a smaller relative lift so the motion stays proportional.

- **Internal padding** — varies per ratio. No single token covers all four.

## Future unification (out of scope right now)

When the time comes:
1. Extract a `<ProductCard>` primitive that takes a `variant` prop
   (`vertical | featured | carousel | mini`).
2. Move shared bits (image with hover swap, wishlist heart, price block,
   add-to-cart with cart-quantity controls) into sub-components.
3. Migrate the four current variants to render the primitive with their own
   variant flag.
4. Delete the four files.

The risk of doing this now is high — `ProductCardVertical` alone has many
sub-pieces (`ProductImage`, `PriorityBadge`, `PortionScale`, `AvailabilityLabel`,
`SocialProof`, `PriceBlock`, `QuantityControls`, `AddToCartButton`) and is
consumed across at least six surfaces.
