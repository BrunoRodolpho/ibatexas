// ibx staff — OWNER-only staff administration from the CLI (AUT-038 + AUT-007).
//
// `staff list`               lists staff (name, phone, role, active, hourly rate).
// `staff update <id>`        edits name / phone / hourly rate (NOT role).
// `staff deactivate <id>`    soft-deactivates a staff member (confirm-gated).
// `staff assign-role <id> <role>`  changes a staff member's role (confirm-gated).
//
// Creation stays with `ibx auth create-staff` (direct Prisma, no admin route) —
// there is deliberately no `staff create` here. The four verbs above call the
// PR1 OWNER-gated admin HTTP routes with the admin API key (x-admin-key), reusing
// the shared `lib/admin-http` transport (base-URL + key resolution + never-throws
// fetch). Mirrors `ibx agent` (BKL-120) structure and output style.
//   Routes (apps/api/src/routes/admin/staff.ts — every route requireOwnerRole):
//     GET   /api/admin/staff[?role=&active=]
//     PATCH /api/admin/staff/:id            { name?, phone?, hourlyRateCentavos? }
//     POST  /api/admin/staff/:id/deactivate
//     POST  /api/admin/staff/:id/role       { role }
//
// Error shapes: the route HANDLER replies `{ error: "<pt-BR>" }` (typed errors +
// kernel refusals), while the requireOwnerRole preHandler + Fastify/zod reply
// `{ error: "Forbidden"|"Bad Request", message: "<pt-BR>" }`. `staffServerMessage`
// prefers `message` then `error` so the pt-BR sentence surfaces in BOTH cases and
// the bare English reason phrase (only ever paired with a message) is never shown.

import type { Command } from "commander"
import { confirm } from "@inquirer/prompts"
import chalk from "chalk"
import { callAdmin, type AdminOutcome } from "../lib/admin-http.js"

/** The closed staff-role set (mirrors the route's StaffRoleEnum). */
const STAFF_ROLES = ["OWNER", "MANAGER", "ATTENDANT"] as const
type StaffRole = (typeof STAFF_ROLES)[number]

function isStaffRole(value: string): value is StaffRole {
  return (STAFF_ROLES as readonly string[]).includes(value)
}

// ── Status → operator-message mapping ────────────────────────────────────────

/**
 * The server's pt-BR text: its `message` field when present (preHandler / zod),
 * else its `error` field (route handler typed errors + kernel refusals). See the
 * file header for why `message` wins over `error`.
 */
export function staffServerMessage(body: unknown): string | undefined {
  const b = body as { message?: unknown; error?: unknown } | null | undefined
  const message = typeof b?.message === "string" ? b.message.trim() : ""
  if (message.length > 0) return message
  const error = typeof b?.error === "string" ? b.error.trim() : ""
  return error.length > 0 ? error : undefined
}

/** Map a non-2xx admin response to an operator message (server pt-BR passed through). */
export function staffHttpErrorMessage(status: number, body: unknown): string {
  const msg = staffServerMessage(body)
  switch (status) {
    case 401:
      return "Unauthorized — the ADMIN_API_KEY was rejected by the API (check the key value)."
    case 403:
      return msg ?? "Forbidden — the admin key needs the OWNER role (ADMIN_API_KEY_ROLES_JSON)."
    case 400:
      return msg ?? "Dados inválidos."
    case 404:
      return msg ?? "Funcionário não encontrado."
    case 409:
      return msg ?? "Conflito — telefone duplicado, último proprietário, ou alteração concorrente."
    default:
      return `Request failed (HTTP ${status})${msg ? ` — ${msg}` : ""}`
  }
}

/**
 * Print the failure and set a non-zero exit code, or return the success body.
 * Returns null on any failure (our routes never return a null 2xx body).
 */
function unwrap(outcome: AdminOutcome): unknown | null {
  if (!outcome.ok) {
    console.error(chalk.red(`  ✗ ${outcome.error}`))
    process.exitCode = 1
    return null
  }
  if (outcome.status < 200 || outcome.status >= 300) {
    console.error(chalk.red(`  ✗ ${staffHttpErrorMessage(outcome.status, outcome.body)}`))
    process.exitCode = 1
    return null
  }
  return outcome.body
}

// ── Rendering ────────────────────────────────────────────────────────────────

interface StaffRow {
  id: string
  phone: string
  name: string
  role: string
  active: boolean
  hourlyRateCentavos: number | null
}

/** INTEGER centavos → "R$ 25,00/h"; a null / unset rate → em-dash (Hard Rule #2). */
export function formatRate(centavos: number | null | undefined): string {
  if (centavos === null || centavos === undefined || !Number.isFinite(centavos)) return "—"
  return `R$ ${(Math.trunc(centavos) / 100).toFixed(2).replace(".", ",")}/h`
}

function staffLine(s: StaffRow): string {
  return chalk.dim(
    `id=${s.id}  phone=${s.phone}  rate=${formatRate(s.hourlyRateCentavos)}`,
  )
}

export function printStaffList(staff: StaffRow[]): void {
  if (staff.length === 0) {
    console.log(chalk.dim("\n  No staff found.\n"))
    return
  }
  console.log(chalk.bold("\n  Staff\n"))
  for (const s of staff) {
    const badge = s.active ? chalk.green("● active  ") : chalk.gray("● inactive")
    console.log(`  ${badge}  ${chalk.cyan(s.role.padEnd(9))} ${s.name}`)
    console.log(`    ${staffLine(s)}`)
  }
  console.log()
}

function printStaffResult(staff: StaffRow | undefined, action: string): void {
  if (!staff) {
    console.log(chalk.green(`  ✓ ${action}`))
    return
  }
  const badge = staff.active ? chalk.green("● active") : chalk.gray("● inactive")
  console.log(`  ${badge}  ${chalk.cyan(staff.role)}  ${staff.name} — ${action}`)
  console.log(`    ${staffLine(staff)}`)
}

// ── Command registration ──────────────────────────────────────────────────────

export function registerStaffCommands(group: Command): void {
  group.description(
    "Staff — OWNER-only staff administration (list, update, deactivate, assign role)",
  )

  // ─── staff list ─────────────────────────────────────────────────────────────
  group
    .command("list")
    .description("List staff — name, phone, role, active state, hourly rate (OWNER-only)")
    .option("--role <role>", "Filter by role: OWNER | MANAGER | ATTENDANT")
    .option("--active", "Only active staff")
    .option("--inactive", "Only inactive staff")
    .action(async (opts: { role?: string; active?: boolean; inactive?: boolean }) => {
      if (opts.active && opts.inactive) {
        console.error(chalk.red("  ✗ Use only one of --active / --inactive."))
        process.exitCode = 1
        return
      }
      const params = new URLSearchParams()
      if (opts.role !== undefined) {
        const role = opts.role.toUpperCase()
        if (!isStaffRole(role)) {
          console.error(
            chalk.red(`  ✗ Invalid role: ${opts.role}. Must be one of: ${STAFF_ROLES.join(", ")}`),
          )
          process.exitCode = 1
          return
        }
        params.set("role", role)
      }
      if (opts.active) params.set("active", "true")
      if (opts.inactive) params.set("active", "false")
      const qs = params.toString()
      const body = unwrap(await callAdmin("GET", `/api/admin/staff${qs ? `?${qs}` : ""}`))
      if (body === null) return
      const staff = (body as { staff?: StaffRow[] }).staff ?? []
      printStaffList(staff)
    })

  // ─── staff update ───────────────────────────────────────────────────────────
  group
    .command("update <id>")
    .description("Update a staff member's name / phone / hourly rate (NOT role)")
    .option("--name <name>", "New name")
    .option("--phone <phone>", "New phone (E.164, e.g. +5511999999999)")
    .option("--rate <centavos>", "Hourly rate in INTEGER centavos (2500 = R$ 25,00)")
    .option("--clear-rate", "Remove the hourly rate (set to null)")
    .action(
      async (
        id: string,
        opts: { name?: string; phone?: string; rate?: string; clearRate?: boolean },
      ) => {
        if (opts.rate !== undefined && opts.clearRate) {
          console.error(chalk.red("  ✗ Use only one of --rate / --clear-rate."))
          process.exitCode = 1
          return
        }
        const body: Record<string, unknown> = {}
        if (opts.name !== undefined) body.name = opts.name
        if (opts.phone !== undefined) body.phone = opts.phone
        if (opts.clearRate) {
          body.hourlyRateCentavos = null
        } else if (opts.rate !== undefined) {
          const centavos = Number(opts.rate)
          if (!Number.isInteger(centavos) || centavos < 0) {
            console.error(
              chalk.red("  ✗ --rate must be a non-negative INTEGER of centavos (2500 = R$ 25,00)."),
            )
            process.exitCode = 1
            return
          }
          body.hourlyRateCentavos = centavos
        }
        if (Object.keys(body).length === 0) {
          console.error(
            chalk.red("  ✗ Nothing to update — pass --name, --phone, --rate, or --clear-rate."),
          )
          process.exitCode = 1
          return
        }
        const result = unwrap(
          await callAdmin("PATCH", `/api/admin/staff/${encodeURIComponent(id)}`, body),
        )
        if (result === null) return
        printStaffResult((result as { staff?: StaffRow }).staff, "atualizado")
      },
    )

  // ─── staff deactivate ─────────────────────────────────────────────────────────
  group
    .command("deactivate <id>")
    .description("Soft-deactivate a staff member — removes panel/ops access (confirm-gated)")
    .option("-y, --yes", "Skip the confirmation prompt")
    .action(async (id: string, opts: { yes?: boolean }) => {
      if (!opts.yes) {
        const confirmed = await confirm({
          message: chalk.yellow(
            `⚠️  Deactivate staff "${id}"? They lose panel/ops access immediately.`,
          ),
          default: false,
        })
        if (!confirmed) {
          console.log(chalk.gray("Aborted."))
          return
        }
      }
      const result = unwrap(
        await callAdmin("POST", `/api/admin/staff/${encodeURIComponent(id)}/deactivate`),
      )
      if (result === null) return
      printStaffResult((result as { staff?: StaffRow }).staff, "desativado")
    })

  // ─── staff assign-role ────────────────────────────────────────────────────────
  group
    .command("assign-role <id> <role>")
    .description("Assign a staff member's role: OWNER | MANAGER | ATTENDANT (privilege change; confirm-gated)")
    .option("-y, --yes", "Skip the confirmation prompt")
    .action(async (id: string, role: string, opts: { yes?: boolean }) => {
      const upper = role.toUpperCase()
      if (!isStaffRole(upper)) {
        console.error(
          chalk.red(`  ✗ Invalid role: ${role}. Must be one of: ${STAFF_ROLES.join(", ")}`),
        )
        process.exitCode = 1
        return
      }
      if (!opts.yes) {
        const confirmed = await confirm({
          message: chalk.yellow(
            `⚠️  Change role of "${id}" to ${upper}? This changes their access level.`,
          ),
          default: false,
        })
        if (!confirmed) {
          console.log(chalk.gray("Aborted."))
          return
        }
      }
      const result = unwrap(
        await callAdmin("POST", `/api/admin/staff/${encodeURIComponent(id)}/role`, { role: upper }),
      )
      if (result === null) return
      printStaffResult((result as { staff?: StaffRow }).staff, `cargo alterado para ${upper}`)
    })
}
