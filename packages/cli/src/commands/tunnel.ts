// ibx tunnel — expose local API via ngrok for WhatsApp webhook testing.
//
// Starts ngrok on port 3001, fetches the public URL from ngrok's local API,
// and prints setup instructions for Twilio.

import type { Command } from "commander"
import chalk from "chalk"
import { execa } from "execa"

const API_PORT = 3001
const NGROK_API = "http://127.0.0.1:4040/api/tunnels"
const WEBHOOK_PATH = "/api/webhooks/whatsapp"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function fetchNgrokUrl(retries = 10): Promise<string | null> {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(NGROK_API)
      const data = (await res.json()) as { tunnels: { public_url: string; proto: string }[] }
      const https = data.tunnels.find((t) => t.proto === "https")
      if (https) return https.public_url
    } catch {
      // ngrok not ready yet
    }
    await sleep(1000)
  }
  return null
}

export function registerTunnelCommands(program: Command) {
  program
    .command("tunnel")
    .description("Expose local API via ngrok for WhatsApp webhook testing")
    .option("-p, --port <port>", "API port to expose", String(API_PORT))
    .option("--domain <domain>", "ngrok domain (claim free at dashboard.ngrok.com/domains)")
    .action(async (opts: { port: string; domain?: string }) => {
      const port = parseInt(opts.port, 10)

      console.log(chalk.cyan(`\n  Starting ngrok tunnel on port ${port}...\n`))

      // Start ngrok in background, capturing stderr for error detection
      let ngrokExited = false
      let ngrokError = ""

      const ngrokArgs = ["http", String(port)]
      if (opts.domain) ngrokArgs.push("--url", opts.domain)

      const ngrok = execa("ngrok", ngrokArgs, {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
        detached: false,
      })

      // Collect stderr for diagnostics
      ngrok.stderr?.on("data", (chunk: Buffer) => {
        ngrokError += chunk.toString()
      })

      // Track early exit (auth errors, config issues)
      ngrok.on("exit", () => {
        ngrokExited = true
      })

      // Handle ngrok not found
      ngrok.catch((err) => {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          console.error(chalk.red("  ngrok not found. Install with: brew install ngrok"))
          process.exit(1)
        }
      })

      // Give ngrok a moment to fail fast on auth errors
      await sleep(2000)

      if (ngrokExited) {
        if (ngrokError.includes("ERR_NGROK_4018") || ngrokError.includes("authtoken")) {
          console.error(chalk.red("  ngrok requires an authtoken.\n"))
          console.error(chalk.yellow("  To fix:\n"))
          console.error(chalk.gray("  1. Sign up at https://dashboard.ngrok.com/signup"))
          console.error(chalk.gray("  2. Copy your authtoken from the dashboard"))
          console.error(chalk.cyan("  3. Run: ngrok config add-authtoken YOUR_TOKEN\n"))
        } else if (ngrokError.includes("ERR_NGROK_15013") || ngrokError.includes("dev domain")) {
          console.error(chalk.red("  ngrok requires a dev domain (free tier change).\n"))
          console.error(chalk.yellow("  To fix:\n"))
          console.error(chalk.gray("  1. Go to https://dashboard.ngrok.com/domains"))
          console.error(chalk.gray("  2. Claim your free static domain (e.g. something.ngrok-free.app)"))
          console.error(chalk.gray("  3. Run:"))
          console.error(chalk.cyan("     ibx tunnel --domain YOUR_DOMAIN.ngrok-free.app\n"))
        } else {
          console.error(chalk.red("  ngrok exited unexpectedly.\n"))
          if (ngrokError) console.error(chalk.gray(`  ${ngrokError.trim()}\n`))
        }
        process.exit(1)
      }

      // Fetch the public URL
      const publicUrl = await fetchNgrokUrl()

      if (!publicUrl) {
        console.error(chalk.red("  Could not fetch ngrok URL. Is ngrok running?"))
        ngrok.kill()
        process.exit(1)
      }

      const webhookUrl = `${publicUrl}${WEBHOOK_PATH}`

      console.log(chalk.green("  ✓ ngrok tunnel is up!\n"))
      console.log(chalk.white(`  Public URL:  ${chalk.bold(publicUrl)}`))
      console.log(chalk.white(`  Webhook:     ${chalk.bold(webhookUrl)}\n`))
      console.log(chalk.yellow("  Next steps:\n"))
      console.log(chalk.gray(`  1. Set in .env:`))
      console.log(chalk.cyan(`     TWILIO_WEBHOOK_URL=${webhookUrl}\n`))
      console.log(chalk.gray(`  2. Update Twilio Console → Messaging → WhatsApp Sandbox:`))
      console.log(chalk.gray(`     "When a message comes in" → ${chalk.cyan(webhookUrl)}\n`))
      console.log(chalk.gray(`  3. Start the API in another terminal:`))
      console.log(chalk.cyan(`     ibx dev api\n`))
      console.log(chalk.gray(`  Press Ctrl+C to stop the tunnel.\n`))

      // Keep the process alive until Ctrl+C
      process.on("SIGINT", () => {
        ngrok.kill()
        console.log(chalk.gray("\n  Tunnel stopped.\n"))
        process.exit(0)
      })

      // Wait for ngrok to exit
      try {
        await ngrok
      } catch {
        // Normal exit on kill
      }
    })
}
