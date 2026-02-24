// Seed script: creates restaurant tables + time slots for the next 30 days.
// Run via: pnpm --filter @ibatexas/domain db:seed:tables
// Or via:  ibx db seed:domain

import { prisma } from "./client.js"

// ─── Tables ───────────────────────────────────────────────────────────────────

const TABLES = [
  // Indoor — main dining room
  { number: "1", capacity: 2, location: "indoor" as const, accessible: false },
  { number: "2", capacity: 2, location: "indoor" as const, accessible: false },
  { number: "3", capacity: 4, location: "indoor" as const, accessible: false },
  { number: "4", capacity: 4, location: "indoor" as const, accessible: false },
  { number: "5", capacity: 6, location: "indoor" as const, accessible: true },
  { number: "6", capacity: 8, location: "indoor" as const, accessible: true },
  // Outdoor — varanda
  { number: "7", capacity: 4, location: "outdoor" as const, accessible: false },
  { number: "8", capacity: 4, location: "outdoor" as const, accessible: false },
  { number: "9", capacity: 6, location: "outdoor" as const, accessible: false },
  // Bar
  { number: "B1", capacity: 2, location: "bar" as const, accessible: false },
  { number: "B2", capacity: 2, location: "bar" as const, accessible: false },
  // Terrace
  { number: "T1", capacity: 8, location: "terrace" as const, accessible: false },
]

// ─── Time slots ───────────────────────────────────────────────────────────────

// Lunch: 11:30 and 13:00 (2 turns)
// Dinner: 18:30, 20:00, and 21:30 (3 turns)
const LUNCH_STARTS = ["11:30", "13:00"]
const DINNER_STARTS = ["18:30", "20:00", "21:30"]

// Total covers at dinner = sum of table capacities = 2+2+4+4+6+8+4+4+6+2+2+8 = 52
// Lunch = same
const TOTAL_CAPACITY = TABLES.reduce((sum, t) => sum + t.capacity, 0)

function addDays(date: Date, days: number): Date {
  const d = new Date(date)
  d.setUTCDate(d.getUTCDate() + days)
  return d
}

async function seedTables() {
  console.log("🪑  Seeding tables…")

  // Upsert tables
  for (const table of TABLES) {
    await prisma.table.upsert({
      where: { number: table.number },
      update: { capacity: table.capacity, location: table.location, accessible: table.accessible },
      create: table,
    })
  }

  console.log(`✅  ${TABLES.length} tables upserted`)
}

async function seedTimeSlots(days = 30) {
  console.log(`📅  Seeding time slots for next ${days} days…`)

  const today = new Date()
  today.setUTCHours(0, 0, 0, 0)

  let created = 0

  for (let i = 0; i < days; i++) {
    const date = addDays(today, i)

    const allStarts = [...LUNCH_STARTS, ...DINNER_STARTS]

    for (const startTime of allStarts) {
      const existing = await prisma.timeSlot.findUnique({
        where: { date_startTime: { date, startTime } },
      })

      if (!existing) {
        await prisma.timeSlot.create({
          data: {
            date,
            startTime,
            durationMinutes: 90,
            maxCovers: TOTAL_CAPACITY,
            reservedCovers: 0,
          },
        })
        created++
      }
    }
  }

  console.log(`✅  ${created} time slots created`)
}

async function main() {
  try {
    await seedTables()
    await seedTimeSlots(30)
    console.log("\n🎉  Domain seed complete\n")
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
