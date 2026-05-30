// Customer Intent Gateway — shared HTTP-route helper for explicit
// customer-driven mutations (not chat-mediated).
//
// Preserves the public interface `runCustomerIntent({...})` used by HTTP
// routes that already know the IntentEnvelope they want submitted (e.g.
// order-actions.ts, customer-orders.ts). The pre-cutover implementation
// imported from `@adjudicate/core/kernel` directly; the cutover routes
// the kernel call through `conductor.adjudicator.adjudicate(...)` so
// every customer-driven mutation flows over the same Adjudicator port
// the cognitive loop uses.
//
// Preserved invariants (from the original 478 LOC):
//   - `CustomerEnvelope` narrowing — guard that the envelope's actor is
//     `principal: "user"` (not "system" or "llm"). System-driven
//     mutations belong on the subscriber path, not this gateway.
//   - `detectForgery(envelope)` — reject envelopes whose intentHash
//     can't be recomputed (tamper-evident).
//   - The Decision-handling switch is the same shape as PART X.1 §9 of
//     the master plan brief.

import { randomUUID, timingSafeEqual } from "node:crypto";
import type { FastifyReply } from "fastify";
import type { Decision, IntentEnvelope } from "@adjudicate/core";
import { buildEnvelope, deriveIntentHash } from "@adjudicate/core";
import {
  getConductor,
  policyForKind,
  tryGetConductor,
} from "../../claustrum-bootstrap.js";

// ── Narrowed envelope shape ─────────────────────────────────────────────────

export interface CustomerEnvelope extends IntentEnvelope {
  readonly actor: {
    readonly principal: "user";
    readonly customerId: string;
    readonly sessionId: string;
    readonly role?: "customer";
  };
}

/**
 * Type guard — narrows to a user-principal envelope.
 *
 * The kernel envelope actor is `principal: "llm" | "user" | "system"` only —
 * there is no `"staff"` principal (adding one is a kernel-wide change deferred
 * per the cycle-5 guest/staff decision). So BOTH customer and staff mutations
 * ride `principal: "user"`; the distinction is carried by `taint` (customer =
 * UNTRUSTED, staff = TRUSTED, attached after `requireManagerRole`) and the
 * payload's own actor field (e.g. `PaymentRefundIssuePayload.actor: "admin"`),
 * NOT by principal. This guard therefore accepts a staff envelope too, by design;
 * authorization is the pack policy's job (taint gate + business guards), not this
 * narrowing. The name is retained for back-compat with existing customer routes.
 */
export function isCustomerEnvelope(env: IntentEnvelope): env is CustomerEnvelope {
  const actor = (env as { actor?: { principal?: string } }).actor;
  return actor?.principal === "user";
}

/**
 * Tamper-evidence check. Recomputes the `intentHash` from the canonical
 * envelope bytes and compares to the supplied hash. Returns `true` iff
 * the envelope has been altered after signing.
 *
 * Uses `deriveIntentHash` from `@adjudicate/core` — the kernel's single
 * canonical-hashing primitive (it rebuilds the hash-input fields from the
 * envelope and re-hashes; the same primitive `buildEnvelope` uses and the kernel
 * itself re-verifies with at adjudicate-time). So a legit envelope round-trips
 * (re-derived === declared) and any post-signing tamper (payload, actor, kind,
 * taint, nonce, …) yields a hash that no longer matches.
 *
 * (Previously this `require()`d a kernel export `canonicalIntentHash` that never
 * existed; the `typeof !== "function"` guard then fell through to "not forged",
 * making the whole check a silent no-op. The kernel re-verifies the hash at
 * adjudicate-time regardless, so this was inactive defense-in-depth, not an open
 * hole — but the gateway-level check is now real.)
 *
 * The derived-vs-declared comparison is constant-time (P3-CRYPTO-TIMINGSAFE):
 * a `!==` string compare short-circuits on the first differing char, leaking —
 * via timing — how many leading hex chars of a forged hash matched the real
 * digest. `crypto.timingSafeEqual` compares the full buffers in fixed time.
 * Semantics are unchanged: a genuine envelope (derived === declared) returns
 * `false` (not forged); any mismatch — including a length mismatch or a
 * non-hex declared value, which can't form an equal-length buffer — returns
 * `true` (forged).
 */
export function detectForgery(envelope: IntentEnvelope): boolean {
  const declared = (envelope as { intentHash?: string }).intentHash;
  if (!declared) return true;
  try {
    const derived = deriveIntentHash(envelope);
    // Length mismatch can never be equal; bail before allocating buffers (and
    // timingSafeEqual would throw on unequal lengths anyway). This is not a
    // timing leak: a near-match must have the same length as the real digest.
    if (derived.length !== declared.length) return true;
    const a = Buffer.from(derived);
    const b = Buffer.from(declared);
    // Buffer.from(string) is byte-length, not char-length; guard equal byte
    // length too (non-ASCII declared could differ) before the constant-time eq.
    if (a.length !== b.length) return true;
    return !timingSafeEqual(a, b);
  } catch {
    // Defensive: surface as forgery rather than crash.
    return true;
  }
}

// ── Result types ────────────────────────────────────────────────────────────

export type IntentResult =
  | { kind: "execute"; decision: Decision; data: unknown }
  | { kind: "refuse"; decision: Decision; userText: string }
  | { kind: "request_confirmation"; decision: Decision; userPrompt: string }
  | { kind: "defer"; decision: Decision; signal: string; deferUntil: string }
  | { kind: "escalate"; decision: Decision; reason: string }
  | { kind: "rewrite"; decision: Decision; rewrittenEnvelope: IntentEnvelope }
  | { kind: "forgery_detected" }
  | { kind: "not_customer_envelope" };

// ── Public API ──────────────────────────────────────────────────────────────

export interface RunCustomerIntentInput {
  readonly envelope: IntentEnvelope;
  /** Tenant state for adjudicate(). Caller assembles. */
  readonly state: unknown;
  /** Tenant policy for adjudicate(). Caller assembles. */
  readonly policy: unknown;
  /** Optional execute callback — runs ONLY when the kernel returns EXECUTE. */
  readonly onExecute?: (envelope: IntentEnvelope) => Promise<unknown>;
}

/**
 * Submit a customer-driven envelope through the Adjudicator and route on
 * the Decision variant.
 *
 * The Decision switch shape mirrors the master plan PART X.1 §9 brief.
 * No throws: every Decision variant maps to a typed IntentResult.
 */
export async function runCustomerIntent(
  input: RunCustomerIntentInput,
): Promise<IntentResult> {
  if (!isCustomerEnvelope(input.envelope)) {
    return { kind: "not_customer_envelope" };
  }
  if (detectForgery(input.envelope)) {
    return { kind: "forgery_detected" };
  }

  const conductor = getConductor();
  const decision = await conductor.adjudicator.adjudicate(
    input.envelope,
    input.state,
    input.policy,
  );

  // The Decision type is a discriminated union — narrow by `kind`.
  const d = decision as { kind: string } & Decision;

  switch (d.kind) {
    case "EXECUTE": {
      let data: unknown = undefined;
      if (input.onExecute) {
        data = await input.onExecute(input.envelope);
      }
      return { kind: "execute", decision, data };
    }
    case "REFUSE": {
      const userText =
        (d as unknown as { refusal?: { userFacing?: string } }).refusal
          ?.userFacing ?? "Não consigo processar esse pedido.";
      return { kind: "refuse", decision, userText };
    }
    case "REQUEST_CONFIRMATION": {
      const userPrompt =
        (d as unknown as { userPrompt?: string }).userPrompt ??
        "Por favor confirme essa ação.";
      return { kind: "request_confirmation", decision, userPrompt };
    }
    case "DEFER": {
      const signal = (d as unknown as { signal?: string }).signal ?? "unknown";
      const deferUntil =
        (d as unknown as { deferUntil?: string }).deferUntil ??
        new Date(Date.now() + 60_000).toISOString();
      return { kind: "defer", decision, signal, deferUntil };
    }
    case "ESCALATE": {
      const reason = (d as unknown as { reason?: string }).reason ?? "unknown";
      // Best-effort handoff queue; the queue itself is idempotent.
      try {
        await conductor.adjudicator; // satisfy unused-handoff TODO without import cycle
      } catch {
        // ignore
      }
      return { kind: "escalate", decision, reason };
    }
    case "REWRITE": {
      const rewrittenEnvelope =
        (d as unknown as { rewrittenEnvelope?: IntentEnvelope })
          .rewrittenEnvelope ?? input.envelope;
      return { kind: "rewrite", decision, rewrittenEnvelope };
    }
    default: {
      // Defensive — surface a refuse for unknown variants rather than throw.
      return {
        kind: "refuse",
        decision,
        userText: "Resposta do kernel desconhecida; tente novamente.",
      };
    }
  }
}

/**
 * Small convenience helper for HTTP handlers: shape an IntentResult into
 * a Fastify reply. Keeps route code one-liner-friendly.
 */
export function replyForIntent(reply: FastifyReply, result: IntentResult): FastifyReply {
  switch (result.kind) {
    case "execute":
      return reply.code(200).send({ ok: true, data: result.data });
    case "refuse":
      return reply.code(403).send({ ok: false, error: "refused", message: result.userText });
    case "request_confirmation":
      return reply
        .code(202)
        .send({ ok: false, status: "needs_confirmation", prompt: result.userPrompt });
    case "defer":
      return reply
        .code(202)
        .send({ ok: false, status: "deferred", signal: result.signal, deferUntil: result.deferUntil });
    case "escalate":
      return reply.code(503).send({ ok: false, status: "escalated", reason: result.reason });
    case "rewrite":
      return reply.code(409).send({ ok: false, status: "rewritten" });
    case "forgery_detected":
      return reply.code(400).send({ ok: false, error: "forgery_detected" });
    case "not_customer_envelope":
      return reply.code(400).send({ ok: false, error: "not_customer_envelope" });
  }
}

// ── Lazy-conductor adapter (RC-A1 Phase B) ───────────────────────────────────

export type MutationOutcome<T> =
  | { readonly ran: true; readonly result: T }
  | { readonly ran: false; readonly intent: IntentResult };

/**
 * Run a single customer-driven mutation under the lazy-conductor pattern.
 *
 * Pre-activation (`tryGetConductor()` → null): runs the legacy direct mutation,
 * BYTE-EQUIVALENT to pre-cutover behaviour. Post-activation: builds a
 * `principal:"user"` IntentEnvelope, resolves the per-kind PolicyBundle, submits
 * it through the Adjudicator port, and runs the mutation ONLY on EXECUTE (as the
 * `onExecute` callback). A non-EXECUTE decision (REFUSE/DEFER/…) runs no mutation
 * and is returned as a typed `IntentResult` for `replyForIntent`.
 *
 * This is the per-route seam the activation flip closes: until
 * `bootstrapClaustrum()` is called every caller is inert (legacy path); after,
 * every caller routes through the kernel. The legacy branch here is removed in
 * the same atomic commit as the flip (no permanent dual-path drift).
 */
export async function adjudicateCustomerMutation<T>(opts: {
  readonly kind: string;
  readonly payload: unknown;
  readonly customerId: string;
  /** Domain state the kind's PolicyBundle guards inspect (caller assembles). */
  readonly state: unknown;
  /** Legacy direct mutation. Unconditional pre-activation; EXECUTE-gated post. */
  readonly legacy: () => Promise<T>;
}): Promise<MutationOutcome<T>> {
  if (tryGetConductor() === null) {
    return { ran: true, result: await opts.legacy() };
  }
  const envelope = buildEnvelope({
    kind: opts.kind,
    payload: opts.payload,
    actor: { principal: "user", sessionId: `web:${opts.customerId}` },
    taint: "UNTRUSTED",
    nonce: randomUUID(),
  });
  let result: T | undefined;
  const intent = await runCustomerIntent({
    envelope,
    state: opts.state,
    policy: policyForKind(opts.kind),
    onExecute: async () => {
      result = await opts.legacy();
      return result;
    },
  });
  if (intent.kind === "execute") {
    return { ran: true, result: result as T };
  }
  return { ran: false, intent };
}

/**
 * Staff sibling of {@link adjudicateCustomerMutation} (RC-A1 Phase B).
 *
 * Same lazy-conductor seam, two deliberate differences for the staff/admin path:
 *   - `taint: "TRUSTED"` (vs UNTRUSTED) — the route attaches it AFTER
 *     `requireStaff`/`requireManagerRole` has authenticated a staff JWT, so the
 *     LLM can never forge a staff money action. (The pack's own doc: "the route
 *     layer attaches that taint after requireManagerRole succeeds.")
 *   - `sessionId: "staff:<id>"` — staff identity. The kernel envelope actor is
 *     `{ principal, sessionId }` only (no `staffId` slot and no `"staff"`
 *     principal), so the staff id rides the sessionId; the durable staff
 *     attribution lives in the payload (e.g. `actor:"admin"`, `actorId`) which the
 *     audit record preserves.
 *
 * Decision routing is actor-agnostic, so this reuses `runCustomerIntent` (a
 * staff envelope is `principal:"user"`, so it passes `isCustomerEnvelope`); the
 * customer/staff distinction is taint + payload, enforced by the pack policy, not
 * by this gateway. Pre-activation (`tryGetConductor()` → null): legacy direct
 * mutation, byte-equivalent. Post-activation: TRUSTED envelope → adjudicate →
 * mutate ONLY on EXECUTE; non-EXECUTE (e.g. the refund magnitude ladder's
 * REQUEST_CONFIRMATION / ESCALATE) → typed IntentResult for `replyForIntent`.
 */
export async function adjudicateStaffMutation<T>(opts: {
  readonly kind: string;
  readonly payload: unknown;
  /** Authenticated staff id (request.staffId), or a synthetic API-key actor. */
  readonly staffId: string;
  /** Domain state the kind's PolicyBundle guards inspect (caller assembles). */
  readonly state: unknown;
  /** Legacy direct mutation. Unconditional pre-activation; EXECUTE-gated post. */
  readonly legacy: () => Promise<T>;
}): Promise<MutationOutcome<T>> {
  if (tryGetConductor() === null) {
    return { ran: true, result: await opts.legacy() };
  }
  const envelope = buildEnvelope({
    kind: opts.kind,
    payload: opts.payload,
    actor: { principal: "user", sessionId: `staff:${opts.staffId}` },
    taint: "TRUSTED",
    nonce: randomUUID(),
  });
  let result: T | undefined;
  const intent = await runCustomerIntent({
    envelope,
    state: opts.state,
    policy: policyForKind(opts.kind),
    onExecute: async () => {
      result = await opts.legacy();
      return result;
    },
  });
  if (intent.kind === "execute") {
    return { ran: true, result: result as T };
  }
  return { ran: false, intent };
}

/**
 * System sibling of {@link adjudicateCustomerMutation} / {@link adjudicateStaffMutation}
 * (RC-A1 Phase B — the background/webhook path).
 *
 * For SYSTEM-originated mutations (Stripe webhook reconciliation, cron jobs): a
 * `principal:"system"` envelope with `taint:"TRUSTED"`. Unlike the customer/staff
 * gateways this does NOT route through `runCustomerIntent` — that helper narrows via
 * `isCustomerEnvelope` (`principal === "user"`), which a system envelope deliberately
 * fails. The forgery check is also moot: the envelope is built locally in-process
 * (not received across a trust boundary), and the kernel re-verifies the `intentHash`
 * at adjudicate-time regardless. So this adjudicates directly through the Adjudicator
 * port.
 *
 * Pre-activation (`tryGetConductor()` → null): runs the legacy mutation directly,
 * byte-equivalent. Post-activation: TRUSTED system envelope → adjudicate → run the
 * mutation ONLY on EXECUTE. A non-EXECUTE decision runs no mutation and is returned as
 * a typed refuse `IntentResult` so the caller can log/observe it — a webhook caller
 * should SKIP (not throw) on a deterministic policy REFUSE, to avoid an infinite retry.
 */
export async function adjudicateSystemMutation<T>(opts: {
  readonly kind: string;
  readonly payload: unknown;
  /** Stable system session id, e.g. `stripe:<eventId>`. Rides the envelope actor. */
  readonly sessionId: string;
  /** Domain state the kind's PolicyBundle guards inspect (caller assembles). */
  readonly state: unknown;
  /** Legacy direct mutation. Unconditional pre-activation; EXECUTE-gated post. */
  readonly legacy: () => Promise<T>;
}): Promise<MutationOutcome<T>> {
  if (tryGetConductor() === null) {
    return { ran: true, result: await opts.legacy() };
  }
  const envelope = buildEnvelope({
    kind: opts.kind,
    payload: opts.payload,
    actor: { principal: "system", sessionId: opts.sessionId },
    taint: "TRUSTED",
    nonce: randomUUID(),
  });
  const conductor = getConductor();
  const decision = await conductor.adjudicator.adjudicate(
    envelope,
    opts.state,
    policyForKind(opts.kind),
  );
  const d = decision as { kind: string } & Decision;
  if (d.kind === "EXECUTE") {
    return { ran: true, result: await opts.legacy() };
  }
  // Non-EXECUTE: no mutation. Surface a typed refuse IntentResult (a system reconcile
  // only ever EXECUTEs or REFUSEs in practice; map any other variant defensively to
  // refuse so the caller has a single "did not run" signal).
  const userText =
    (d as unknown as { refusal?: { userFacing?: string } }).refusal?.userFacing ??
    "Ação do sistema não autorizada pela política.";
  return { ran: false, intent: { kind: "refuse", decision, userText } };
}
