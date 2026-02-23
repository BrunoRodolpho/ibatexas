import type { Command } from "commander"
import { input, select, checkbox } from "@inquirer/prompts"
import chalk from "chalk"
import ora from "ora"

// ── Types ─────────────────────────────────────────────────────────────────────

interface MedusaProduct {
  id: string
  title: string
  status: string
  categories?: { name: string }[]
  variants?: unknown[]
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getMedusaUrl(): string {
  const url = process.env.MEDUSA_BACKEND_URL
  if (!url) {
    console.error(chalk.red("MEDUSA_BACKEND_URL is not set"))
    process.exit(1)
  }
  return url
}

async function medusaFetch(path: string, options?: RequestInit): Promise<Record<string, unknown>> {
  const base = getMedusaUrl()
  const res = await fetch(`${base}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options?.headers ?? {}),
    },
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Medusa API error ${res.status}: ${text}`)
  }
  return res.json() as Promise<Record<string, unknown>>
}

// ── Command registration ──────────────────────────────────────────────────────

export function registerApiCommands(api: Command) {
  const products = api
    .command("products")
    .description("Manage the product catalog")

  // ── ibx api products list ───────────────────────────────────────────────
  products
    .command("list")
    .description("List all products from Medusa")
    .option("-l, --limit <n>", "Number of products to show", "50")
    .action(async (opts: { limit: string }) => {
      const spinner = ora("Fetching products...").start()
      try {
        const data = await medusaFetch(
          `/admin/products?limit=${opts.limit}&fields=id,title,status,categories,variants`
        )
        spinner.stop()

        const items = (data.products as MedusaProduct[] | undefined) ?? []
        if (!items.length) {
          console.log(chalk.gray("No products found."))
          return
        }

        console.log(
          chalk.bold(
            `\n  ${"ID".padEnd(30)} ${"Title".padEnd(35)} ${"Status".padEnd(12)} ${"Category".padEnd(22)} Variants`
          )
        )
        console.log("  " + "─".repeat(110))

        for (const p of items) {
          const category = p.categories?.[0]?.name ?? "—"
          const variantCount = p.variants?.length ?? 0
          const statusColor = p.status === "published" ? chalk.green : chalk.yellow
          console.log(
            `  ${chalk.gray(p.id.padEnd(30))} ${p.title.padEnd(35)} ${statusColor(p.status.padEnd(12))} ${category.padEnd(22)} ${variantCount}`
          )
        }

        console.log(chalk.gray(`\n  ${items.length} product(s) — Medusa admin: ${getMedusaUrl()}/app`))
      } catch (err) {
        spinner.fail(chalk.red("Failed to fetch products"))
        console.error(chalk.gray(String(err)))
        process.exit(1)
      }
    })

  // ── ibx api products add ────────────────────────────────────────────────
  products
    .command("add")
    .description("Interactively create a new product in Medusa")
    .action(async () => {
      console.log(chalk.bold("\n  Add new product\n"))

      const title = await input({ message: "Product title (pt-BR):" })
      const description = await input({ message: "Description (pt-BR):" })

      const spinner = ora("Loading categories...").start()
      let categories: { name: string; id: string }[] = []
      try {
        const data = await medusaFetch("/admin/product-categories?limit=50")
        categories = (data.product_categories as { name: string; id: string }[] | undefined) ?? []
        spinner.stop()
      } catch {
        spinner.fail("Could not load categories")
        process.exit(1)
      }

      const categoryId = await select({
        message: "Category:",
        choices: categories.map((c) => ({ name: c.name, value: c.id })),
      })

      const tags = await checkbox({
        message: "Tags:",
        choices: [
          "popular",
          "chef_choice",
          "sem_gluten",
          "sem_lactose",
          "vegano",
          "vegetariano",
          "novo",
          "congelado",
        ].map((t) => ({ name: t, value: t })),
      })

      const productType = await select({
        message: "Product type:",
        choices: [
          { name: "food", value: "food" },
          { name: "frozen", value: "frozen" },
          { name: "merchandise", value: "merchandise" },
        ],
      })

      const variants: { title: string; price: number }[] = []
      let addMore = true
      while (addMore) {
        const variantTitle = await input({ message: `Variant title (e.g. "500g"):` })
        const priceStr = await input({ message: `Price in BRL (e.g. 89.00):` })
        const price = Math.round(parseFloat(priceStr) * 100)
        variants.push({ title: variantTitle, price })

        const another = await select({
          message: "Add another variant?",
          choices: [
            { name: "No", value: false },
            { name: "Yes", value: true },
          ],
        })
        addMore = another as boolean
      }

      const allergenChoices = await checkbox({
        message: "Allergens (explicit only):",
        choices: ["gluten", "lactose", "eggs", "nuts", "soy", "fish", "shellfish"].map(
          (a) => ({ name: a, value: a })
        ),
      })

      const spinner2 = ora("Creating product...").start()
      try {
        const hasMultipleVariants = variants.length > 1

        await medusaFetch("/admin/products", {
          method: "POST",
          body: JSON.stringify({
            title,
            handle: title.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, ""),
            description,
            status: "published",
            categories: [{ id: categoryId }],
            tags: tags.map((t: string) => ({ value: t })),
            options: hasMultipleVariants
              ? [{ title: "Variante", values: variants.map((v) => v.title) }]
              : [],
            variants: variants.map((v) => ({
              title: v.title,
              manage_inventory: false,
              ...(hasMultipleVariants ? { options: { Variante: v.title } } : {}),
            })),
            metadata: {
              productType,
              allergens: allergenChoices,
            },
          }),
        })

        spinner2.succeed(chalk.green(`Product "${title}" created`))
        console.log(
          chalk.gray(`  Prices must be set via the Medusa admin panel or the Pricing Module API.`)
        )
      } catch (err) {
        spinner2.fail(chalk.red("Failed to create product"))
        console.error(chalk.gray(String(err)))
        process.exit(1)
      }
    })
}
