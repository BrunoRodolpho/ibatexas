// ibx tag — manage product tags via Medusa admin API.
// Tags trigger product.updated subscriber → Typesense reindex + cache flush.

import type { Command } from "commander"
import chalk from "chalk"
import ora from "ora"

import {
  getAdminToken,
  validateTag,
  printAllowedTags,
  findProductByHandle,
  findOrCreateTag,
  updateProductTags,
  fetchAllProductsWithTags,
} from "../lib/medusa.js"
import { stabilizeProducts, verifyTypesenseDoc } from "../lib/stabilize.js"

// ── Commands ────────────────────────────────────────────────────────────────

export function registerTagCommands(group: Command): void {
  group.description("Tag management — add, remove, and list product tags")

  // ─── tag add ────────────────────────────────────────────────────────────
  group
    .command("add <handle> <tag>")
    .description("Add a tag to a product (triggers Typesense reindex + cache flush)")
    .action(async (handle: string, tag: string) => {
      if (!validateTag(tag)) {
        console.error(chalk.red(`\n  Unknown tag "${tag}".`))
        printAllowedTags()
        process.exit(1)
      }

      const spinner = ora("Authenticating…").start()

      try {
        const token = await getAdminToken()

        spinner.text = `Looking up product "${handle}"…`
        const product = await findProductByHandle(handle, token)
        if (!product) {
          spinner.fail(chalk.red(`Product "${handle}" not found`))
          process.exit(1)
        }

        // Check if tag already present
        const existingTags = product.tags ?? []
        if (existingTags.some((t) => t.value === tag)) {
          spinner.succeed(
            chalk.yellow(`"${product.title}" already has tag "${tag}"`)
          )
          return
        }

        // Find or create the tag entity
        spinner.text = `Ensuring tag "${tag}" exists…`
        const newTagId = await findOrCreateTag(tag, token)

        // Build deduplicated tag_ids
        const existingIds = existingTags.map((t) => t.id)
        const allTagIds = [...new Set([...existingIds, newTagId])]

        // Update product
        spinner.text = `Adding tag "${tag}" to "${product.title}"…`
        await updateProductTags(product.id, allTagIds, token)

        // Stabilize: reindex to Typesense + flush cache (deterministic, no blind wait)
        spinner.text = `Stabilizing "${product.title}" in Typesense…`
        await stabilizeProducts([product.id])

        // Verify the tag landed in Typesense
        const verified = await verifyTypesenseDoc(
          product.id,
          (doc) => Array.isArray(doc.tags) && (doc.tags as string[]).includes(tag),
        )

        spinner.succeed(
          chalk.green(`Added "${tag}" to ${product.title}`)
        )
        console.log(chalk.dim(
          verified
            ? "   Typesense reindexed · cache flushed · verified ✓"
            : "   Typesense reindexed · cache flushed",
        ))
      } catch (err) {
        spinner.fail(chalk.red(`Failed: ${(err as Error).message}`))
        process.exitCode = 1
      }
    })

  // ─── tag remove ─────────────────────────────────────────────────────────
  group
    .command("remove <handle> <tag>")
    .description("Remove a tag from a product")
    .action(async (handle: string, tag: string) => {
      const spinner = ora("Authenticating…").start()

      try {
        const token = await getAdminToken()

        spinner.text = `Looking up product "${handle}"…`
        const product = await findProductByHandle(handle, token)
        if (!product) {
          spinner.fail(chalk.red(`Product "${handle}" not found`))
          process.exit(1)
        }

        const existingTags = product.tags ?? []
        const tagToRemove = existingTags.find((t) => t.value === tag)
        if (!tagToRemove) {
          spinner.succeed(
            chalk.yellow(`"${product.title}" doesn't have tag "${tag}"`)
          )
          return
        }

        // Filter out the tag
        const filteredIds = existingTags
          .filter((t) => t.id !== tagToRemove.id)
          .map((t) => t.id)

        spinner.text = `Removing tag "${tag}" from "${product.title}"…`
        await updateProductTags(product.id, filteredIds, token)

        // Stabilize: reindex to Typesense + flush cache (deterministic, no blind wait)
        spinner.text = `Stabilizing "${product.title}" in Typesense…`
        await stabilizeProducts([product.id])

        // Verify the tag was removed from Typesense
        const verified = await verifyTypesenseDoc(
          product.id,
          (doc) => Array.isArray(doc.tags) && !(doc.tags as string[]).includes(tag),
        )

        spinner.succeed(
          chalk.green(`Removed "${tag}" from ${product.title}`)
        )
        console.log(chalk.dim(
          verified
            ? "   Typesense reindexed · cache flushed · verified ✓"
            : "   Typesense reindexed · cache flushed",
        ))
      } catch (err) {
        spinner.fail(chalk.red(`Failed: ${(err as Error).message}`))
        process.exitCode = 1
      }
    })

  // ─── tag list ───────────────────────────────────────────────────────────
  group
    .command("list [handle]")
    .description("List tags — for a specific product or all products with tags")
    .action(async (handle?: string) => {
      const spinner = ora("Authenticating…").start()

      try {
        const token = await getAdminToken()

        if (handle) {
          // Show tags for a specific product
          spinner.text = `Looking up product "${handle}"…`
          const product = await findProductByHandle(handle, token)
          if (!product) {
            spinner.fail(chalk.red(`Product "${handle}" not found`))
            process.exit(1)
          }

          spinner.stop()
          const tags = product.tags ?? []
          console.log(chalk.bold(`\n  ${product.title}`))
          if (tags.length === 0) {
            console.log(chalk.gray("  No tags"))
          } else {
            const badges = tags.map((t) => chalk.cyan(` ${t.value} `)).join("  ")
            console.log(`  ${badges}`)
          }
          console.log()
        } else {
          // Show all products with tags
          spinner.text = "Fetching all products…"
          const products = await fetchAllProductsWithTags(token)
          spinner.stop()

          const withTags = products.filter(
            (p) => p.tags && p.tags.length > 0,
          )

          if (withTags.length === 0) {
            console.log(chalk.yellow("\n  No products have tags yet.\n"))
            return
          }

          console.log(chalk.bold("\n  Products with tags:\n"))

          const titleWidth = 36
          for (const p of withTags) {
            const tags = (p.tags ?? []).map((t) => chalk.cyan(t.value)).join(", ")
            const title = p.title.length > titleWidth
              ? p.title.slice(0, titleWidth - 1) + "…"
              : p.title
            console.log(`    ${title.padEnd(titleWidth)}  ${tags}`)
          }
          console.log()
        }
      } catch (err) {
        spinner.fail(chalk.red(`Failed: ${(err as Error).message}`))
        process.exitCode = 1
      }
    })
}
