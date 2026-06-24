// TEST-PLANE ONLY — forged-envelope ingress (closes JOURNEY-008's
// `envelope-ingress-gap`).
//
// Production customer routes build their envelope via `buildCustomerEnvelope`
// (which STRUCTURALLY excludes actor/taint from caller input) and Fastify zod
// schemas strip unknown fields, so an attacker can never deliver a raw,
// caller-controlled `IntentEnvelope` to the runtime forgery guard. That is the
// P2-6/P2-7 defense — but it also meant the guard had no HTTP exercise surface
// (only unit tests reached `detectForgery`). This route is exactly that surface,
// HARD-GATED to the test plane: it hands a raw envelope UNCHANGED to
// `runCustomerIntent`, whose `detectForgery` REFUSEs anything with
// `actor.principal !== "user"` / `taint !== "UNTRUSTED"` — HTTP 400
// `forgery_attempt` + a tamper-evident SYSTEM-actor audit record.
//
// `detectForgery` runs BEFORE adjudication, so the state/policy/executor below
// are inert placeholders for a forged envelope (never reached).

import type { FastifyInstance } from "fastify";
import type { IntentEnvelope, PolicyBundle } from "@adjudicate/core";
import { getAuditSink } from "@ibatexas/audit-sink";
import { ordersPolicyBundle } from "@ibatexas/pack-orders";
import { runCustomerIntent } from "./__shared__/customer-intent-gateway.js";

/** Hard gate: ENABLED only when NOT production AND the test fingerprint is present
 *  (only `.env.test` carries IBX_TEST_FINGERPRINT — D-010). Pure + unit-testable. */
export function envelopeIngressGate(): {
  ok: boolean;
  reason?: "production" | "no-fingerprint";
} {
  if (process.env.NODE_ENV === "production") return { ok: false, reason: "production" };
  if (!process.env.IBX_TEST_FINGERPRINT) return { ok: false, reason: "no-fingerprint" };
  return { ok: true };
}

export async function envelopeIngressRoutes(server: FastifyInstance): Promise<void> {
  const gate = envelopeIngressGate();
  if (!gate.ok) {
    server.log.info(
      { reason: gate.reason },
      "[test-envelope-ingress] route NOT registered (fail-closed)",
    );
    return;
  }
  server.log.warn("[test-envelope-ingress] TEST-PLANE forged-envelope ingress ENABLED");

  server.post("/api/test/envelope-ingress", async (request, reply) => {
    // Accept the raw, caller-controlled envelope verbatim (no zod stripping) —
    // the whole point is to let a forged actor/taint reach the runtime guard.
    const envelope = (request.body as { envelope?: unknown } | undefined)?.envelope;
    if (envelope === null || typeof envelope !== "object") {
      return reply.code(422).send({ error: "envelope (object) required" });
    }
    let auditSink;
    try {
      auditSink = getAuditSink();
    } catch {
      auditSink = undefined; // sink not initialized (bare test harness) — guard still REFUSEs
    }
    const result = await runCustomerIntent({
      envelope: envelope as IntentEnvelope,
      state: {},
      policy: ordersPolicyBundle as unknown as PolicyBundle<string, unknown, unknown>,
      executor: async () => ({ ok: true }),
      ctx: { customerId: "test-ingress", route: "test.envelope-ingress", log: server.log },
      ...(auditSink !== undefined ? { auditSink } : {}),
    });
    return reply.code(result.statusCode).send(result.body);
  });
}
