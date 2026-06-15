#!/usr/bin/env node
// scripts/test-stack/nats-auth-probe.mjs — T3-10 live NATS server-side auth
// probe for the journey-test stack.
//
// Run AGAINST A RUNNING TEST STACK (after ./scripts/test-stack-up.sh):
//
//   node scripts/test-stack/nats-auth-probe.mjs
//
// Reads .env.test (repo root) for NATS_URL and the three per-role seeds and
// asserts that THE SERVER (infra/nats/nats-server.test-plane.conf — not any
// client-side wrapper) enforces the test-plane containment:
//
//   [1] unauthenticated connect            → REFUSED (authorization violation)
//   [2] CAPTURE creds: subscribe ibatexas.> → ALLOWED (receives [3]'s publish)
//   [3] TRIGGER creds: publish ibatexas.>   → ALLOWED (observed by [2])
//   [4] CAPTURE creds: publish              → REJECTED BY THE SERVER
//                                             (Permissions Violation status)
//   [5] TRIGGER creds: subscribe            → REJECTED BY THE SERVER
//   [6] APP creds:     publish + subscribe  → ALLOWED (round trip)
//
// The probe subject lives under `ibatexas.` (the only namespace the trigger
// user may publish to) but matches no SUT subscriber subject — nothing in the
// stack consumes `ibatexas.t3x10.*`.
//
// Exit 0 = every assertion holds. Seed material is never printed.

import { readFileSync } from "node:fs"
import { createRequire } from "node:module"

const require = createRequire(
  new URL("../../packages/nats-client/package.json", import.meta.url),
)
const { connect, nkeyAuthenticator } = require("nats")

// ── env ─────────────────────────────────────────────────────────────────────
const envPath = new URL("../../.env.test", import.meta.url)
const env = {}
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const t = line.trim()
  if (t === "" || t.startsWith("#")) continue
  const eq = t.indexOf("=")
  if (eq <= 0) continue
  env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim()
}

const NATS_URL = env.NATS_URL
const APP_SEED = env.NATS_NKEY_SEED
const CAPTURE_SEED = env.IBX_TEST_NATS_CAPTURE_NKEY_SEED
const TRIGGER_SEED = env.IBX_TEST_NATS_TRIGGER_NKEY_SEED
for (const [name, v] of Object.entries({
  NATS_URL,
  NATS_NKEY_SEED: APP_SEED,
  IBX_TEST_NATS_CAPTURE_NKEY_SEED: CAPTURE_SEED,
  IBX_TEST_NATS_TRIGGER_NKEY_SEED: TRIGGER_SEED,
})) {
  if (!v) fail(`missing ${name} in .env.test — regenerate with ./scripts/gen-env-test.sh --force`)
}

// ── helpers ─────────────────────────────────────────────────────────────────
let failures = 0
function ok(label) {
  console.log(`  ✓ ${label}`)
}
function bad(label) {
  failures += 1
  console.error(`  ✗ ${label}`)
}
function fail(message) {
  console.error(`error: ${message}`)
  process.exit(1)
}

function connectAs(seed) {
  return connect({
    servers: [NATS_URL],
    authenticator: nkeyAuthenticator(new TextEncoder().encode(seed)),
    reconnect: false,
    timeout: 5000,
  })
}

/** Resolve with the first status event whose type is "error" (or time out). */
function nextErrorStatus(conn, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms)
    ;(async () => {
      for await (const status of conn.status()) {
        if (status.type === "error") {
          clearTimeout(timer)
          resolve(status)
          return
        }
      }
    })().catch(() => {
      clearTimeout(timer)
      resolve(null)
    })
  })
}

const enc = new TextEncoder()
const dec = new TextDecoder()
const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

console.log(`nats-auth-probe: ${NATS_URL}`)

// ── [1] unauthenticated connect refused ─────────────────────────────────────
// Dial-artifact note: with a `localhost` URL, nats.js may try ::1 first (the
// compose port maps 127.0.0.1 only) and report the TCP refusal of the LAST
// attempted address instead of the auth refusal — so on CONNECTION_REFUSED we
// retry against the explicit IPv4 loopback to get the server's actual answer.
{
  const attempt = async (url) => {
    try {
      const conn = await connect({ servers: [url], reconnect: false, timeout: 5000 })
      await conn.close()
      return { accepted: true }
    } catch (err) {
      return { accepted: false, err }
    }
  }
  let { accepted, err } = await attempt(NATS_URL)
  if (!accepted && err?.code === "CONNECTION_REFUSED" && NATS_URL.includes("localhost")) {
    ;({ accepted, err } = await attempt(NATS_URL.replace("localhost", "127.0.0.1")))
  }
  if (accepted) {
    bad("[1] unauthenticated connect was ACCEPTED — server-side auth is OFF")
  } else if (String(err?.message ?? err).toLowerCase().includes("authorization")) {
    ok(`[1] unauthenticated connect refused by the server (${err.code ?? err.message})`)
  } else {
    bad(`[1] unauthenticated connect failed for the WRONG reason: ${err?.message}`)
  }
}

// ── [2]+[3] capture subscribes; trigger publishes; capture receives ─────────
const captureConn = await connectAs(CAPTURE_SEED)
const triggerConn = await connectAs(TRIGGER_SEED)
{
  const subject = `ibatexas.t3x10.probe.${RUN_ID}`
  const sub = captureConn.subscribe("ibatexas.t3x10.>")
  await captureConn.flush()
  const received = new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 5000)
    ;(async () => {
      for await (const msg of sub) {
        clearTimeout(timer)
        resolve(msg)
        return
      }
    })().catch(() => {
      clearTimeout(timer)
      resolve(null)
    })
  })
  triggerConn.publish(subject, enc.encode(JSON.stringify({ probe: RUN_ID })))
  await triggerConn.flush()
  const msg = await received
  sub.unsubscribe()
  if (msg && msg.subject === subject && JSON.parse(dec.decode(msg.data)).probe === RUN_ID) {
    ok("[2] capture creds subscribe ALLOWED (received the trigger publish)")
    ok(`[3] trigger creds publish on ibatexas.> ALLOWED (${subject})`)
  } else {
    bad("[2/3] capture subscription did not receive the trigger publish within 5s")
  }
}

// ── [4] capture publish rejected BY THE SERVER ──────────────────────────────
{
  const errorStatus = nextErrorStatus(captureConn, 5000)
  captureConn.publish(`ibatexas.t3x10.forged.${RUN_ID}`, enc.encode("{}"))
  try {
    await captureConn.flush()
  } catch {
    // flush may reject if the server error races the PONG — fine either way
  }
  const status = await errorStatus
  const data = String(status?.data ?? "")
  const operation = status?.permissionContext?.operation
  if (status && data.includes("PERMISSIONS_VIOLATION") && operation === "publish") {
    ok(
      `[4] capture creds publish REJECTED BY THE SERVER (status error: ${data}, ` +
        `operation: ${operation}, subject: ${status.permissionContext.subject})`,
    )
  } else if (status && data.includes("PERMISSIONS_VIOLATION")) {
    ok(`[4] capture creds publish REJECTED BY THE SERVER (status error: ${data})`)
  } else {
    bad("[4] no server-side Permissions Violation observed for the capture publish within 5s")
  }
}

// ── [5] trigger subscribe rejected BY THE SERVER ────────────────────────────
{
  const sub = triggerConn.subscribe(`ibatexas.t3x10.observe.${RUN_ID}`)
  const outcome = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve("timeout"), 5000)
    ;(async () => {
      for await (const _ of sub) {
        // no message expected
      }
      clearTimeout(timer)
      resolve("closed-clean")
    })().catch((err) => {
      clearTimeout(timer)
      resolve(err)
    })
  })
  if (
    outcome instanceof Error &&
    (outcome.code === "PERMISSIONS_VIOLATION" ||
      String(outcome.message).toLowerCase().includes("permissions violation"))
  ) {
    ok(`[5] trigger creds subscribe REJECTED BY THE SERVER (${outcome.code ?? outcome.message})`)
  } else {
    bad(`[5] trigger subscribe was not rejected (outcome: ${String(outcome)})`)
  }
}

// ── [6] app creds full round trip ───────────────────────────────────────────
{
  const appConn = await connectAs(APP_SEED)
  const subject = `ibatexas.t3x10.app.${RUN_ID}`
  const sub = appConn.subscribe(subject)
  await appConn.flush()
  const received = new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 5000)
    ;(async () => {
      for await (const msg of sub) {
        clearTimeout(timer)
        resolve(msg)
        return
      }
    })().catch(() => {
      clearTimeout(timer)
      resolve(null)
    })
  })
  appConn.publish(subject, enc.encode(JSON.stringify({ probe: RUN_ID })))
  const msg = await received
  if (msg && JSON.parse(dec.decode(msg.data)).probe === RUN_ID) {
    ok("[6] app creds publish + subscribe round trip ALLOWED")
  } else {
    bad("[6] app creds round trip failed")
  }
  await appConn.close()
}

await captureConn.close().catch(() => {})
await triggerConn.close().catch(() => {})

if (failures > 0) {
  console.error(`nats-auth-probe: ${failures} assertion(s) FAILED`)
  process.exit(1)
}
console.log("nats-auth-probe: all server-side auth assertions hold")
