/**
 * Search synonyms map.
 *
 * Maps user search terms to canonical product terms.
 * This enables "brisket" → "peito bovino defumado" matching
 * and other common misspellings / regional variants.
 *
 * These will be synced to Typesense's synonym API during indexing.
 */

export interface SynonymGroup {
  /** Canonical term (used in product titles) */
  canonical: string
  /** Alternative terms users might search */
  synonyms: string[]
}

export const SYNONYM_GROUPS: SynonymGroup[] = [
  {
    canonical: 'peito bovino defumado',
    synonyms: ['brisket', 'peito defumado', 'carne defumada'],
  },
  {
    canonical: 'costela defumada',
    synonyms: ['ribs', 'costelinha', 'baby back ribs', 'costela suina'],
  },
  {
    canonical: 'linguiça defumada',
    synonyms: ['sausage', 'linguica', 'salsicha defumada'],
  },
  {
    canonical: 'pulled pork',
    synonyms: ['porco desfiado', 'carne de porco desfiada'],
  },
  {
    canonical: 'mac and cheese',
    synonyms: ['macarrão com queijo', 'mac n cheese', 'mac & cheese'],
  },
]

/**
 * Look up synonyms for a search query.
 * Returns the canonical term if the query matches a synonym.
 */
export function resolveCanonical(query: string): string | undefined {
  const lower = query.toLowerCase().trim()
  for (const group of SYNONYM_GROUPS) {
    if (group.canonical.toLowerCase() === lower) return group.canonical
    if (group.synonyms.some((s) => s.toLowerCase() === lower)) return group.canonical
  }
  return undefined
}
