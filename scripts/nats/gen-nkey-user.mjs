#!/usr/bin/env node
// scripts/nats/gen-nkey-user.mjs — mint one NATS user nkey pair (T3-10).
//
// Prints "SEED PUBLIC" on a single line to stdout:
//   • SEED  ("SU...") — the CLIENT credential (NATS_NKEY_SEED /
//     IBX_TEST_NATS_*_NKEY_SEED). Secret — callers capture it into env files,
//     never into logs or terminals.
//   • PUBLIC ("U...") — the server-side authorization identity, interpolated
//     into infra/nats/nats-server.*.conf via NATS_*_NKEY_PUBLIC env vars.
//
// Callers: scripts/gen-env-test.sh (three test-plane pairs) and
// scripts/nats/gen-dev-nats-auth.sh (the dev/prod app pair).
//
// Resolution note: `nats` (which re-exports nkeys.js) is a dependency of
// @ibatexas/nats-client, not of the repo root — resolve through that package
// so this script runs from any cwd with plain `node`.

import { createRequire } from "node:module"

const require = createRequire(
  new URL("../../packages/nats-client/package.json", import.meta.url),
)
const { nkeys } = require("nats")

const pair = nkeys.createUser()
const seed = new TextDecoder().decode(pair.getSeed())
process.stdout.write(`${seed} ${pair.getPublicKey()}\n`)
