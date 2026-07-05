// ibx agent — managed-agent registry, kill-switch operator controls, and
// test-plane trigger injection.
//
// `agent list`            prints the composed AGENT_REGISTRY.
// `agent status [id]`     shows each agent's kill-switch state (killed vs live).
// `agent kill <id>`       trips an agent's kill-switch (emergency brake). Confirm-gated.
// `agent restore <id>`    clears an agent's kill-switch (restore operation). Make-safe.
// `agent trigger`         injects a wake (trigger) event for an agent via the SINGLE
//                         allowlisted publish helper (`injectPixFailureTrigger`),
//                         which REFUSES without IBX_TEST_FINGERPRINT. For the agent to
//                         actually run, the SUT must have IBX_AGENTS_ENABLED=true; the
//                         agent's decision is observed in the adjudicate console
//                         /agents view (intent_audit session_id LIKE 'agent:%').
//
// The kill-switch MANAGER is an in-process API singleton (claustrum-bootstrap),
// so the CLI cannot reach it directly — status/kill/restore call the BKL-098
// manager-gated admin HTTP routes with the admin API key (x-admin-key). The
// transport (base-URL + x-admin-key resolution + never-throws fetch) now lives in
// the shared `lib/admin-http.js` (promoted there when `ibx staff` became the
// second admin-route caller); the agent-specific status→message mapping stays here.
//   Routes (apps/api/src/routes/admin/agents-kill-switch.ts):
//     GET  /api/admin/agents/kill-status[?agentId=]
//     POST /api/admin/agents/:agentId/kill      { reason? }
//     POST /api/admin/agents/:agentId/unkill

import type { Command } from "commander"
import { confirm } from "@inquirer/prompts"
import chalk from "chalk"
import { AGENT_REGISTRY } from "@ibatexas/agents"
import { injectPixFailureTrigger } from "@ibatexas/journeys"
import { callAdmin, resolveAdminKey, getAdminApiUrl, type AdminOutcome } from "../lib/admin-http.js"

// Re-export the shared transport so existing importers (and the BKL-120 test that
// imports `resolveAdminKey` from this module) keep working after the extraction.
export { callAdmin, resolveAdminKey, getAdminApiUrl }
export type { AdminOutcome }

// ── Agent-specific status → operator-message mapping ─────────────────────────

/** Extract the server's `message` field (pt-BR) when present. */
export function serverMessage(body: unknown): string | undefined {
  const m = (body as { message?: unknown } | null | undefined)?.message
  return typeof m === "string" && m.length > 0 ? m : undefined
}

/** Map a non-2xx admin response to an operator message (server pt-BR passed through). */
export function httpErrorMessage(status: number, body: unknown): string {
  const msg = serverMessage(body)
  switch (status) {
    case 401:
      return "Unauthorized — the ADMIN_API_KEY was rejected by the API (check the key value)."
    case 403:
      return msg ?? "Forbidden — the admin key needs an OWNER/MANAGER role (ADMIN_API_KEY_ROLES_JSON)."
    case 404:
      return msg ?? "Unknown agent."
    case 503:
      return msg ?? "Agent plane unavailable (IBX_AGENTS_ENABLED)."
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
    console.error(chalk.red(`  ✗ ${httpErrorMessage(outcome.status, outcome.body)}`))
    process.exitCode = 1
    return null
  }
  return outcome.body
}

interface KillStatusRow {
  agentId: string
  killed: boolean
}

export function printKillStatus(agents: KillStatusRow[]): void {
  if (agents.length === 0) {
    console.log(chalk.dim("\n  No managed agents registered.\n"))
    return
  }
  console.log(chalk.bold("\n  Agent kill-switch state\n"))
  for (const a of agents) {
    const badge = a.killed ? chalk.red("● KILLED") : chalk.green("● live  ")
    console.log(`  ${badge}  ${chalk.cyan(a.agentId)}`)
  }
  console.log()
}

function printKillResult(agentId: string, body: unknown, clearedAction: string): void {
  const killed = (body as { killed?: boolean }).killed === true
  const badge = killed ? chalk.red("● KILLED") : chalk.green("● live  ")
  console.log(`  ${badge}  ${chalk.cyan(agentId)} — ${clearedAction}`)
}

export function registerAgentCommands(group: Command): void {
  group.description(
    "Agents — managed-agent registry, kill-switch operator controls, and test-plane trigger injection",
  )

  // ─── agent list ───────────────────────────────────────────────────────────
  group
    .command("list")
    .description("List the registered managed agents (AGENT_REGISTRY)")
    .action(() => {
      console.log(chalk.bold("\n  Managed agents\n"))
      for (const a of AGENT_REGISTRY) {
        console.log(`  ${chalk.cyan(a.id.padEnd(36))} ${a.displayName}`)
        console.log(
          `    ${chalk.dim(
            `triggers: ${a.trigger.subjects.join(", ")} · ` +
              `kinds: ${a.declaredIntentKinds.join(", ")}`,
          )}`,
        )
      }
      console.log()
    })

  // ─── agent status ─────────────────────────────────────────────────────────
  group
    .command("status [agentId]")
    .description("Show each managed agent's kill-switch state (killed vs live); pass an id for one")
    .action(async (agentId?: string) => {
      const path = agentId
        ? `/api/admin/agents/kill-status?agentId=${encodeURIComponent(agentId)}`
        : "/api/admin/agents/kill-status"
      const body = unwrap(await callAdmin("GET", path))
      if (body === null) return
      const agents = (body as { agents?: KillStatusRow[] }).agents ?? []
      printKillStatus(agents)
    })

  // ─── agent kill ───────────────────────────────────────────────────────────
  group
    .command("kill <agentId>")
    .description("Trip an agent's kill-switch — the emergency brake that stops the agent (confirm-gated)")
    .option("--reason <reason>", "Optional ops note stored with the trip")
    .option("-y, --yes", "Skip the confirmation prompt")
    .action(async (agentId: string, opts: { reason?: string; yes?: boolean }) => {
      if (!opts.yes) {
        const confirmed = await confirm({
          message: chalk.yellow(
            `⚠️  Trip the kill-switch for "${agentId}"? This immediately stops the agent.`,
          ),
          default: false,
        })
        if (!confirmed) {
          console.log(chalk.gray("Aborted."))
          return
        }
      }
      const body = unwrap(
        await callAdmin(
          "POST",
          `/api/admin/agents/${encodeURIComponent(agentId)}/kill`,
          opts.reason ? { reason: opts.reason } : undefined,
        ),
      )
      if (body === null) return
      printKillResult(agentId, body, "kill-switch tripped")
    })

  // ─── agent restore ────────────────────────────────────────────────────────
  group
    .command("restore <agentId>")
    .description("Clear an agent's kill-switch and restore its operation (make-safe — no confirmation)")
    .action(async (agentId: string) => {
      const body = unwrap(
        await callAdmin("POST", `/api/admin/agents/${encodeURIComponent(agentId)}/unkill`),
      )
      if (body === null) return
      printKillResult(agentId, body, "kill-switch cleared")
    })

  // ─── agent trigger ────────────────────────────────────────────────────────
  group
    .command("trigger [agentId]")
    .description(
      "Inject a wake (trigger) event for an agent — requires IBX_TEST_FINGERPRINT + IBX_AGENTS_ENABLED on the SUT",
    )
    .option("--order <orderId>", "Order the failed PIX charge belongs to")
    .option("--payment <paymentId>", "Payment id whose status changed")
    .option("--status <status>", "failed | expired", "failed")
    .action(
      async (
        agentId: string | undefined,
        opts: { order?: string; payment?: string; status?: string },
      ) => {
        const id = agentId ?? AGENT_REGISTRY[0]?.id
        const agent = AGENT_REGISTRY.find((a) => a.id === id)
        if (agent === undefined) {
          console.error(
            chalk.red(
              `  Unknown agent: ${id ?? "(none)"}. Known: ${AGENT_REGISTRY.map((a) => a.id).join(", ")}`,
            ),
          )
          process.exitCode = 1
          return
        }

        // The only authored agent today is PIX remediation; its trigger is a
        // payment.status_changed (failed/expired) event. Synthetic entity ids
        // (unique per invocation) keep the deterministic-nonce dedup distinct
        // across runs when --order/--payment are not supplied.
        const stamp = Date.now()
        const orderId = opts.order ?? `qa-order-${stamp}`
        const paymentId = opts.payment ?? `qa-payment-${stamp}`
        const status = opts.status === "expired" ? "expired" : "failed"

        try {
          const { eventId } = await injectPixFailureTrigger({
            orderId,
            paymentId,
            newStatus: status,
          })
          console.log(
            chalk.green("  ✓ trigger injected") +
              ` agent=${agent.id} subject=payment.status_changed status=${status}`,
          )
          const triggerDetail = `eventId=${eventId} order=${orderId} payment=${paymentId}`
          console.log(
            `    ${chalk.dim(triggerDetail)}`,
          )
          console.log(
            `    ${chalk.dim(
              "observe the agent decision in the adjudicate console /agents (session_id LIKE 'agent:%')",
            )}`,
          )
        } catch (err) {
          console.error(chalk.red(`  ✗ trigger failed: ${(err as Error).message}`))
          process.exitCode = 1
        }
      },
    )
}
