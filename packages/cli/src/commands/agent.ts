// ibx agent — managed-agent registry + test-plane trigger injection (T3-9).
//
// `agent list`     prints the composed AGENT_REGISTRY.
// `agent trigger`  injects a wake (trigger) event for an agent via the SINGLE
//                  allowlisted publish helper (`injectPixFailureTrigger`),
//                  which REFUSES without IBX_TEST_FINGERPRINT. For the agent to
//                  actually run, the SUT must have IBX_AGENTS_ENABLED=true; the
//                  agent's decision is observed in the adjudicate console
//                  /agents view (intent_audit session_id LIKE 'agent:%').

import type { Command } from "commander"
import chalk from "chalk"
import { AGENT_REGISTRY } from "@ibatexas/agents"
import { injectPixFailureTrigger } from "@ibatexas/journeys"

export function registerAgentCommands(group: Command): void {
  group.description("Agents — managed-agent registry + test-plane trigger injection (test plane)")

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
          console.log(
            `    ${chalk.dim(`eventId=${eventId} order=${orderId} payment=${paymentId}`)}`,
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
