// AuditRedactor — Task 18 (M4 Audit & observability).
//
// Sits between `buildAuditRecord(...)` and `sink.emit(...)` in
// `intent-audit-wiring.ts`. Walks `record.envelope.payload` recursively and
// scrubs PII before any sink (NATS / console / future Postgres) sees it.
//
// Why this lives here and not in `@adjudicate/*`:
//   Per CLAUDE.md rule #9 the `@adjudicate/*` packages are domain-independent
//   primitives. Per-intent-kind redaction schema is IbateXas (and LGPD)
//   business — that lives in the adopter, not the framework.
//
// Threat model (investigation 08 §"P0 #1"):
//   - `AuditRecord.envelope.payload` carries the LLM's literal tool input.
//   - `set_pix_details` payload contains plaintext name + email + CPF.
//   - The default sink stack publishes to NATS subject
//     `ibatexas.audit.intent.decision.v1`. Any subscriber with permission
//     reads CPF in cleartext.
//   - This module nukes the leak BEFORE fan-out.
//
// ── P0-15: auditHash recomputation (Option A) ─────────────────────────────
//
// Pre-W2 the redactor preserved `auditHash` verbatim while mutating
// `envelope.payload`. `verifyAuditRecord` reading a durable redacted record
// re-derived `sha256Canonical(record \ {auditHash, signature})` against
// the redacted envelope and reported `tampered` for EVERY redacted record.
// Tamper-detection at the audit-record level was structurally inert
// downstream of `getAuditSink()`.
//
// The W2 fix recomputes `auditHash` over the redacted record. The trade-off
// (documented in docs/adjudicate-migration/audit/REDACTION-HASH-DECISION.md):
//
//   - LOSS: the original-content tamper guarantee at the audit-record level.
//     A downstream reader cannot prove the unredacted payload was unmodified;
//     they can only prove the REDACTED payload was unmodified.
//   - GAIN: `verifyAuditRecord` actually works on redacted records (the
//     only kind any downstream sink sees, by invariant #1 of this module).
//   - REPLAY: must redact with the same config to reproduce the same hash.
//     The redaction salt (`AUDIT_REDACT_SECRET`) becomes part of the replay
//     contract — operators MUST snapshot it alongside the audit records.
//
// Invariants (do not break under any pull-request):
//   1. Idempotent — `redact(redact(record))` deep-equals `redact(record)`.
//   2. Hash-stable post-redaction — `redact(record).auditHash` equals
//      `sha256Canonical(redact(record) \ {auditHash, signature})`. The
//      stored hash matches what `verifyAuditRecord` will derive.
//   3. `intentHash` is NEVER recomputed — replay reconstructs the envelope
//      from the redacted record's nonce + actor + taint + createdAt, and
//      since `intentHash` is computed over the ORIGINAL payload at build-
//      time, the redacted record's intentHash is still byte-identical to
//      the originating envelope's. Ledger dedup remains correct.
//   4. Shape-preserving — `decision`, `decision_basis`, `at`, `durationMs`,
//      `version`, `plan`, `supersedes`, `kernelIdentity`, `kernelVersion`,
//      `policyVersion`, `signature`, and the envelope's `actor` / `taint` /
//      `kind` / `nonce` / `createdAt` / `version` / `intentHash` fields are
//      untouched (only `envelope.payload` and `auditHash` change).
//   5. Fail-open — if a redaction step throws (e.g. cycle in payload), we
//      replace the entire payload with `{ __redactor_error: true }` and
//      log. NEVER block a decision because of a redactor bug. The stub
//      payload's hash is also recomputed for invariant #2.
//
// See `docs/adjudicate-migration/tasks/18-audit-redactor.md` and
// `docs/adjudicate-migration/investigation/08-security-trust-boundaries.md`
// §"P0 #1" for the full rationale.

import { createHash } from "node:crypto"
import { sha256Canonical, type AuditRecord } from "@adjudicate/core"

// ── Field-name rules ──────────────────────────────────────────────────────────
//
// All matches are case-insensitive. The redactor lowercases the field name
// before consulting these sets.
//
// REDACT_FIELDS  → replace value with `"[REDACTED]"`. Use for raw PII whose
//                  value carries no audit-correlation value (CPF, email,
//                  phone, payment-method primitives).
// HASH_FIELDS    → replace value with `"hashed:" + sha256(value+salt)[0..8]`.
//                  Use when the audit team needs to correlate records
//                  ("same customer across two intents") without seeing the
//                  underlying string. `name` and `address` are the canonical
//                  examples per task spec.

/**
 * Canonical PII field names. Case-insensitive match on the lowercased key.
 *
 * Sourced from:
 *   - `apps/api/src/utils/sanitize-analytics.ts` (existing PostHog mask).
 *   - Brazilian government identifier lexicon (CPF, CNPJ, RG).
 *   - Card-payment primitives (PCI-DSS).
 *   - WhatsApp/cellphone aliases (existing IbateXas codebase).
 */
const REDACT_FIELDS: ReadonlySet<string> = new Set([
  // Brazilian identifiers
  "cpf",
  "cnpj",
  "rg",
  // Contact
  "email",
  "phone",
  "cellphone",
  "celular",
  "telefone",
  "whatsapp",
  // Payment-card primitives (PCI)
  "cardnumber",
  "card_number",
  "cvv",
  "cvc",
  "pan",
  "securitycode",
  "security_code",
  // PIX details (set_pix_details aliases)
  "taxid",
  "tax_id",
  // Tokenized phone-shaped session ids (defense-in-depth — actor.sessionId is
  // exempt because actor lives outside payload, but if the LLM ever inserts a
  // sessionId-like field INSIDE payload it gets scrubbed)
  "msisdn",
])

/**
 * Field names that preserve correlation via salted SHA-256.
 *
 * Replacing `name`/`address` with `[REDACTED]` would erase the audit team's
 * ability to ask "did this customer hit two different intents?". A short
 * deterministic hash answers that question without leaking the underlying
 * string.
 *
 * Salt comes from `AUDIT_REDACT_SECRET` — operator-controlled so a leaked
 * audit log cannot be rainbow-tabled back to plaintext.
 */
const HASH_FIELDS: ReadonlySet<string> = new Set([
  "name",
  "customername",
  "customer_name",
  "fullname",
  "full_name",
  "nome",
  "address",
  "addressline1",
  "address_line1",
  "addressline2",
  "address_line2",
  "endereco",
  "logradouro",
  // CustomerId / orderId-shaped opaque correlation tokens. The kernel's
  // own intentHash is already PII-free; payload-level customerId references
  // need hashing because the LLM's `set_pix_details` input includes them
  // verbatim from the conversational context.
  "customerid",
  "customer_id",
])

// ── Sentinel constants ────────────────────────────────────────────────────────
//
// Idempotency relies on the redactor recognising its own output. The
// sentinel format `[REDACTED:*]` plus the `hashed:xxxxxxxx` prefix gives
// us a stable detection surface — see `isAlreadyRedacted`.

const SENTINEL_FIELD = "[REDACTED]"
const SENTINEL_CPF = "[REDACTED:CPF]"
const SENTINEL_EMAIL = "[REDACTED:EMAIL]"
const SENTINEL_PHONE = "[REDACTED:PHONE]"
const SENTINEL_CARD = "[REDACTED:CARD]"
const SENTINEL_LONG = "[REDACTED:TRUNCATED]"
const HASH_PREFIX = "hashed:"

// String length cap. Two purposes:
//   - Defense against a runaway LLM payload that embeds a megabyte of taint.
//   - Defense against a free-form `reason` / `note` field with a customer
//     name buried mid-sentence — we truncate to a sensible audit summary
//     length and keep the prefix.
const MAX_STRING_LENGTH = 500

// Detect strings that are already redactor output. Anchored to avoid matching
// substrings of free-form text — only an exact match counts as "already
// redacted". A regex-match line that produced "[REDACTED:CPF] is my doc"
// would re-trigger on a second pass because the line is no longer a pure
// sentinel — that's fine, it stays at "[REDACTED:CPF] is my doc" idempotent
// because the regex output is the same sentinel.
function isSentinelString(s: string): boolean {
  return (
    s === SENTINEL_FIELD ||
    s === SENTINEL_CPF ||
    s === SENTINEL_EMAIL ||
    s === SENTINEL_PHONE ||
    s === SENTINEL_CARD ||
    s === SENTINEL_LONG ||
    s.startsWith(HASH_PREFIX)
  )
}

// ── Regex rules ───────────────────────────────────────────────────────────────
//
// Last-line-of-defense: even if a field name escapes the REDACT/HASH sets,
// values that *look* like PII get masked.
//
// Patterns deliberately tighter than `sanitize-analytics.ts`:
//   - CPF anchored to the canonical 11-digit shape (with or without separators).
//   - Phone restricted to the Brazilian (+55) form to avoid false positives
//     on innocuous numeric strings (e.g. order ids, prices).
//   - Email is the same loose RFC-ish shape used by PostHog sanitizer.
//   - Card: the strict 13-19 digit visa/mc/amex prefix family.
//
// Each pattern uses the `g` flag so multiple occurrences in one string get
// replaced; the `replace` callback is idempotent because the sentinel itself
// does NOT match any of these patterns.

const CPF_RE = /(?<![\d.-])(\d{3}\.?\d{3}\.?\d{3}-?\d{2})(?![\d.-])/g
const EMAIL_RE = /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g
// Brazilian phone shapes:
//   - +55 11 99999-9999 (international)
//   - 55 11 99999-9999  (no +)
//   - (11) 99999-9999   (national display)
//   - 11999999999       (11-digit mobile)
//   - 1199999999        (10-digit landline)
//   - 5511999999999     (DDI-prefixed 13-digit)
const PHONE_RE =
  /(?<!\d)(?:\+?55)?\s?\(?\d{2}\)?\s?9?\d{4}[-\s]?\d{4}(?!\d)/g
// Stripe/Visa/MC card-like 13-19 digit run. We deliberately accept embedded
// separators (spaces, dashes) so "4111-1111-1111-1111" gets caught.
const CARD_RE = /(?<!\d)(?:\d[\s-]?){13,19}(?!\d)/g

// ── Public types ──────────────────────────────────────────────────────────────

export interface AuditRedactor {
  /**
   * Return a deep-cloned copy of `record` with `record.envelope.payload`
   * scrubbed. `intentHash` and `auditHash` are preserved verbatim.
   */
  redact(record: AuditRecord): AuditRecord
  /**
   * Test-friendly entrypoint for the inner payload walker. Exposed so tests
   * can exercise the rule engine without building a full `AuditRecord`.
   */
  redactPayload(payload: unknown): unknown
}

export interface AuditRedactorOptions {
  /**
   * Salt for `hashed:*` outputs. In production this MUST be set via
   * `AUDIT_REDACT_SECRET` to prevent rainbow-table attacks. Empty string is
   * legal in dev but the redactor's caller should `console.warn` on boot.
   */
  readonly hashSecret?: string
  /**
   * Optional override of the REDACT field set (case-insensitive). Future
   * Packs that introduce new PII-bearing intents can extend this via the
   * `intent-audit-wiring` composition point.
   */
  readonly extraRedactFields?: ReadonlySet<string>
  /**
   * Optional override of the HASH field set (case-insensitive).
   */
  readonly extraHashFields?: ReadonlySet<string>
  /**
   * Per-intent-kind hook. Returns a list of field paths (dot-joined or
   * bracket-notation) to redact regardless of name match. Used by Packs
   * that ship semi-structured payloads (e.g. `whatsapp.message.send.body`).
   *
   * Today implemented inline via {@link INTENT_KIND_FIELD_RULES}; the option
   * is exposed for future per-deployment overrides without code changes.
   */
  readonly fieldRulesForKind?: (kind: string) => ReadonlyArray<string>
  /**
   * Optional warn sink for boot-time configuration warnings. Defaults to
   * `console.warn`. Tests inject a vi.fn to assert the warning fires when
   * `hashSecret` is empty.
   */
  readonly warn?: (msg: string) => void
}

// ── Per-intent-kind field rules ───────────────────────────────────────────────
//
// Some intents stash PII in fields whose NAMES don't trigger the global
// REDACT/HASH sets. Three examples from the IbateXas surface:
//
//   1. `whatsapp.handoff.request.reason` — free-form text that often quotes
//      a customer's last message (which may contain CPF/email).
//   2. `whatsapp.message.send.body` — the actual outbound message body. The
//      template name is fine; the rendered body is not.
//   3. `customer.anonymize.customerId` — already covered by HASH_FIELDS, but
//      listed here to document the intent.
//
// The map is keyed by `envelope.kind`. Values are dot-separated field paths
// relative to `envelope.payload`. The walker treats any string at the named
// path as if it had matched REDACT_FIELDS — replaced with `[REDACTED]`.
//
// Adding a new intent? Add it here. The contract test will cover it
// automatically via the corpus.

const INTENT_KIND_FIELD_RULES: Record<string, ReadonlyArray<string>> = {
  // WhatsApp body and reason fields — see investigation 08 P0 #1.
  "whatsapp.message.send": ["body", "text", "variables"],
  "whatsapp.template.send": ["variables"],
  "whatsapp.handoff.request": ["reason", "lastMessage"],
  // Validation events emit synthesised payloads. We redact any "originalText"
  // / "rewritten" content because validation triggers can capture PII the
  // customer typed.
  "validation.text.rewrite": ["originalText", "rewritten"],
  "validation.text.refuse": ["originalText", "rewritten"],
}

// ── Factory ───────────────────────────────────────────────────────────────────

export function createAuditRedactor(
  opts: AuditRedactorOptions = {},
): AuditRedactor {
  const hashSecret = opts.hashSecret ?? ""
  const warn = opts.warn ?? ((m: string) => console.warn(m))

  if (hashSecret.length === 0) {
    warn(
      "[audit-redactor] AUDIT_REDACT_SECRET is empty — hashed fields are " +
        "rainbow-table-attackable. Set a 32-char random value in production.",
    )
  }

  // Merge default sets with caller-supplied extras. Lowercase normalisation
  // is applied once here so the hot-path walker can compare against a single
  // set without repeating `.toLowerCase()`.
  const redactFields = mergeLower(REDACT_FIELDS, opts.extraRedactFields)
  const hashFields = mergeLower(HASH_FIELDS, opts.extraHashFields)
  const fieldRulesForKind =
    opts.fieldRulesForKind ??
    ((kind: string): ReadonlyArray<string> =>
      INTENT_KIND_FIELD_RULES[kind] ?? [])

  function redactPayload(payload: unknown): unknown {
    return walk(payload, "", {
      redactFields,
      hashFields,
      kindFieldPaths: new Set<string>(),
      hashSecret,
    })
  }

  function redact(record: AuditRecord): AuditRecord {
    try {
      const kind = record.envelope.kind
      const kindRules = fieldRulesForKind(kind)
      // Pre-compute the path-prefixed kind rules so the walker can hit them
      // with a single Set lookup. Paths use dot notation for objects and
      // bracket notation for arrays; the rules are relative to payload root.
      const kindFieldPaths = new Set<string>(kindRules)

      const redactedPayload = walk(record.envelope.payload, "", {
        redactFields,
        hashFields,
        kindFieldPaths,
        hashSecret,
      })

      // Shallow-clone the record and envelope, substituting the redacted
      // payload. Invariant #3: intentHash is NEVER recomputed — replay uses
      // it to look up the original envelope and that lookup must remain
      // stable.
      const redactedRecord: AuditRecord = {
        ...record,
        envelope: {
          ...record.envelope,
          payload: redactedPayload,
        },
      }

      // P0-15 Option A: recompute auditHash over the redacted record so
      // `verifyAuditRecord` reading from a downstream sink (NATS, Postgres)
      // can verify tamper-evidence on the redacted record. The pre-W2
      // redactor preserved the unredacted-payload auditHash verbatim,
      // which guaranteed `verifyAuditRecord` reported `tampered` for
      // every redacted record (the only kind any sink ever sees).
      //
      // Replay implications: a replay tool re-deriving auditHash against
      // a stored record MUST redact with the same config (rule sets +
      // hashSecret) to reproduce the stored hash. Operators MUST snapshot
      // `AUDIT_REDACT_SECRET` alongside the audit stream.
      return recomputeAuditHash(redactedRecord)
    } catch (err) {
      // Invariant #5: fail-open. Surface a structured stand-in so downstream
      // sinks can detect the failure (presence of `__redactor_error`) without
      // having access to the original PII.
      warn(
        `[audit-redactor] redact() threw on intent ${record.envelope.kind}: ${
          (err as Error).message
        } — replacing payload with stub.`,
      )
      const stubbed: AuditRecord = {
        ...record,
        envelope: {
          ...record.envelope,
          payload: { __redactor_error: true },
        },
      }
      // The fail-open stub payload also needs a recomputed auditHash so
      // `verifyAuditRecord` doesn't surface false-positive tamper warnings
      // for stub records.
      return recomputeAuditHash(stubbed)
    }
  }

  return { redact, redactPayload }
}

// ── Audit-hash recomputation helper ───────────────────────────────────────────
//
// `verifyAuditRecord` from `@adjudicate/core/audit.ts:235-249` does:
//   const { auditHash, signature, ...rest } = record
//   const derived = sha256Canonical(rest)
//   return derived === auditHash ? verified : tampered
//
// To produce a record where this returns `verified: true`, the redactor
// must compute the SAME canonical-JSON hash over the SAME record minus
// auditHash + signature. We replicate the strip-and-hash here.
//
// Records lacking a v4 `auditHash` (pre-v4 audit records) get a freshly
// computed one — this is upgrade-friendly. Records with a signature: the
// signature would be invalidated by hash change, so we drop it on
// redaction. If non-repudiation is needed downstream, the signer must
// re-sign post-redaction (out of scope for the redactor).
function recomputeAuditHash(record: AuditRecord): AuditRecord {
  // Strip auditHash + signature before deriving. Mirrors verifyAuditRecord.
  const { auditHash: _previous, signature: _signature, ...rest } = record
  void _previous
  void _signature
  const auditHash = sha256Canonical(rest)
  return { ...rest, auditHash }
}

// ── Walker ────────────────────────────────────────────────────────────────────
//
// Recursive structural walk. Visits every key in objects and every index in
// arrays. The four return paths:
//
//   1. Primitive non-string  → identity (numbers, booleans, null, bigint).
//   2. String                → regex-scrub and length-cap.
//   3. Object                → re-create with each key's value walked.
//   4. Array                 → re-create with each index's value walked.
//
// Path tracking is dot-and-bracket: `customer.address[0].line1`. Tracked so
// per-intent-kind rules (`fieldRulesForKind`) can match by structural
// location, not just by leaf field name.

interface WalkContext {
  redactFields: ReadonlySet<string>
  hashFields: ReadonlySet<string>
  kindFieldPaths: ReadonlySet<string>
  hashSecret: string
}

function walk(value: unknown, path: string, ctx: WalkContext): unknown {
  // Primitives.
  if (value === null || value === undefined) return value
  if (typeof value === "number" || typeof value === "boolean") return value
  if (typeof value === "bigint" || typeof value === "symbol") return value

  if (typeof value === "string") {
    // If this string is at a path that the per-intent-kind rule names,
    // it gets the full `[REDACTED]` treatment regardless of content. This
    // is how we scrub `whatsapp.message.send.body` even when the body is
    // a fully-formed sentence with no PII regex match.
    if (path.length > 0 && pathMatchesKindRule(path, ctx.kindFieldPaths)) {
      // Idempotency guard — don't replace an already-redacted sentinel.
      return isSentinelString(value) ? value : SENTINEL_FIELD
    }
    return redactString(value)
  }

  if (Array.isArray(value)) {
    const out: unknown[] = new Array(value.length)
    for (let i = 0; i < value.length; i++) {
      out[i] = walk(value[i], path.length === 0 ? `[${i}]` : `${path}[${i}]`, ctx)
    }
    return out
  }

  if (typeof value === "object") {
    const obj = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const rawKey of Object.keys(obj)) {
      const v = obj[rawKey]
      // Key-level scrub: if a KEY itself contains a PII shape (rare but the
      // bypass corpus includes it — e.g. `"12345678900_was_processed"`), we
      // run it through the same regex defense so the JSON-serialised record
      // doesn't leak the value-as-key.
      const key = redactString(rawKey)
      const childPath = path.length === 0 ? key : `${path}.${key}`
      const lowerKey = rawKey.toLowerCase()

      // Field-name match — REDACT. The match is on the ORIGINAL key (pre-
      // scrub) so that a key like `"cpf"` still routes to REDACT even though
      // the key itself has no PII shape.
      if (ctx.redactFields.has(lowerKey)) {
        // String / number / bigint values — coerce to sentinel. A numeric
        // CPF (e.g. `cpf: 12345678900`) must not survive as a number; its
        // digits are still a PII shape in the JSON-serialised record.
        if (typeof v === "string") {
          out[key] = isSentinelString(v) ? v : SENTINEL_FIELD
        } else if (
          typeof v === "number" ||
          typeof v === "bigint" ||
          typeof v === "boolean"
        ) {
          // Booleans don't leak PII but we still scrub for shape uniformity.
          out[key] = SENTINEL_FIELD
        } else if (v === null || v === undefined) {
          out[key] = v
        } else {
          // Recurse but force the child path to be marked — most defensive:
          // walk into the object and replace every leaf string with sentinel.
          out[key] = redactSubtree(v)
        }
        continue
      }

      // Field-name match — HASH.
      if (ctx.hashFields.has(lowerKey)) {
        if (typeof v === "string") {
          out[key] = isSentinelString(v) ? v : hashValue(v, ctx.hashSecret)
        } else if (
          typeof v === "number" ||
          typeof v === "bigint"
        ) {
          out[key] = hashValue(String(v), ctx.hashSecret)
        } else if (v === null || v === undefined) {
          out[key] = v
        } else {
          // Coerce to JSON, then hash. Captures `{name: {first: "x"}}` shapes.
          out[key] = hashValue(JSON.stringify(v), ctx.hashSecret)
        }
        continue
      }

      // Per-intent-kind path match — REDACT entire subtree.
      if (pathMatchesKindRule(childPath, ctx.kindFieldPaths)) {
        if (typeof v === "string") {
          out[key] = isSentinelString(v) ? v : SENTINEL_FIELD
        } else if (
          typeof v === "number" ||
          typeof v === "bigint" ||
          typeof v === "boolean"
        ) {
          out[key] = SENTINEL_FIELD
        } else if (v === null || v === undefined) {
          out[key] = v
        } else {
          out[key] = redactSubtree(v)
        }
        continue
      }

      // Recurse — let the regex defense pick up any leaf PII strings.
      out[key] = walk(v, childPath, ctx)
    }
    return out
  }

  // Fallback (functions, exotic types) — drop to sentinel so we never leak
  // a stringified function body containing closure-captured PII.
  return SENTINEL_FIELD
}

// Replace every leaf string in a subtree with the REDACT sentinel. Used when
// a parent field name is on the REDACT list and the value is non-scalar.
function redactSubtree(value: unknown): unknown {
  if (typeof value === "string") {
    return isSentinelString(value) ? value : SENTINEL_FIELD
  }
  if (value === null || value === undefined) return value
  if (typeof value === "number" || typeof value === "boolean") return value
  if (Array.isArray(value)) {
    return value.map((v) => redactSubtree(v))
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactSubtree(v)
    }
    return out
  }
  return SENTINEL_FIELD
}

// Apply regex defenses to a string value and cap its length.
function redactString(value: string): string {
  // Length cap first — extremely long strings burn regex cycles and any PII
  // beyond the cap is unrecoverable anyway.
  let working =
    value.length > MAX_STRING_LENGTH
      ? `${value.slice(0, MAX_STRING_LENGTH)} ${SENTINEL_LONG}`
      : value

  // Idempotency — short-circuit on exact sentinel.
  if (isSentinelString(working)) return working

  // Order matters:
  //   1. Email (most distinctive shape).
  //   2. CPF (anchored 11-digit shape).
  //   3. Phone (BR-style with +55 prefix or (DD) format) — must run BEFORE
  //      card because the card regex is a greedy run of 13-19 digits that
  //      can otherwise eat a "+55 11 99999-9999" sequence.
  //   4. Card (last — remaining 13-19 digit runs that look like cards).
  working = working.replace(EMAIL_RE, SENTINEL_EMAIL)
  working = working.replace(CPF_RE, SENTINEL_CPF)
  working = working.replace(PHONE_RE, (m) => {
    const digits = m.replace(/\D/g, "")
    // 10-13 digits is the BR phone shape range. Anything outside that range
    // (e.g. a 4-digit standalone code) is left alone — the card regex picks
    // up the longer card-shape runs separately.
    if (digits.length >= 10 && digits.length <= 13) {
      return SENTINEL_PHONE
    }
    return m
  })
  working = working.replace(CARD_RE, (m) => {
    const digits = m.replace(/\D/g, "")
    return digits.length >= 13 ? SENTINEL_CARD : m
  })

  return working
}

// Salted SHA-256, truncated to 8 hex chars. Collision rate ~1/(16^8) ≈
// 1 in 4 billion — sufficient for audit-correlation purposes; insufficient
// for cryptographic uniqueness, which is intentional (we WANT this to be
// truncated so reversal is harder).
function hashValue(value: string, secret: string): string {
  const h = createHash("sha256")
  h.update(value)
  h.update(secret)
  return `${HASH_PREFIX}${h.digest("hex").slice(0, 8)}`
}

// Path-match helper. Supports literal path or any prefix where the suffix
// would be an array index. e.g. rule `"variables"` matches both
// `"variables"` and `"variables[0]"`.
function pathMatchesKindRule(
  path: string,
  rules: ReadonlySet<string>,
): boolean {
  if (rules.size === 0) return false
  if (rules.has(path)) return true
  // Strip a trailing `[N]` and try again — array element of a redacted field.
  const stripped = path.replace(/\[\d+\]$/, "")
  if (stripped !== path && rules.has(stripped)) return true
  // Any ancestor in the rule set — `variables.foo` matches rule `variables`.
  const parts = path.split(".")
  for (let i = parts.length - 1; i > 0; i--) {
    const ancestor = parts.slice(0, i).join(".")
    const ancestorStripped = ancestor.replace(/\[\d+\]$/, "")
    if (rules.has(ancestor) || rules.has(ancestorStripped)) return true
  }
  return false
}

// Merge the canonical set with optional extras and lowercase everything.
function mergeLower(
  base: ReadonlySet<string>,
  extra?: ReadonlySet<string>,
): ReadonlySet<string> {
  if (!extra || extra.size === 0) {
    // base is already lowercase by construction.
    return base
  }
  const merged = new Set<string>()
  for (const k of base) merged.add(k.toLowerCase())
  for (const k of extra) merged.add(k.toLowerCase())
  return merged
}
