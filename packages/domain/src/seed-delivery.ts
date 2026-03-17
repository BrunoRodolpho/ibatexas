// Seed script: creates delivery zones, customer addresses, and dietary preferences.
// Run via: pnpm --filter @ibatexas/domain db:seed:delivery
// Or via:  ibx db seed:delivery

import { prisma } from "./client.js"
import { SEED_CUSTOMER_PHONES } from "./seed-constants.js"

// ── Delivery zones ──────────────────────────────────────────────────────────

const DELIVERY_ZONES = [
  {
    name: "Araraquara Centro",
    cepPrefixes: ["14800", "14801", "14802", "14803", "14804"],
    feeInCentavos: 800,
    estimatedMinutes: 30,
    active: true,
  },
  {
    name: "Araraquara Periferia",
    cepPrefixes: ["14805", "14806", "14807", "14808", "14809"],
    feeInCentavos: 1200,
    estimatedMinutes: 45,
    active: true,
  },
  {
    name: "Ibaté",
    cepPrefixes: ["14815"],
    feeInCentavos: 1500,
    estimatedMinutes: 50,
    active: true,
  },
  {
    name: "São Carlos",
    cepPrefixes: ["13560", "13561", "13562", "13563", "13564", "13565", "13566"],
    feeInCentavos: 2500,
    estimatedMinutes: 75,
    active: true,
  },
]

// ── Customer addresses ──────────────────────────────────────────────────────

const SEED_ADDRESSES = [
  {
    phone: "+5519900000001",
    street: "Rua Voluntários da Pátria",
    number: "1234",
    complement: "Apto 12",
    district: "Centro",
    city: "Araraquara",
    state: "SP",
    cep: "14801060",
    isDefault: true,
  },
  {
    phone: "+5519900000002",
    street: "Avenida Brasil",
    number: "567",
    complement: null,
    district: "Vila Xavier",
    city: "Araraquara",
    state: "SP",
    cep: "14805120",
    isDefault: true,
  },
  {
    phone: "+5519900000003",
    street: "Rua São Paulo",
    number: "890",
    complement: "Casa 2",
    district: "Centro",
    city: "Ibaté",
    state: "SP",
    cep: "14815000",
    isDefault: true,
  },
  {
    phone: "+5519900000004",
    street: "Rua Padre Duarte",
    number: "345",
    complement: null,
    district: "Jardim Primavera",
    city: "Araraquara",
    state: "SP",
    cep: "14802350",
    isDefault: true,
  },
  {
    phone: "+5519900000005",
    street: "Avenida São Carlos",
    number: "2100",
    complement: "Bloco B, Apto 45",
    district: "Centro",
    city: "São Carlos",
    state: "SP",
    cep: "13560005",
    isDefault: true,
  },
]

// ── Customer preferences ────────────────────────────────────────────────────

const SEED_PREFERENCES = [
  {
    phone: "+5519900000001",
    dietaryRestrictions: [] as string[],
    allergenExclusions: [] as string[],
    favoriteCategories: ["carnes-defumadas", "acompanhamentos"],
  },
  {
    phone: "+5519900000002",
    dietaryRestrictions: ["sem_gluten"],
    allergenExclusions: ["gluten"],
    favoriteCategories: ["carnes-defumadas", "congelados"],
  },
  {
    phone: "+5519900000003",
    dietaryRestrictions: [] as string[],
    allergenExclusions: [] as string[],
    favoriteCategories: ["sobremesas", "bebidas"],
  },
  {
    phone: "+5519900000004",
    dietaryRestrictions: ["sem_lactose"],
    allergenExclusions: ["lactose"],
    favoriteCategories: ["carnes-defumadas", "sanduiches"],
  },
  {
    phone: "+5519900000005",
    dietaryRestrictions: ["vegetariano"],
    allergenExclusions: ["gluten", "lactose"],
    favoriteCategories: ["acompanhamentos", "sobremesas", "bebidas"],
  },
]

// ── Seeding functions ───────────────────────────────────────────────────────

async function seedDeliveryZones() {
  console.log("🚚  Seeding delivery zones…")

  let count = 0
  for (const zone of DELIVERY_ZONES) {
    const existing = await prisma.deliveryZone.findFirst({
      where: { name: zone.name },
    })
    if (existing) {
      await prisma.deliveryZone.update({
        where: { id: existing.id },
        data: zone,
      })
    } else {
      await prisma.deliveryZone.create({ data: zone })
    }
    count++
  }

  console.log(`✅  ${count} delivery zones seeded`)
}

async function seedAddresses(customerMap: Map<string, string>) {
  console.log("🏠  Seeding customer addresses…")

  let count = 0
  for (const addr of SEED_ADDRESSES) {
    const customerId = customerMap.get(addr.phone)
    if (!customerId) {
      console.log(`  ⚠️  Customer ${addr.phone} not found, skipping address`)
      continue
    }

    const existing = await prisma.address.findFirst({
      where: { customerId, isDefault: true },
    })
    if (existing) {
      await prisma.address.update({
        where: { id: existing.id },
        data: {
          street: addr.street,
          number: addr.number,
          complement: addr.complement,
          district: addr.district,
          city: addr.city,
          state: addr.state,
          cep: addr.cep,
          isDefault: addr.isDefault,
        },
      })
    } else {
      await prisma.address.create({
        data: {
          customerId,
          street: addr.street,
          number: addr.number,
          complement: addr.complement,
          district: addr.district,
          city: addr.city,
          state: addr.state,
          cep: addr.cep,
          isDefault: addr.isDefault,
        },
      })
    }
    count++
  }

  console.log(`✅  ${count} addresses seeded`)
}

async function seedPreferences(customerMap: Map<string, string>) {
  console.log("🥗  Seeding customer preferences…")

  let count = 0
  for (const pref of SEED_PREFERENCES) {
    const customerId = customerMap.get(pref.phone)
    if (!customerId) {
      console.log(`  ⚠️  Customer ${pref.phone} not found, skipping preferences`)
      continue
    }

    await prisma.customerPreferences.upsert({
      where: { customerId },
      update: {
        dietaryRestrictions: pref.dietaryRestrictions,
        allergenExclusions: pref.allergenExclusions,
        favoriteCategories: pref.favoriteCategories,
      },
      create: {
        customerId,
        dietaryRestrictions: pref.dietaryRestrictions,
        allergenExclusions: pref.allergenExclusions,
        favoriteCategories: pref.favoriteCategories,
      },
    })
    count++
  }

  console.log(`✅  ${count} customer preferences seeded`)
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  try {
    await seedDeliveryZones()

    // Single customer lookup shared by addresses + preferences
    const customers = await prisma.customer.findMany({
      where: { phone: { in: SEED_CUSTOMER_PHONES } },
      select: { id: true, phone: true },
    })
    const customerMap = new Map(customers.map((c) => [c.phone, c.id]))

    await seedAddresses(customerMap)
    await seedPreferences(customerMap)
    console.log("\n🎉  Delivery seed complete\n")
  } finally {
    await prisma.$disconnect()
  }
}

try {
  await main()
} catch (err) {
  console.error(err)
  process.exit(1)
}
