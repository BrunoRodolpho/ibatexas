// NATS subscriber: audit.intent.decision.v1 → security-probe incident (BKL-211)
//
// THE AUDIT-TRAIL HALF of SCN-106 (direct prompt injection) and SCN-109
// (cross-customer PII probe under a social-engineering framing). Both scenarios
// already REFUSE correctly — the safety floor holds and is not touched here — but
// the attempt left NO reviewable row, so an attack was invisible to staff review.
// This consumer turns a security-boundary REFUSE into a governed
// `ConversationIncident` on the `security_probe` journal.
//
// ── Why THIS subject ────────────────────────────────────────────────────────
//
// `audit.intent.decision.v1` is the EXISTING kernel-decision fan-out (published by
// the audit sink wired in audit-sink-bootstrap.ts; `audit-consumer.ts` is the
// precedent consumer). Nothing new is published and no turn-path file is touched —
// the refusal behavior is byte-identical, which is the entire point: this row is
// audit completeness, never a change to what the customer is told.
//
// ── The signal (existing, deterministic, vocabulary-controlled) ─────────────
//
// `BASIS_CODES` (@adjudicate/core) is a closed, vocabulary-controlled basis
// taxonomy. A REFUSE carrying one of {@link SECURITY_BASIS_CODES} is a SECURITY
// boundary firing — categorically distinct from `business.rule_violated`, which is
// an ordinary business refusal ("we don't deliver there", "that item is 86'd") and
// is deliberately NOT in the set. No classifier, no text matching, no heuristic:
// the discriminator is the kernel's own recorded basis.
//
// TWO exclusions keep the false-positive rate at zero, and both are deterministic:
//
//   1. `system.extraction_failure` (EXTRACTION_FAILURE_KIND) is EXCLUDED. That
//      sentinel kind is owned by no pack, so the router's fail-closed path REFUSEs
//      it with `taint.level_insufficient` — the SAME basis a genuine injection
//      attempt produces. But it means "the local model emitted malformed or empty
//      tool-call JSON", i.e. an ordinary model hiccup, not an attack. Without this
//      exclusion every 4B extraction wobble would open a security incident.
//
//   2. Only `actor.principal === "llm"` records qualify — the customer
//      conversational plane, where untrusted text drives the proposal. Staff/ops
//      envelopes (`principal: "user"`, sessionId `admin:<staffId>`) and system
//      envelopes (`principal: "system"` — subscribers, jobs, webhooks) are
//      authenticated internal actors; a scope refusal there is an authorization bug
//      or a role misconfiguration for the ops inbox, not a customer-plane attack.
//
// ── Known coverage limit (honest scope) ────────────────────────────────────
//
// This fires only when the turn actually PROPOSED an envelope that a security
// guard then refused. A probe the planner answers with NO envelope at all
// (`decision.refusal.code === "empty_plan"` — the shape SCN-106 exhibited live)
// produces no audit record and therefore no incident. Keying on `empty_plan`
// instead is not an option: it is the ordinary respond-only outcome of every
// small-talk turn, so it would open an incident on "boa tarde". Closing that gap
// needs a marker at the planner/responder refusal seam and is tracked separately —
// a detection-coverage question, not a defect in this row.
//
// ── Delivery semantics ─────────────────────────────────────────────────────
//
// Durable queue group + the same two-phase `withDedup` idiom as
// incident-subscriber.ts: the 7-day key commits ONLY after the open succeeds, so a
// transient failure redelivers (JetStream) / DLQs (Core) rather than being
// ack-suppressed. The dedup key is `(intentHash, at)` — the exact pair
// audit-consumer.ts already treats as an audit record's identity.

import { subscribeNatsEvent } from "@ibatexas/nats-client";
import { SECURITY_PROBE_KIND } from "@ibatexas/domain";
import type { FastifyBaseLogger } from "fastify";
import {
  openIncidentInline,
  type LogFn,
  type NoDeliverySignal,
} from "../conversation/no-delivery.js";
import { EXTRACTION_FAILURE_KIND } from "../claustrum/model-call-defaults.js";
import { withDedup } from "./dedup.js";

/**
 * The closed set of `BASIS_CODES` entries that mean "a SECURITY boundary refused
 * this proposal", keyed as `"<category>.<code>"`.
 *
 * Every member is an existing kernel basis code — this set SELECTS from that
 * vocabulary, it does not invent one. Membership rationale:
 *
 *   taint.level_insufficient        — UNTRUSTED content tried to drive an intent
 *                                     whose policy demands a higher trust floor.
 *                                     The direct-injection signature (SCN-106).
 *   taint.propagation_violation     — tainted data escalated across a boundary it
 *                                     may not cross (stored / indirect injection).
 *   auth.scope_insufficient         — the actor's scope does not cover the
 *                                     resource. The cross-customer / IDOR
 *                                     signature (SCN-109).
 *   validation.pii_blocked          — a PII egress boundary blocked the payload.
 *   validation.command_blocked      — a command-injection boundary blocked it.
 *   validation.session_risk_elevated — the session tripped the risk boundary.
 *   kernel.guard_panic              — a guard THREW and the kernel converted it
 *                                     into a fail-closed SECURITY refuse. A guard
 *                                     that panics on customer input is exactly the
 *                                     shape of a malformed adversarial payload, and
 *                                     it must never be invisible.
 *
 * DELIBERATELY ABSENT: `business.rule_violated` (the ordinary business refusal —
 * the single most important exclusion, and what the false-positive test pins),
 * `state.*` (a legal-transition problem), `ledger.*` (replay / versioning),
 * `schema.*` (a malformed payload the model produced), `auth.identity_missing` (an
 * unauthenticated customer being asked to log in is routine, not an attack),
 * `validation.pii_detected` / `pii_redacted` (detection / redaction that ALLOWED
 * the flow — no boundary was crossed), and every `*_permitted` / `*_satisfied`
 * code (those accompany EXECUTE).
 */
export const SECURITY_BASIS_CODES: ReadonlySet<string> = new Set<string>([
  "taint.level_insufficient",
  "taint.propagation_violation",
  "auth.scope_insufficient",
  "validation.pii_blocked",
  "validation.command_blocked",
  "validation.session_risk_elevated",
  "kernel.guard_panic",
]);

/** Structural slice of the NATS-side `AuditRecord` this consumer reads. */
interface AuditDecisionPayload {
  readonly intentHash?: unknown;
  readonly at?: unknown;
  readonly envelope?: {
    readonly kind?: unknown;
    readonly actor?: { readonly principal?: unknown; readonly sessionId?: unknown };
  };
  readonly decision?: { readonly kind?: unknown };
  readonly decision_basis?: unknown;
}

/** The fields a qualifying security-probe record yields. */
export interface SecurityProbeSignal {
  readonly sessionId: string;
  readonly intentKind: string;
  readonly intentHash: string;
  readonly at: string;
  /** The `<category>.<code>` basis entries that qualified the record. */
  readonly matchedBasis: readonly string[];
}

/**
 * PURE. Decide whether an audit record is a customer-plane security-probe refusal,
 * and project the incident-relevant fields. Returns `null` for everything else —
 * this is the false-positive wall, and every rejection below is a deterministic
 * structural check, never a judgement about the customer's text.
 */
export function classifySecurityProbe(
  payload: AuditDecisionPayload,
): SecurityProbeSignal | null {
  // Only REFUSE decisions. An EXECUTE that merely CARRIES a taint basis was
  // permitted, and is not a refused probe.
  if (payload.decision?.kind !== "REFUSE") return null;

  const actor = payload.envelope?.actor;
  // Customer conversational plane only (see the header note on principals).
  if (actor?.principal !== "llm") return null;

  const sessionId = typeof actor.sessionId === "string" ? actor.sessionId : null;
  if (!sessionId) return null;

  const intentKind =
    typeof payload.envelope?.kind === "string" ? payload.envelope.kind : null;
  if (!intentKind) return null;
  // An extraction-wire failure is a model hiccup, not an attack (header note 1).
  if (intentKind === EXTRACTION_FAILURE_KIND) return null;

  const intentHash = typeof payload.intentHash === "string" ? payload.intentHash : null;
  const at = typeof payload.at === "string" ? payload.at : null;
  if (!intentHash || !at) return null;

  if (!Array.isArray(payload.decision_basis)) return null;
  const matchedBasis = payload.decision_basis
    .map((b) => {
      const entry = b as { category?: unknown; code?: unknown } | null;
      return entry && typeof entry.category === "string" && typeof entry.code === "string"
        ? `${entry.category}.${entry.code}`
        : null;
    })
    .filter((c): c is string => c !== null && SECURITY_BASIS_CODES.has(c));

  if (matchedBasis.length === 0) return null;

  return { sessionId, intentKind, intentHash, at, matchedBasis };
}

/**
 * Build the governed open payload. `customerImpacted` is FALSE by construction:
 * the customer WAS answered — correctly, with a refusal — so this is not a ghost.
 * That also keeps the row off the `silêncio` severity branch (`deriveSeverity`
 * maps a recent non-impacted incident to `low`), which is right: the safety floor
 * held, so this is a review item, not an outage.
 *
 * `detail` carries the matched basis codes + the refused intent kind — the whole
 * point of the row for a reviewing human. Both are structural kernel vocabulary,
 * never customer text, so no PII can leak into the incident journal.
 */
function toSignal(probe: SecurityProbeSignal): NoDeliverySignal {
  return {
    sessionId: probe.sessionId,
    cause: "security_probe",
    customerImpacted: false,
    // The audit record carries no channel; the incident correlates by session.
    channel: "unknown",
    customerId: null,
    senderRef: null,
    phoneHash: null,
    // The audit record has no turnId; intentHash is the per-decision identity.
    turnId: null,
    decisionKind: "REFUSE",
    messageSid: probe.intentHash,
    detail: `[SECURITY_PROBE] refused intent '${probe.intentKind}' — basis: ${probe.matchedBasis.join(", ")}`,
  };
}

export async function startSecurityProbeSubscriber(
  log?: FastifyBaseLogger,
): Promise<void> {
  const lf: LogFn = {
    info: (...a: unknown[]) => log?.info(a[0] as object, a[1] as string),
    warn: (...a: unknown[]) => log?.warn(a[0] as object, a[1] as string),
    error: (...a: unknown[]) => log?.error(a[0] as object, a[1] as string),
  };

  await subscribeNatsEvent(
    "audit.intent.decision.v1",
    async (payload) => {
      const probe = classifySecurityProbe(payload as AuditDecisionPayload);
      // The overwhelming majority of records are not probes — leave silently.
      if (!probe) return;

      log?.warn(
        {
          component: "security",
          event: "security_probe_refused",
          session_id: probe.sessionId,
          intent_kind: probe.intentKind,
          basis: probe.matchedBasis,
        },
        "[security-probe] security-boundary REFUSE on a customer turn — opening review incident",
      );

      // Two-phase idempotency, identical in shape to incident-subscriber.ts: the
      // 7-day key commits ONLY after the side effect succeeds, so a transient
      // failure redelivers instead of being ack-suppressed. `(intentHash, at)` is
      // the audit record's identity (the same pair audit-consumer.ts dedups on),
      // so a redelivered record collapses here; the domain executor's
      // `@@unique(externalId)` + findFirst-OPEN are the second and third layers.
      const processed = await withDedup(
        `incident:security_probe:${probe.intentHash}:${probe.at}`,
        async () => {
          const result = await openIncidentInline(
            toSignal(probe),
            lf,
            SECURITY_PROBE_KIND,
          );

          if (result.kind === "opened") {
            log?.warn(
              {
                session: probe.sessionId,
                incident_id: result.incidentId,
                basis: probe.matchedBasis,
              },
              "[security-probe] opened security-probe incident",
            );
          } else if (result.kind === "refused") {
            // Governance refused the OPEN itself (a cause/journal mismatch — our
            // bug, not an attacker). Surface loudly; unlike the owed-reply case in
            // incident-subscriber.ts no customer is waiting, so no suspect row.
            log?.error(
              { session: probe.sessionId, code: result.code },
              "[security-probe] kernel REFUSED the security-probe incident open",
            );
          } else if (result.kind === "error") {
            // Do NOT swallow — rethrow so withDedup releases the claim and the
            // record is redelivered / DLQ'd. A lost security row is the exact
            // failure mode this subscriber exists to prevent.
            throw result.error instanceof Error
              ? result.error
              : new Error(
                  `[security-probe] incident open failed: ${String(result.error)}`,
                );
          }
          // kind:"duplicate" → success no-op; the claim promotes to the full TTL.
        },
      );

      if (!processed) {
        log?.info(
          { session: probe.sessionId, intent_hash: probe.intentHash },
          "[security-probe] duplicate — skipping",
        );
      }
    },
    { queueGroup: "security-probe-subscriber" },
  );
}
