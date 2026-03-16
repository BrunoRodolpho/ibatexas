// lib/profiles.ts — Behavior profiles for commerce simulation.
// Each profile defines purchasing patterns — preferred categories/products,
// order frequency, basket size, and average spend.
// Used by the simulation engine to generate realistic customer behavior.

// ── Types ────────────────────────────────────────────────────────────────────

export interface BehaviorProfile {
  name: string
  description: string
  /** Categories this profile gravitates toward. */
  preferredCategories: string[]
  /** Product handles this profile is most likely to order. */
  preferredProducts: string[]
  /** Average number of items per order. */
  avgItemsPerOrder: number
  /** Average order value in centavos. */
  avgOrderValue: number
  /** Average days between orders. */
  frequencyDays: number
  /** Probability of leaving a review after an order (0–1). */
  reviewProbability: number
  /** Average review rating (1–5). */
  ratingAvg: number
}

// ── Profiles ─────────────────────────────────────────────────────────────────

export const PROFILES: Record<string, BehaviorProfile> = {
  pitmaster: {
    name: "Pitmaster",
    description: "BBQ enthusiast — premium smoked meats, generous baskets, weekly orders",
    preferredCategories: ["carnes-defumadas"],
    preferredProducts: [
      "brisket-americano",
      "costela-bovina-defumada",
      "pulled-pork",
      "barriga-de-porco-defumada",
      "linguica-artesanal-defumada",
    ],
    avgItemsPerOrder: 3,
    avgOrderValue: 15000, // R$150
    frequencyDays: 7,
    reviewProbability: 0.4,
    ratingAvg: 4.6,
  },

  family: {
    name: "Família",
    description: "Family orders — combos, sides, desserts, bi-weekly cadence",
    preferredCategories: ["sanduiches", "acompanhamentos", "sobremesas"],
    preferredProducts: [
      "combo-brisket",
      "smash-burger-defumado",
      "farofa-de-bacon-defumado",
      "mandioca-frita",
      "brownie-com-sorvete",
      "feijao-tropeiro",
      "coleslaw-da-casa",
    ],
    avgItemsPerOrder: 5,
    avgOrderValue: 12000, // R$120
    frequencyDays: 14,
    reviewProbability: 0.3,
    ratingAvg: 4.3,
  },

  casual: {
    name: "Casual",
    description: "Occasional visitor — sandwiches, drinks, monthly orders",
    preferredCategories: ["sanduiches", "bebidas"],
    preferredProducts: [
      "smash-burger-defumado",
      "pulled-pork",
      "limonada-suica",
      "cerveja-artesanal-ipa",
      "refrigerante",
    ],
    avgItemsPerOrder: 2,
    avgOrderValue: 4500, // R$45
    frequencyDays: 30,
    reviewProbability: 0.15,
    ratingAvg: 4,
  },

  congelados: {
    name: "Congelados",
    description: "Frozen goods buyer — bulk purchases, less frequent",
    preferredCategories: ["congelados"],
    preferredProducts: [
      "costela-defumada-congelada",
      "pulled-pork-congelado",
      "molho-barbecue-artesanal",
    ],
    avgItemsPerOrder: 2,
    avgOrderValue: 8000, // R$80
    frequencyDays: 21,
    reviewProbability: 0.25,
    ratingAvg: 4.2,
  },

  superfan: {
    name: "Superfã",
    description: "Brand loyalist — buys merch, kits, and food. High review rate.",
    preferredCategories: ["carnes-defumadas", "kits", "camisetas"],
    preferredProducts: [
      "brisket-americano",
      "kit-churrasco-ibatexas",
      "kit-presente-ibatexas",
      "camiseta-ibatexas-preta",
      "bone-ibatexas",
    ],
    avgItemsPerOrder: 4,
    avgOrderValue: 20000, // R$200
    frequencyDays: 10,
    reviewProbability: 0.6,
    ratingAvg: 4.8,
  },
}

export const PROFILE_NAMES = Object.keys(PROFILES)

// ── Scale presets ────────────────────────────────────────────────────────────

export interface ScalePreset {
  name: string
  customers: number
  ordersPerDay: number
  days: number
}

export const SCALE_PRESETS: Record<string, ScalePreset> = {
  small: {
    name: "small",
    customers: 20,
    ordersPerDay: 5,
    days: 30,
  },
  medium: {
    name: "medium",
    customers: 500,
    ordersPerDay: 50,
    days: 30,
  },
  large: {
    name: "large",
    customers: 10000,
    ordersPerDay: 500,
    days: 30,
  },
}

export const SCALE_NAMES = Object.keys(SCALE_PRESETS)
