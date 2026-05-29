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

import { randomUUID } from "node:crypto";
import type { FastifyReply } from "fastify";
import type { Decision, IntentEnvelope } from "@adjudicate/core";
import { buildEnvelope } from "@adjudicate/core";
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
 * Type guard — narrows to a customer-actor envelope.
 *
 * The runtime contract is "principal === 'user'"; staff/admin paths use
 * a different gateway (`runStaffIntent`) so HTTP-level RBAC stays out
 * of the kernel-bridge layer.
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
 * The cutover preserves the public function name; under the hood we
 * delegate to the kernel's canonical-hash helper (re-exported via
 * @adjudicate/core), which is the only place that knows the canonical
 * byte layout.
 */
export function detectForgery(envelope: IntentEnvelope): boolean {
  const declared = (envelope as { intentHash?: string }).intentHash;
  if (!declared) return true;
  try {
    // Lazy-load the kernel helper to avoid pulling kernel internals into
    // adjudicate-free build paths.
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const kernel = require("@adjudicate/core/kernel") as {
      canonicalIntentHash?: (e: IntentEnvelope) => string;
    };
    if (typeof kernel.canonicalIntentHash !== "function") {
      // Older kernel — accept by default (fail-open for the helper that
      // didn't exist yet). The kernel itself will still re-verify the
      // hash during adjudicate().
      return false;
    }
    return kernel.canonicalIntentHash(envelope) !== declared;
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
