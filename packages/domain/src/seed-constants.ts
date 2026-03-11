// Shared seed data constants used across multiple seed scripts.
// Import from here instead of duplicating customer lists.

export const SEED_CUSTOMERS = [
  { phone: "+5519900000001", name: "Maria Silva" },
  { phone: "+5519900000002", name: "João Santos" },
  { phone: "+5519900000003", name: "Ana Oliveira" },
  { phone: "+5519900000004", name: "Carlos Pereira" },
  { phone: "+5519900000005", name: "Fernanda Costa" },
  { phone: "+5519900000006", name: "Lucas Mendes" },
  { phone: "+5519900000007", name: "Beatriz Lima" },
  { phone: "+5519900000008", name: "Rafael Almeida" },
  { phone: "+5519900000009", name: "Gabriela Souza" },
  { phone: "+5519900000010", name: "Pedro Rocha" },
] as const

/** Phone numbers only — for quick lookups in seed scripts. */
export const SEED_CUSTOMER_PHONES = SEED_CUSTOMERS.map((c) => c.phone)
