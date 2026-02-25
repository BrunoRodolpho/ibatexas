// Seed script: creates restaurant tables + time slots for the next 30 days.
// Run via: pnpm --filter @ibatexas/domain db:seed:tables
// Or via:  ibx db seed:domain

import { prisma } from "./client.js"
import {
  LUNCH_STARTS,
  DINNER_STARTS,
  SLOT_DURATION_MINUTES,
  SEED_DAYS_AHEAD,
} from "@ibatexas/types"

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

// Total covers = sum of table capacities
const TOTAL_CAPACITY = TABLES.reduce((sum, t) => sum + t.capacity, 0)

function addDays(date: Date, days: number): Date {
  const d = new Date(date)
  d.setUTCDate(d.getUTCDate() + days)
  return d
}

async function seedTables() {
  console.log("🪑  Seeding tables…")

  // Batch upsert via transaction
  await prisma.$transaction(
    TABLES.map((table) =>
      prisma.table.upsert({
        where: { number: table.number },
        update: { capacity: table.capacity, location: table.location, accessible: table.accessible },
        create: table,
      }),
    ),
  )

  console.log(`✅  ${TABLES.length} tables upserted`)
}

async function seedTimeSlots(days = SEED_DAYS_AHEAD) {
  console.log(`📅  Seeding time slots for next ${days} days…`)

  const today = new Date()
  today.setUTCHours(0, 0, 0, 0)

  const allStarts = [...LUNCH_STARTS, ...DINNER_STARTS]
  const rows: { date: Date; startTime: string; durationMinutes: number; maxCovers: number; reservedCovers: number }[] = []

  for (let i = 0; i < days; i++) {
    const date = addDays(today, i)
    for (const startTime of allStarts) {
      rows.push({
        date,
        startTime,
        durationMinutes: SLOT_DURATION_MINUTES,
        maxCovers: TOTAL_CAPACITY,
        reservedCovers: 0,
      })
    }
  }

  const result = await prisma.timeSlot.createMany({
    data: rows,
    skipDuplicates: true,
  })

  console.log(`✅  ${result.count} time slots created`)
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
