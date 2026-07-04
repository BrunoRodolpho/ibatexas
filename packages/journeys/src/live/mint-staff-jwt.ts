// live/mint-staff-jwt.ts — the WS9 ops live suite's DEV-ONLY staff-JWT minter.
//
//   tsx packages/journeys/src/live/mint-staff-jwt.ts --phone +12174174509
//   tsx packages/journeys/src/live/mint-staff-jwt.ts --staff-id <id> --role OWNER
//   -> {"token":"...","cookie":"staff_token=...","sub":"...","role":"OWNER","jti":"..."}
//
// Signs the exact claim shape issueStaffJwtToken produces (routes/auth.ts) with
// the dev stack's STAFF_JWT_SECRET (HS256). The api re-checks the `sub` against
// an ACTIVE ibx_domain.staff row on every request (middleware/auth.ts:178-179),
// so `--phone` LOOKS UP an existing active staff member (id + role) — the safe
// default. `--staff-id/--role` is for a staff id you already hold.
//
// CONTAINMENT: minting a staff token is a trust-anchor power. Guarded by
// NODE_ENV (refuses when =production) + an env-provided secret (never
// hard-coded). This is the DEV-stack sibling of clients/auth-fixture.ts, whose
// IBX_TEST_FINGERPRINT gate is the EPHEMERAL TEST profile's anchor instead.
//
// pt-BR: operator output is en per the script idiom (dev tool).

import { randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"
import { prisma } from "@ibatexas/domain"
import { buildStaffJwtClaims, signStaffJwt, staffCookie, STAFF_ROLES, type StaffRole } from "./staff-jwt.js"

interface MintArgs {
  staffId: string | undefined
  role: StaffRole | undefined
  phone: string | undefined
}

function parseArgs(argv: readonly string[]): MintArgs {
  let staffId: string | undefined
  let role: StaffRole | undefined
  let phone: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = (): string => {
      const v = argv[i + 1]
      if (v === undefined) throw new Error(`missing value for ${a}`)
      i++
      return v
    }
    switch (a) {
      case "--staff-id":
        staffId = next()
        break
      case "--role": {
        const r = next().toUpperCase()
        if (!STAFF_ROLES.includes(r as StaffRole)) {
          throw new Error(`--role must be one of ${STAFF_ROLES.join(" | ")}, got ${r}`)
        }
        role = r as StaffRole
        break
      }
      case "--phone":
        phone = next()
        break
      default:
        throw new Error(`unknown argument: ${a}`)
    }
  }
  return { staffId, role, phone }
}

/** Resolve staffId + role, either from --phone (active-row lookup) or --staff-id/--role. */
async function resolveStaff(
  args: MintArgs,
): Promise<{ staffId: string; role: StaffRole }> {
  if (args.phone !== undefined) {
    const staff = await prisma.staff.findUnique({ where: { phone: args.phone } })
    if (!staff) {
      throw new Error(`no staff row for phone ${args.phone} (create with: ibx auth create-staff)`)
    }
    if (!staff.active) {
      throw new Error(`staff ${args.phone} is inactive — the api rejects inactive staff tokens`)
    }
    const role = args.role ?? (staff.role as StaffRole)
    if (args.role !== undefined && args.role !== staff.role) {
      throw new Error(
        `--role ${args.role} disagrees with the seeded role ${staff.role} for ${args.phone}; a token whose role claim differs from the row is dishonest`,
      )
    }
    return { staffId: staff.id, role }
  }
  if (args.staffId === undefined || args.role === undefined) {
    throw new Error("provide either --phone <e164>, or both --staff-id <id> and --role <ROLE>")
  }
  return { staffId: args.staffId, role: args.role }
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === "production") {
    throw new Error("mint-staff-jwt refuses to run with NODE_ENV=production")
  }
  const secret = process.env.STAFF_JWT_SECRET
  if (!secret || secret.trim() === "") {
    throw new Error("mint-staff-jwt: STAFF_JWT_SECRET is not set (source the dev .env first)")
  }

  const args = parseArgs(process.argv.slice(2))
  const { staffId, role } = await resolveStaff(args)
  const jti = randomUUID()
  const claims = buildStaffJwtClaims({ staffId, role, jti })
  const token = signStaffJwt(claims, { secret })

  process.stdout.write(
    `${JSON.stringify({
      token,
      cookie: staffCookie(token),
      sub: staffId,
      role,
      jti,
    })}\n`,
  )
}

const invokedPath = process.argv[1] ?? ""
if (invokedPath !== "" && fileURLToPath(import.meta.url) === invokedPath) {
  // Top-level await (repo entry-script convention) rather than a promise chain.
  try {
    await main()
    await prisma.$disconnect()
    process.exit(0)
  } catch (err: unknown) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
    await prisma.$disconnect().catch(() => {})
    process.exit(1)
  }
}
