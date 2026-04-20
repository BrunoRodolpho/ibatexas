// Order management CLI commands
//
// ibx orders rebuild --order-id <id>   — rebuild projection from OrderEventLog
// ibx orders inspect <id>              — show projection + event log for an order

import type { Command } from "commander"
import type { OrderFulfillmentStatus } from "@ibatexas/types"
import chalk from "chalk"
import ora from "ora"

export function registerOrdersCommands(group: Command): void {
  group.description("Orders — projection management and debugging")

  // ── orders inspect <id> ───────────────────────────────────────────────────
  group
    .command("inspect <orderId>")
    .description("Show projection state and event log for an order")
    .action(async (orderId: string) => {
      const spinner = ora(`Loading order ${orderId}…`).start()
      try {
        const { createOrderQueryService, createOrderEventLogService } = await import("@ibatexas/domain")
        const querySvc = createOrderQueryService()
        const eventLogSvc = createOrderEventLogService()

        const [projection, events] = await Promise.all([
          querySvc.getById(orderId),
          eventLogSvc.getByOrderId(orderId),
        ])

        spinner.stop()

        if (!projection) {
          console.log(chalk.yellow(`No projection found for order ${orderId}`))
        } else {
          console.log(chalk.bold("\n── Projection ──"))
          console.log(`  ID:         ${projection.id}`)
          console.log(`  Display ID: ${projection.displayId}`)
          console.log(`  Status:     ${chalk.cyan(projection.fulfillmentStatus)}`)
          console.log(`  Payment:    ${projection.paymentStatus}`)
          console.log(`  Version:    ${chalk.bold(String(projection.version))}`)
          console.log(`  Total:      R$ ${(projection.totalInCentavos / 100).toFixed(2)}`)
          console.log(`  Customer:   ${projection.customerId}`)
          console.log(`  Created:    ${projection.medusaCreatedAt.toISOString()}`)

          if (projection.statusHistory.length > 0) {
            console.log(chalk.bold("\n── Status History ──"))
            for (const h of projection.statusHistory) {
              const arrow = h.fromStatus === h.toStatus ? chalk.dim("(initial)") : `${h.fromStatus} → ${chalk.cyan(h.toStatus)}`
              console.log(`  v${h.version} ${arrow}  by ${h.actor}  ${chalk.dim(h.createdAt.toISOString())}`)
            }
          }
        }

        if (events.length === 0) {
          console.log(chalk.yellow("\nNo event log entries found"))
        } else {
          console.log(chalk.bold(`\n── Event Log (${events.length} entries) ──`))
          for (const evt of events) {
            console.log(`  ${chalk.dim(evt.timestamp.toISOString())} ${chalk.bold(evt.eventType)} ${chalk.gray(evt.idempotencyKey)}`)
          }
        }
      } catch (err) {
        spinner.fail(chalk.red(`Failed: ${(err as Error).message}`))
        process.exitCode = 1
      }
    })

  // ── orders rebuild ────────────────────────────────────────────────────────
  group
    .command("rebuild")
    .description("Rebuild an order projection from its event log")
    .requiredOption("--order-id <id>", "Order ID to rebuild")
    .option("--dry-run", "Print what would happen without writing")
    .action(async (opts: { orderId: string; dryRun?: boolean }) => {
      const { orderId, dryRun } = opts
      const prefix = dryRun ? "[DRY RUN] " : ""
      const spinner = ora(`${prefix}Loading event log for ${orderId}…`).start()

      try {
        const { createOrderEventLogService, createOrderQueryService, prisma } = await import("@ibatexas/domain")
        const { canTransition } = await import("@ibatexas/types") as { canTransition: (from: OrderFulfillmentStatus, to: OrderFulfillmentStatus) => boolean }
        const eventLogSvc = createOrderEventLogService()
        const querySvc = createOrderQueryService()

        // 1. Read all events for this order
        const events = await eventLogSvc.getByOrderId(orderId, { limit: 1000 })
        if (events.length === 0) {
          spinner.fail(chalk.red(`No event log entries found for ${orderId} — cannot rebuild`))
          process.exitCode = 1
          return
        }

        spinner.text = `${prefix}Found ${events.length} events. Replaying…`

        // 2. Get current projection (if any)
        const current = await querySvc.getById(orderId)

        // 3. Replay events to compute expected state
        let status = "pending" as string
        let version = 0

        for (const evt of events) {
          const payload = evt.payload as Record<string, unknown>

          if (evt.eventType === "order.placed") {
            status = (payload.fulfillment_status as string) ?? "pending"
            version = 1
          } else if (evt.eventType === "order.status_changed") {
            const newStatus = (payload.new_status as string) ?? (payload.newStatus as string)
            if (newStatus && canTransition(status as OrderFulfillmentStatus, newStatus as OrderFulfillmentStatus)) {
              status = newStatus
              version++
            }
          } else {
            // Other event types (refunded, disputed, etc.) — track version
            version++
          }
        }

        spinner.stop()

        console.log(chalk.bold("\n── Replay Result ──"))
        console.log(`  Expected status:  ${chalk.cyan(status)}`)
        console.log(`  Expected version: ${chalk.bold(String(version))}`)

        if (current) {
          console.log(`  Current status:   ${current.fulfillmentStatus === status ? chalk.green(current.fulfillmentStatus) : chalk.red(current.fulfillmentStatus)}`)
          console.log(`  Current version:  ${current.version === version ? chalk.green(String(current.version)) : chalk.red(String(current.version))}`)

          if (current.fulfillmentStatus === status && current.version === version) {
            console.log(chalk.green("\n✓ Projection matches event log — no rebuild needed"))
            return
          }
        } else {
          console.log(chalk.yellow("  No existing projection found"))
        }

        if (dryRun) {
          console.log(chalk.blue(`\n${prefix}Would update projection to status=${status}, version=${version}`))
          return
        }

        // 4. Apply the rebuild
        const rebuildSpinner = ora("Writing corrected projection…").start()

        await prisma.orderProjection.update({
          where: { id: orderId },
          data: {
            fulfillmentStatus: status as never,
            version,
          },
        })

        rebuildSpinner.succeed(chalk.green(`Projection rebuilt: status=${status}, version=${version}`))
      } catch (err) {
        spinner.fail(chalk.red(`Failed: ${(err as Error).message}`))
        process.exitCode = 1
      }
    })
}
