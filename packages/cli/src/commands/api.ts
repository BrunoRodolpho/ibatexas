import type { Command } from "commander"
import { input, select, checkbox } from "@inquirer/prompts"
import chalk from "chalk"
import ora from "ora"
import { searchProducts, closeRedisClient, Channel } from "@ibatexas/tools"
import { v4 as uuidv4 } from 'uuid';

import { getMedusaUrl, medusaFetch } from "../lib/medusa.js"

// ── Types ─────────────────────────────────────────────────────────────────────

interface ApiMedusaProduct {
  id: string
  title: string
  status: string
  categories?: { name: string }[]
  variants?: unknown[]
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getApiUrl(): string {
  return process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001"
}

// ── Search helpers ───────────────────────────────────────────────────────────

interface SearchProduct {
  id: string
  title: string
  price: number
  tags?: string[]
  allergens?: string[]
  inStock?: boolean
}

function printFullSearchResults(
  query: string,
  products: SearchProduct[],
  searchModel: string,
  hitCache: boolean,
): void {
  const cacheLabel = hitCache ? chalk.green("✓ cache hit") : chalk.gray("cache miss")
  const modelLabel = searchModel === "hybrid" ? chalk.cyan("hybrid") : chalk.yellow("keyword-only")

  console.log(
    chalk.bold(`\n  "${query}" — ${products.length} result${products.length === 1 ? "" : "s"} `) +
    `[${modelLabel}] [${cacheLabel}]\n`
  )

  if (products.length) {
    console.log(
      `  ${"ID".padEnd(26)} ${"Title".padEnd(38)} ${"R$".padEnd(10)} ${"Tags".padEnd(25)} Allergens`
    )
    console.log(`  ${"─".repeat(115)}`)

    for (const p of products) {
      const priceInReais = (p.price / 100).toFixed(2)
      const tags = (p.tags ?? []).join(", ") || "—"
      const allergens = (p.allergens ?? []).join(", ") || "nenhum"
      const stock = p.inStock === false ? chalk.red(" [fora de estoque]") : ""
      console.log(
        `  ${chalk.gray(p.id.substring(0, 26).padEnd(26))} ${p.title.padEnd(38)} ${priceInReais.padEnd(10)} ${tags.substring(0, 25).padEnd(25)} ${allergens}${stock}`
      )
    }
  } else {
    console.log(chalk.yellow("  No products found."))
    console.log(chalk.gray("  Tip: ibx db seed — then wait ~2s for indexing"))
  }

  const cacheNote = hitCache
    ? chalk.green("  ✓ Served from cache (zero embedding cost)")
    : chalk.gray("  ↗ Fresh from Typesense (results now cached)")
  console.log(`\n${cacheNote}\n`)
}

function printDirectSearchResults(
  query: string,
  results: Array<{ document: { id: string; title: string; price: number; tags?: string[] } }>,
  typesenseUrl: string,
): void {
  if (!results.length) {
    console.log(chalk.yellow(`\n  No results found for: "${query}"`))
    console.log(chalk.gray("  Tip: Make sure products are created and indexed."))
    console.log(chalk.gray("  For full pipeline debug: ibx api search \"${query}\" --full"))
    return
  }

  console.log(chalk.bold(`\n  Search results for: "${query}" (${results.length} hit${results.length === 1 ? "" : "s"}) [Typesense direct]\n`))
  console.log(
    `  ${"ID".padEnd(30)} ${"Title".padEnd(40)} ${"Price (R$)".padEnd(12)} Tags`
  )
  console.log(`  ${"─".repeat(100)}`)

  for (const hit of results) {
    const doc = hit.document
    const priceInReais = (doc.price / 100).toFixed(2)
    const tags = (doc.tags || []).join(", ")
    console.log(
      `  ${chalk.gray(doc.id.substring(0, 30).padEnd(30))} ${doc.title.padEnd(40)} ${priceInReais.padEnd(12)} ${tags}`
    )
  }

  console.log(chalk.gray(`\n  For full pipeline (embedding + cache): ibx api search "${query}" --full`))
  console.log(chalk.gray(`  Typesense: ${typesenseUrl}\n`))
}

// ── Chat helpers ─────────────────────────────────────────────────────────────

interface SseEvent {
  type: string
  delta?: string
  message?: string
  toolName?: string
}

async function postChatMessage(
  apiUrl: string,
  sessionId: string,
  message: string,
  channel: string,
): Promise<string> {
  const res = await fetch(`${apiUrl}/api/chat/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, message, channel }),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`API ${res.status}: ${text}`)
  }
  const data = (await res.json()) as { messageId: string }
  return data.messageId
}

/** Process a single SSE event; returns 'done' or 'error' to signal stream end, 'continue' otherwise. */
function handleSseEvent(event: SseEvent, sessionId: string): "continue" | "done" | "error" {
  if (event.type === "text_delta" && event.delta) {
    process.stdout.write(event.delta)
    return "continue"
  }
  if (event.type === "tool_start") {
    process.stdout.write(chalk.gray(`\n  [tool: ${event.toolName}]\n  `))
    return "continue"
  }
  if (event.type === "done") {
    process.stdout.write("\n")
    console.log(chalk.green("\n  Done.\n"))
    console.log(chalk.gray(`  Reuse session: ibx api chat "..." --session ${sessionId}\n`))
    return "done"
  }
  if (event.type === "error") {
    process.stdout.write("\n")
    console.log(chalk.red(`\n  Agent error: ${event.message}\n`))
    return "error"
  }
  return "continue"
}

/** Parse a single SSE line into an event, or null if not a valid data line. */
function parseSseLine(line: string): SseEvent | null {
  if (!line.startsWith("data: ")) return null
  const payload = line.slice(6).trim()
  if (!payload) return null
  try {
    return JSON.parse(payload) as SseEvent
  } catch {
    return null
  }
}

async function streamChatResponse(apiUrl: string, sessionId: string): Promise<void> {
  const sseRes = await fetch(`${apiUrl}/api/chat/stream/${sessionId}`)
  if (!sseRes.ok || !sseRes.body) {
    throw new Error(`SSE error ${sseRes.status}`)
  }

  const decoder = new TextDecoder()
  let buf = ""

  for await (const rawChunk of sseRes.body as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(rawChunk, { stream: true })
    const lines = buf.split("\n")
    buf = lines.pop() ?? ""

    for (const line of lines) {
      const event = parseSseLine(line)
      if (!event) continue
      const result = handleSseEvent(event, sessionId)
      if (result === "done") return
      if (result === "error") process.exit(1)
    }
  }
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
        const data = await medusaFetch<Record<string, unknown>>(
          `/admin/products?limit=${opts.limit}&fields=id,title,status,categories,variants`
        )
        spinner.stop()

        const items = (data.products as ApiMedusaProduct[] | undefined) ?? []
        if (!items.length) {
          console.log(chalk.gray("No products found."))
          return
        }

        console.log(
          chalk.bold(
            `\n  ${"ID".padEnd(30)} ${"Title".padEnd(35)} ${"Status".padEnd(12)} ${"Category".padEnd(22)} Variants`
          )
        )
        console.log(`  ${"─".repeat(110)}`)

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
        const data = await medusaFetch<Record<string, unknown>>("/admin/product-categories?limit=50")
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
        const price = Math.round(Number.parseFloat(priceStr) * 100)
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
          body: {
            title,
            handle: title.toLowerCase().replaceAll(/\s+/g, "-").replaceAll(/[^a-z0-9-]/g, ""),
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
          },
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

  // ── ibx api search <query> ──────────────────────────────────────────────
  // Two modes:
  //   (default)  Direct Typesense HTTP — fast, no embedding, no cache
  //   --full     Full search_products pipeline: L0 cache → embedding → L1 cache → Typesense → filters
  api
    .command("search")
    .description("Test product search. Use --full to run the complete search_products pipeline.")
    .argument("<query>", "Search query (pt-BR)")
    .option("-l, --limit <n>", "Number of results", "5")
    .option("--full", "Run the full search_products pipeline (embedding + cache + filters)")
    .option("--available-now", "Filter to products available at current time")
    .option("--exclude-allergens <list>", "Comma-separated allergens to exclude (e.g. gluten,lactose)")
    .option("--tags <list>", "Comma-separated tags to filter by (e.g. popular,carne)")
    .action(async (
      query: string,
      opts: {
        limit: string
        full?: boolean
        availableNow?: boolean
        excludeAllergens?: string
        tags?: string
      }
    ) => {
      if (opts.full) {
        // ── Full pipeline via searchProducts() tool ────────────────────────
        const spinner = ora("Running full search pipeline (embedding + cache + Typesense)...").start()
        try {
          const excludeAllergens = opts.excludeAllergens
            ? opts.excludeAllergens.split(",").map((a) => a.trim())
            : undefined
          const tags = opts.tags
            ? opts.tags.split(",").map((t) => t.trim())
            : undefined

          const result = await searchProducts(
            {
              query,
              limit: Number.parseInt(opts.limit, 10),
              availableNow: opts.availableNow,
              excludeAllergens,
              tags,
            },
            { sessionId: "ibx-cli", channel: Channel.Web }
          )
          spinner.stop()

          printFullSearchResults(query, result.products, result.searchModel, result.hitCache)
        } catch (err) {
          spinner.fail(chalk.red("Full search pipeline failed"))
          console.error(chalk.gray(String(err)))
          process.exit(1)
        } finally {
          // Close Redis connection so the CLI process exits cleanly
          await closeRedisClient()
        }
        return
      }

      // ── Fast mode: direct Typesense HTTP (no embedding, no cache) ─────────
      const spinner = ora("Searching Typesense directly...").start()
      try {
        const typesenseHost = process.env.TYPESENSE_HOST || "localhost"
        const typesensePort = process.env.TYPESENSE_PORT || "8108"
        const typesenseUrl = `http://${typesenseHost}:${typesensePort}`
        const typesenseKey = process.env.TYPESENSE_API_KEY

        if (!typesenseKey) {
          spinner.fail(chalk.red("TYPESENSE_API_KEY not set"))
          process.exit(1)
        }

        const response = await fetch(
          `${typesenseUrl}/collections/products/documents/search?q=${encodeURIComponent(query)}&query_by=title,description,tags&limit=${opts.limit}&per_page=${opts.limit}`,
          {
            headers: { "X-TYPESENSE-API-KEY": typesenseKey },
          }
        )

        if (!response.ok) {
          throw new Error(`Typesense error ${response.status}`)
        }

        const data = (await response.json()) as any
        spinner.stop()

        const results = data.hits || []
        printDirectSearchResults(query, results, typesenseUrl)
      } catch (err) {
        spinner.fail(chalk.red("Search failed"))
        console.error(chalk.gray(String(err)))
        process.exit(1)
      }
    })

  // ── ibx api chat <message> ───────────────────────────────────────────────
  api
    .command("chat")
    .description("Send a message to the agent and stream the response (SSE). API must be running.")
    .argument("<message>", "User message (pt-BR)")
    .option("--session <uuid>", "Reuse an existing session UUID. Omit to start a new session.")
    .option("--channel <channel>", "Channel to send as: web | whatsapp | instagram", "web")
    .action(async (message: string, opts: { session?: string; channel: string }) => {
      const apiUrl = getApiUrl()
      const sessionId = opts.session ?? uuidv4()

      console.log(chalk.bold(`\n  ibx api chat\n`))
      console.log(chalk.gray(`  api     : ${apiUrl}`))
      console.log(chalk.gray(`  session : ${sessionId}`))
      console.log(chalk.gray(`  channel : ${opts.channel}`))
      console.log(chalk.gray(`  message : ${message}\n`))

      const spinner = ora("Sending message to agent...").start()
      try {
        const messageId = await postChatMessage(apiUrl, sessionId, message, opts.channel)
        spinner.succeed(chalk.green(`Message queued — messageId: ${messageId}`))
      } catch (err) {
        spinner.fail(chalk.red("Failed to send message"))
        console.error(chalk.gray(String(err)))
        process.exit(1)
      }

      console.log(chalk.bold("\n  Agent:\n"))
      process.stdout.write("  ")

      try {
        await streamChatResponse(apiUrl, sessionId)
      } catch (err) {
        process.stdout.write("\n")
        console.error(chalk.red("  Failed to stream response"))
        console.error(chalk.gray(String(err)))
        process.exit(1)
      }
    })
}
