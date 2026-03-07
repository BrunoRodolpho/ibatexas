/**
 * Type-safe mapping from product tag strings to Badge variants.
 *
 * The domain owns the variant vocabulary. The Badge UI component
 * consumes these values — dependency flows UI → Domain, not the reverse.
 */

export type BadgeVariant =
  | 'default'
  | 'hero'
  | 'feature'
  | 'info'
  // Hero tier
  | 'popular'
  | 'chef_choice'
  | 'edicao_limitada'
  // Feature tier
  | 'novo'
  | 'exclusivo'
  | 'kit'
  | 'primary'
  // Informational tier
  | 'vegetariano'
  | 'vegan'
  | 'sem_gluten'
  | 'sem_lactose'
  // System
  | 'success'
  | 'warning'
  | 'danger'

/** Exhaustive map of known tags → badge variants */
const TAG_TO_BADGE: Record<string, BadgeVariant> = {
  // Hero tier
  popular: 'popular',
  chef_choice: 'chef_choice',
  edicao_limitada: 'edicao_limitada',
  // Feature tier
  novo: 'novo',
  exclusivo: 'exclusivo',
  kit: 'kit',
  // Informational tier
  vegetariano: 'vegetariano',
  vegan: 'vegan',
  sem_gluten: 'sem_gluten',
  sem_lactose: 'sem_lactose',
}

/**
 * Convert a product tag string into a type-safe Badge variant.
 * Falls back to 'info' for unknown tags.
 */
export function tagToBadgeVariant(tag: string): BadgeVariant {
  return TAG_TO_BADGE[tag] ?? 'info'
}
