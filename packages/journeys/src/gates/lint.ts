// gates/lint.ts — the roster gate behind `ibx journey lint` (T1a-2).
//
// Lints every journey file in the registry (`packages/journeys/journeys/`)
// at a higher altitude than the Zod schema:
//
//   1. every `expects[].intentKind` ∈ `KNOWN_INTENT_KINDS` — journeys may
//      expect system-kind envelopes, so the FULL union (the catalog registry
//      plus the external pix.* / loyalty.* kinds) is the domain, not just the
//      chat surface. Its size is pinned once, at `EXPECTED_CAPABILITY_COUNT`
//      beside `CAPABILITY_DEFINITIONS` (R6-S4) — deliberately not restated
//      here, where a number nothing gates on would rot;
//   2. chat-act expectations ⊆ planner-advertised ∪ registered for the
//      journey's persona context (DR-5) — the planners are probed live from
//      `@ibatexas/packs-composed`, the registered side is the
//      `CHAT_DRIVABLE_TOOL_KINDS` mirror (drift-pinned in apps/api);
//   3. staff-http expectations ⊆ `STAFF_ROUTE_KINDS`
//      (reservation.checkin / reservation.complete — staff-route-only by
//      design; the live chat planner pins staffId:null);
//   4. every `verify[].invariant` resolves in `KNOWN_INVARIANT_IDS`;
//   5. persona/act surfaces are real: channel ∈ {web}; http acts carry a
//      shallow-syntax route path (asRole + method are schema-enforced);
//   6. the schema-level rules from T1a-1 (handle-only, blocked_without_
//      reason, …) are re-checked at lint altitude: each file is re-parsed
//      through `parseJourneyYaml`, and schema failures surface as lint
//      problems instead of throws.
//
// CLI idiom (exactly `ibx kernel pack-bom`'s): `--json` emits the report,
// `--verify-file` compares the per-journey digest-lock against the
// committed baseline (`packages/journeys/governance/journey-lint-baseline
// .json`), nonzero exit on any problem/mismatch. The thin command lives in
// packages/cli; ALL logic lives here.

import { createHash } from "node:crypto"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"

import { KNOWN_INTENT_KINDS } from "@ibatexas/intent-kinds"
import {
  CHAT_DRIVABLE_TOOL_KINDS,
  IBATEXAS_COMPOSED_CAPABILITY_PLANNERS,
} from "@ibatexas/packs-composed"
import { Channel } from "@ibatexas/types"

import {
  DEFAULT_JOURNEYS_DIR,
  JourneyLoadError,
  parseJourneyYaml,
  type Journey,
  type JourneySchemaErrorCode,
  type JourneyStatus,
} from "../schema/index.js"
import { KNOWN_INVARIANT_IDS } from "./invariant-registry.js"

// ── Persona contexts (DR-5) ──────────────────────────────────────────────────

/**
 * The two persona contexts a journey can drive via chat. `staff` is NOT a
 * chat context — the live planner pins `staffId: null`, so staff kinds are
 * reachable only via staff-HTTP acts (check 3).
 */
export type JourneyPersonaContext = "authed-customer" | "guest"

/**
 * Mirror of the union ctx shape `deriveIbatexasPlannerContext` builds —
 * replicated from apps/api's `ROSTER_DRIFT_CONTEXTS` probe literal
 * (`register-ibatexas-tool-packs.ts`). apps/api is unreachable from
 * packages/* by design, so the tiny literal lives here too; if the planner
 * ctx shape ever changes, the apps/api context-aware drift leg and this
 * probe must move together.
 */
function plannerProbeState(over: {
  customerId: string | null
  staffId: string | null
  isAuthenticated: boolean
}): unknown {
  return {
    ctx: {
      tenantId: process.env.KERNEL_TENANT_ID ?? "ibatexas",
      channel: "web",
      cartId: null,
      orderId: null,
      ...over,
    },
  }
}

const PERSONA_PROBE_STATES: Record<JourneyPersonaContext, unknown> = {
  // The live chat planner's authenticated-customer shape (recalled customerId).
  "authed-customer": plannerProbeState({
    customerId: "lint-probe-customer",
    staffId: null,
    isAuthenticated: true,
  }),
  // Chat guests get customerId: null and are never authenticated.
  guest: plannerProbeState({
    customerId: null,
    staffId: null,
    isAuthenticated: false,
  }),
}

/**
 * Union of the composed pack planners' `allowedIntents` under the named
 * persona context. Probed live so de-/re-advertising a kind (e.g. the WS4
 * payment kinds) flows into lint without a mirror to maintain.
 */
export function advertisedChatKinds(
  context: JourneyPersonaContext,
): ReadonlySet<string> {
  const state = PERSONA_PROBE_STATES[context]
  const kinds = new Set<string>()
  for (const planner of IBATEXAS_COMPOSED_CAPABILITY_PLANNERS) {
    for (const kind of planner.plan(state, {}).allowedIntents) {
      kinds.add(kind)
    }
  }
  return kinds
}

/**
 * Derive the journey's persona context from the journey file itself:
 * a journey is `authed-customer` iff it declares `params.authenticated:
 * true` (the explicit authoring contract T1a-12 follows) OR any http act
 * runs `asRole: customer` (the act authenticates, so the chat session is
 * an authenticated one too). Everything else is a `guest`.
 */
export function journeyPersonaContext(journey: Journey): JourneyPersonaContext {
  if (journey.params?.["authenticated"] === true) return "authed-customer"
  if (journey.acts.some((a) => a.kind === "http" && a.asRole === "customer")) {
    return "authed-customer"
  }
  return "guest"
}

// ── Staff-route kinds (check 3) ──────────────────────────────────────────────

/**
 * The envelope kinds reachable ONLY via staff HTTP routes (admin routes
 * build their envelopes directly; the chat planner pins staffId:null, so
 * neither is ever proposable via chat). Mirrors the documented staff-chat
 * exception whitelisted in apps/api's roster drift gate.
 */
export const STAFF_ROUTE_KINDS: ReadonlySet<string> = new Set([
  "reservation.checkin",
  "reservation.complete",
])

// ── Lint problem vocabulary ──────────────────────────────────────────────────

export type JourneyLintCode =
  | JourneySchemaErrorCode // check 6 — schema rules re-surfaced at lint altitude
  | "yaml_parse_error"
  | "registry_unreadable"
  | "duplicate_journey_id"
  | "unknown_intent_kind" // check 1
  | "expectation_unreachable" // checks 2 + 3
  | "unknown_invariant" // check 4
  | "unsupported_channel" // check 5
  | "invalid_http_path" // check 5

export interface JourneyLintProblem {
  /** The offending file (relative to the registry dir) or the dir itself. */
  file: string
  /** The journey id, when the file parsed far enough to know it. */
  journeyId: string | null
  code: JourneyLintCode
  /** Dotted path inside the document (`expects.0.intentKind`), when known. */
  path: string | null
  message: string
}

export interface JourneyLintEntry {
  id: string
  file: string
  /** sha256 hex of the raw YAML text — the digest-lock unit. */
  digest: string
  status: JourneyStatus
  personaContext: JourneyPersonaContext
}

export interface JourneyLintReport {
  ok: boolean
  journeys: JourneyLintEntry[]
  problems: JourneyLintProblem[]
}

// ── Per-journey checks (1–5; 6 happens at parse time) ────────────────────────

/**
 * Shallow route-path syntax (check 5): absolute, single-slash-separated
 * segments of URL-safe characters — rejects whitespace, `//`, query
 * strings, and full URLs. Deliberately NOT a route-table lookup.
 */
const HTTP_PATH_PATTERN = /^\/$|^\/[A-Za-z0-9._~%:@-]+(?:\/[A-Za-z0-9._~%:@-]+)*$/

const EMPTY_SET: ReadonlySet<string> = new Set()

/** Run lint checks 1–5 over one schema-valid journey. Pure (probes planners). */
export function lintJourney(journey: Journey, file: string): JourneyLintProblem[] {
  const problems: JourneyLintProblem[] = []
  const problem = (
    code: JourneyLintCode,
    path: string | null,
    message: string,
  ): void => {
    problems.push({ file, journeyId: journey.id, code, path, message })
  }

  // 1. Intent-kind membership — the full 66-kind union is the domain.
  journey.expects.forEach((expect, i) => {
    if (!KNOWN_INTENT_KINDS.has(expect.intentKind)) {
      problem(
        "unknown_intent_kind",
        `expects.${i}.intentKind`,
        `"${expect.intentKind}" is not in KNOWN_INTENT_KINDS (@ibatexas/intent-kinds)`,
      )
    }
  })

  // 2 + 3. Expectation reachability per declared act surface.
  //
  // `expects[]` is journey-level (not per-act), so each expected kind must
  // be producible by AT LEAST ONE of the journey's public-surface acts:
  //   chat act        → advertised(persona ctx) ∪ registered (DR-5)
  //   staff http act  → STAFF_ROUTE_KINDS
  //   other http act  → open in v1 (public envelope routes aren't statically
  //                     enumerable yet; the Phase-1b reconciliation gate owns
  //                     the runtime truth for those)
  // fixture acts contribute NOTHING — preconditions may never produce
  // asserted envelopes (T1a-1 governance).
  const personaContext = journeyPersonaContext(journey)
  const hasChat = journey.acts.some((a) => a.kind === "chat")
  const hasStaffHttp = journey.acts.some(
    (a) => a.kind === "http" && a.asRole === "staff",
  )
  const hasPublicHttp = journey.acts.some(
    (a) => a.kind === "http" && a.asRole !== "staff",
  )
  const chatAllowed: ReadonlySet<string> = hasChat
    ? new Set([...advertisedChatKinds(personaContext), ...CHAT_DRIVABLE_TOOL_KINDS])
    : EMPTY_SET

  journey.expects.forEach((expect, i) => {
    const kind = expect.intentKind
    if (!KNOWN_INTENT_KINDS.has(kind)) return // already reported by check 1
    const reachable =
      (hasChat && chatAllowed.has(kind)) ||
      (hasStaffHttp && STAFF_ROUTE_KINDS.has(kind)) ||
      hasPublicHttp
    if (!reachable) {
      const surfaces = [
        hasChat ? `chat as ${personaContext}` : null,
        hasStaffHttp ? "staff-http" : null,
      ]
        .filter((s) => s !== null)
        .join(", ")
      problem(
        "expectation_unreachable",
        `expects.${i}.intentKind`,
        `"${kind}" is not producible by any declared act surface ` +
          `(${surfaces || "no public-surface acts"}) — chat allows ` +
          `planner-advertised ∪ registered for the persona context; ` +
          `staff-http allows only ${[...STAFF_ROUTE_KINDS].join("/")}`,
      )
    }
  })

  // 4. Invariant refs resolve.
  journey.verify.forEach((v, i) => {
    if (!KNOWN_INVARIANT_IDS.has(v.invariant)) {
      problem(
        "unknown_invariant",
        `verify.${i}.invariant`,
        `"${v.invariant}" does not resolve in the invariant registry ` +
          `(gates/invariant-registry.ts)`,
      )
    }
  })

  // 5. Persona/act surfaces real (shallow).
  if (journey.channel !== Channel.Web) {
    problem(
      "unsupported_channel",
      "channel",
      `journeys drive channel "web" only in Phase 1 (got "${journey.channel}")`,
    )
  }
  journey.acts.forEach((act, i) => {
    if (act.kind === "http" && !HTTP_PATH_PATTERN.test(act.path)) {
      problem(
        "invalid_http_path",
        `acts.${i}.path`,
        `"${act.path}" is not a plain absolute route path`,
      )
    }
  })

  return problems
}

// ── Registry-level lint ──────────────────────────────────────────────────────

export interface LintJourneysOptions {
  /** Registry dir override (default: `packages/journeys/journeys/`). */
  dir?: string
}

/**
 * Lint the whole Journey Registry. Never throws on journey content — every
 * failure (YAML, schema, checks 1–5, duplicate ids) lands in
 * `report.problems`. An empty registry is a clean (vacuous) pass.
 */
export async function lintJourneys(
  options?: LintJourneysOptions,
): Promise<JourneyLintReport> {
  const dir = options?.dir ?? DEFAULT_JOURNEYS_DIR
  const journeys: JourneyLintEntry[] = []
  const problems: JourneyLintProblem[] = []

  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch (err) {
    return {
      ok: false,
      journeys: [],
      problems: [
        {
          file: dir,
          journeyId: null,
          code: "registry_unreadable",
          path: null,
          message: `journeys dir unreadable: ${(err as Error).message}`,
        },
      ],
    }
  }

  const files = entries
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
    .sort((a, b) => a.localeCompare(b))
  const seen = new Map<string, string>() // journey id → filename

  for (const file of files) {
    const text = await readFile(join(dir, file), "utf8")
    const digest = createHash("sha256").update(text).digest("hex")

    let journey: Journey
    try {
      // Check 6 — re-parse through the schema; failures become problems.
      journey = parseJourneyYaml(text, file)
    } catch (err) {
      if (err instanceof JourneyLoadError && err.errors.length > 0) {
        for (const schemaError of err.errors) {
          problems.push({
            file,
            journeyId: null,
            code: schemaError.code,
            path: schemaError.path || null,
            message: schemaError.message,
          })
        }
      } else {
        problems.push({
          file,
          journeyId: null,
          code: "yaml_parse_error",
          path: null,
          message: (err as Error).message,
        })
      }
      continue
    }

    const dup = seen.get(journey.id)
    if (dup !== undefined) {
      problems.push({
        file,
        journeyId: journey.id,
        code: "duplicate_journey_id",
        path: "id",
        message: `${journey.id} already defined in ${dup}`,
      })
      continue
    }
    seen.set(journey.id, file)

    journeys.push({
      id: journey.id,
      file,
      digest,
      status: journey.status,
      personaContext: journeyPersonaContext(journey),
    })
    problems.push(...lintJourney(journey, file))
  }

  return { ok: problems.length === 0, journeys, problems }
}

// ── Digest-lock + baseline verification (pack-bom idiom) ─────────────────────

/**
 * The digest-lock map (`journeyId → sha256`) an operator captures into
 * `packages/journeys/governance/journey-lint-baseline.json`.
 */
export function lintDigestLock(report: JourneyLintReport): Record<string, string> {
  const lock: Record<string, string> = {}
  for (const entry of report.journeys) {
    lock[entry.id] = entry.digest
  }
  return lock
}

export interface LintBaselineMismatch {
  journeyId: string
  reason: "missing_in_baseline" | "digest_mismatch"
  expected?: string
  actual: string
}

/**
 * Compare the current registry against a committed baseline — exactly the
 * `kernel pack-bom --verify-file` semantics: every current journey must
 * have a baseline entry with the same digest. (Stale baseline entries for
 * deleted journeys are the coverage gate's covered→uncovered concern,
 * T1a-3 — not lint's.)
 */
export function verifyLintBaseline(
  report: JourneyLintReport,
  baseline: Record<string, string>,
): LintBaselineMismatch[] {
  const mismatches: LintBaselineMismatch[] = []
  for (const entry of report.journeys) {
    const want = baseline[entry.id]
    if (want === undefined) {
      mismatches.push({
        journeyId: entry.id,
        reason: "missing_in_baseline",
        actual: entry.digest,
      })
    } else if (want !== entry.digest) {
      mismatches.push({
        journeyId: entry.id,
        reason: "digest_mismatch",
        expected: want,
        actual: entry.digest,
      })
    }
  }
  return mismatches
}
