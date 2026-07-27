// AUT-017 — escalation park store.
//
// When a money intent ESCALATEs to a human (today: an above-threshold
// `payment.refund.issue`), the FULL IntentEnvelope is parked here BEFORE the
// `support.handoff_requested` NATS publish, keyed by a single-use token, so an
// OWNER can later APPROVE it and the adopter can rebuild the IDENTICAL envelope
// (same `intentHash`) and re-adjudicate it through the audited kernel. The
// envelope payload itself NEVER rides NATS — only the opaque `parkToken` +
// `intentHash` + a pt-BR summary do (subscribers/handoff-subscriber.ts).
//
// This is the RESTART-SURVIVING backing for the ESCALATE→approve→resume loop: it
// works with the managed-agent plane OFF (unlike the in-memory agent-approvals
// engine), so a park created before a restart is still approvable after it.
//
// ── Why rk() + Lua atomic consume (CLAUDE.md rules #7 + #10) ──────────────────
//
// Every key passes through `rk()` for the deployment-wide namespace prefix
// (rule #7). `consume()` is a single-use atomic GET+DEL (Lua) so two racing
// approvers cannot both resume the same parked envelope — mirrors the
// admin force-action confirmation store's `CONSUME_RECEIPT_SCRIPT`. `get()` is a
// non-consuming peek (the resolve surface's separation-of-duty check reads the
// proposer WITHOUT burning the token, so a legitimate different-owner approval
// can still proceed).

import { randomUUID } from "node:crypto";
import { getRedisClient, rk } from "@ibatexas/tools";
import type { IntentEnvelope } from "@adjudicate/core";

/**
 * Single-use parked escalation intent. Carries (a) the envelope REBUILD inputs
 * — same kind/payload/actor/role/taint/nonce → same `intentHash`, so the resume
 * receipt matches — and (b) the projection metadata the resolve surface needs
 * (`proposerId` for separation-of-duty; `sessionId` to update the projection).
 */
export interface ParkedEscalationIntent {
  readonly token: string;
  /** The escalation session this parked intent belongs to (projection linkage). */
  readonly sessionId: string;
  readonly intentKind: string;
  readonly intentHash: string;
  /** pt-BR one-liner shown to staff (e.g. "reembolso de R$ 1.500,00"). */
  readonly summaryPtBr: string;
  /**
   * The PROPOSER's raw staffId — the separation-of-duty comparand at resolve
   * (an OWNER may not approve their OWN escalation request). Null when the
   * proposer is unidentifiable (should not occur on the JWT-authenticated ops
   * plane); a null proposer never equals a real approver id, so it fails OPEN of
   * the self-approve gate but is still fully gated by `requireOwnerRole`.
   */
  readonly proposerId: string | null;
  // ── Envelope rebuild inputs (schema v2: createdAt is NOT hashed) ──
  readonly envelopeKind: string;
  readonly payload: unknown;
  readonly nonce: string;
  readonly actorSessionId: string;
  readonly actorPrincipal: IntentEnvelope["actor"]["principal"];
  /**
   * LE2-024 — HASH-BEARING, and the second field of this record to earn that
   * note after `resourceRefs`.
   *
   * `actor.customerId` is part of the `intentHash` pre-image. The CONVERSATIONAL
   * plane's envelopes are minted by the planner, whose actor carries none, so
   * every park this store had ever seen hashed identically without it and its
   * absence was invisible.
   *
   * A WORKFLOW ACTIVITY's envelope is different: `submitActivity` mints it with
   * the Capsule's own actor, which DOES carry `customerId`. Without this field
   * the rebuilt envelope hashes differently, the engine's FIX-3 integrity check
   * refuses, and the approval comes back `denied_by_kernel` — i.e. a
   * workflow-created escalation is staff-visible and permanently unapprovable,
   * which is exactly the hole BKL-103 exists to keep shut, reached through a
   * door that did not exist when it was written.
   *
   * Optional and spread at both ends, so an ops refund and a directly-parsed
   * customer cancel park and rebuild byte-identically to before.
   */
  readonly actorCustomerId?: string;
  /** The parked `actor.role` — MUST round-trip so `staffRoleGuard` re-runs on resume. */
  readonly actorRole?: string;
  readonly taint: IntentEnvelope["taint"];
  /**
   * BKL-103 — the envelope's `resourceRefs`, which ARE part of the `intentHash`
   * pre-image `(version, kind, payload, nonce, actor, taint, origin, resourceRefs)`.
   *
   * WHY THIS HAD TO BE ADDED. AUT-017's park/rebuild contract was built for the
   * OPS plane, and an ops refund envelope carries NO `resourceRefs` — so dropping
   * them was invisible. The CUSTOMER plane is different: `createIbatexasResolver`
   * stamps `resourceRefs` on every ownership-gated order kind (034-F1, the kernel
   * IDOR binding). Without round-tripping them the rebuilt envelope hashes
   * DIFFERENTLY from the parked one, and `createEscalationApprovalEngine`'s FIX 3
   * integrity check REFUSEs — so a customer-plane escalation could be parked and
   * displayed but NEVER approved. Found by driving the real turn seam
   * (`chat-cancel-escalate-approve.e2e.test.ts`); a renderer-level test would have
   * shown a green park and a dead approve.
   *
   * Optional + canonical-drop-safe: absent ⇒ omitted from the rebuild ⇒ the refund
   * path's hash is byte-identical to pre-BKL-103.
   */
  readonly resourceRefs?: IntentEnvelope["resourceRefs"];
  readonly requestedAt: string;
  /**
   * BKL-115 — the ESCALATE audit row's timestamp, threaded onto the resume
   * `confirmationReceipt.originalAt` so the kernel binds the resumed EXECUTE's
   * `supersedes.predecessorAt` to the ESCALATE row (not the resume row's own
   * `at`). `buildSupersessionChains` then joins the EXECUTE back to its ESCALATE
   * instead of seeing a false cycle/singleton.
   *
   * LIMITATION: the TRUE ESCALATE audit `at` is stamped inside the kernel and is
   * NOT reachable at the park seam — the published `@claustrum/core` dispatch
   * calls `handoff.queue(envelope, reason)`, which does not carry the ESCALATE
   * AuditRecord (threading it would be a publish-gated contract change). So this
   * holds the park's own `requestedAt` as the documented best-available
   * predecessor: it is generated a few ms AFTER the ESCALATE `at` in the same
   * dispatch, so the chain join resolves to the ESCALATE record (the chain
   * builder disambiguates a shared-hash bucket by `predecessorAt`, falling back
   * to the chronologically-first record — the ESCALATE row). Additive/optional:
   * an absent value leaves the receipt byte-identical to pre-BKL-115.
   */
  readonly escalatedAt?: string;
}

export interface EscalationParkStore {
  /**
   * Persist a parked escalation intent. Generates a single-use token (unless one
   * is supplied) and returns it with the TTL. The stored JSON carries the token
   * so `consume`/`get` return a self-describing record.
   */
  park(
    input: Omit<ParkedEscalationIntent, "token"> & { token?: string },
  ): Promise<{ readonly token: string; readonly ttlSeconds: number }>;
  /**
   * Atomically read + delete the parked intent (single-use). Returns null when
   * the token is unknown, already consumed, or expired — a second `consume` of
   * the same token returns null (exactly one resume executes).
   */
  consume(token: string): Promise<ParkedEscalationIntent | null>;
  /**
   * Read the parked intent WITHOUT consuming (plain GET, TTL untouched). The
   * resolve surface peeks first so a self-approve refusal does NOT burn the
   * token — a different owner can still approve within the TTL.
   */
  get(token: string): Promise<ParkedEscalationIntent | null>;
}

/**
 * Park TTL. Default 24h (86_400s) — an escalated money intent should be approved
 * (or lapse) within a day; a lapsed park is simply re-issued by re-running the
 * command. Env override `ESCALATION_PARK_TTL_SECONDS`.
 */
export function getEscalationParkTtlSeconds(): number {
  const raw = process.env.ESCALATION_PARK_TTL_SECONDS;
  if (!raw) return 86_400;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n) || n < 1) return 86_400;
  return n;
}

/**
 * Lua atomic GET + DEL — returns the stored JSON and deletes the key in one
 * round trip; nil otherwise. Single-use: a second consume returns nil. Mirrors
 * `admin-confirmation-store.ts`'s `CONSUME_RECEIPT_SCRIPT`.
 */
const CONSUME_PARK_SCRIPT = `
local value = redis.call('GET', KEYS[1])
if value then
  redis.call('DEL', KEYS[1])
  return value
else
  return nil
end
`;

const parkKey = (token: string): string => rk(`escalation:park:${token}`);

function isPlausibleToken(token: string): boolean {
  return typeof token === "string" && token.length > 0 && token.length <= 128;
}

function parse(raw: string | null | undefined): ParkedEscalationIntent | null {
  if (raw === null || raw === undefined) return null;
  try {
    return JSON.parse(raw) as ParkedEscalationIntent;
  } catch {
    return null;
  }
}

/** Build a park store wired to the shared Redis client (stateless — parks live in Redis). */
export function createEscalationParkStore(): EscalationParkStore {
  return {
    async park(input) {
      const token = input.token ?? randomUUID();
      const record: ParkedEscalationIntent = { ...input, token };
      const ttlSeconds = getEscalationParkTtlSeconds();
      const redis = await getRedisClient();
      await redis.set(parkKey(token), JSON.stringify(record), { EX: ttlSeconds });
      return { token, ttlSeconds };
    },

    async consume(token) {
      if (!isPlausibleToken(token)) return null;
      const redis = await getRedisClient();
      const raw = (await redis.eval(CONSUME_PARK_SCRIPT, {
        keys: [parkKey(token)],
        arguments: [],
      })) as string | null;
      return parse(raw);
    },

    async get(token) {
      if (!isPlausibleToken(token)) return null;
      const redis = await getRedisClient();
      return parse(await redis.get(parkKey(token)));
    },
  };
}

/** Lazily build a park store over the shared redis client. */
export function getEscalationParkStore(): EscalationParkStore {
  return createEscalationParkStore();
}

// ── ESCALATE-park wiring helpers (used by the HandoffPort at park time) ───────

// ── BKL-113 — the resumable-kind PROPOSER-STAMP contract ─────────────────────
//
// The pack overlay's escalate-band self-approve gate is STRUCTURAL: it converts
// the ESCALATE only when `approval.approverId !== payload.actorId`
// (pack-payments/src/policies.ts, the AUT-017 overlay). That comparand is a
// PAYLOAD field — so it only gates when the write side actually STAMPED the
// authenticated proposer onto it. If a kind is added to
// `ESCALATION_RESUMABLE_KINDS` WITHOUT such a stamp, `payload.actorId` is
// `undefined`, `approverId !== undefined` is trivially true, and the deepest
// separation-of-duty gate SILENTLY degrades to the route JWT + engine checks
// only — no failing test, no compile error, just a weaker gate. (The park's own
// `proposerId` would fall back to the session-derived id, which is the shallower
// engine-level gate, not the pack's.)
//
// This block makes that contract MECHANICAL instead of prose:
//
//   1. `RESUMABLE_KINDS` is the SINGLE declaration site of the resumable set —
//      `ESCALATION_RESUMABLE_KINDS` is DERIVED from it, so there is no set
//      literal to sneak a kind into.
//   2. `ESCALATION_PROPOSER_STAMPS` is typed `Record<EscalationResumableKind, …>`
//      ⇒ EXHAUSTIVE over that tuple. Adding a kind without declaring its
//      proposer stamp is a COMPILE error at this file, not a review miss.
//   3. `buildEscalationParkInput` READS the proposer through the registry, so a
//      declaration is load-bearing rather than decorative, and
//      `escalation-approval.ts`'s `REQUIRED_ESCALATION_APPROVAL_BASIS` is
//      exhaustive over the SAME union (a second required declaration).
//   4. The behavioural half lives in
//      `__tests__/escalation-actor-stamp-contract.test.ts`: it drives EVERY
//      member kind through the REAL composed policy router and proves the gate
//      actually reads the declared field (including a stamp-stripped negative
//      control that reproduces the degradation above).
//
// Gates BKL-103's future `order.cancel` expansion.

/**
 * A resumable kind's PROPOSER-STAMP declaration: WHICH payload field carries the
 * authenticated proposer, WHERE it is stamped, and HOW to read it. Every member
 * of {@link ESCALATION_RESUMABLE_KINDS} must have one.
 */
export interface EscalationProposerStamp {
  /**
   * The canonical payload field carrying the proposer id — the SAME field the
   * pack overlay's self-approve gate compares the approver against.
   */
  readonly payloadField: string;
  /** The authenticated stamping site(s). Documentation for the reviewer. */
  readonly stampedBy: string;
  /**
   * Structural reader: the proposer id from a canonical (stamped) payload, or
   * null when the field is absent/blank (⇒ the park falls back to the
   * session-derived id, which never equals a real approver id).
   */
  readonly readProposerId: (
    payload: Readonly<Record<string, unknown>>,
  ) => string | null;
}

/** Read a non-empty string payload field, else null. */
function readStampedString(
  payload: Readonly<Record<string, unknown>>,
  field: string,
): string | null {
  const value = payload[field];
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * The intent kinds whose ESCALATE is RESUMABLE — parked here so an OWNER can
 * approve-and-execute it. Today: only the above-threshold staff refund. Adding a
 * kind here is a deliberate governance decision (a resumable money verb) AND
 * REQUIRES a matching {@link ESCALATION_PROPOSER_STAMPS} entry — the compiler
 * enforces it (BKL-113).
 */
const RESUMABLE_KINDS = ["payment.refund.issue", "order.cancel"] as const;

/** The literal union of resumable kinds — the exhaustiveness key (BKL-113). */
export type EscalationResumableKind = (typeof RESUMABLE_KINDS)[number];

/**
 * BKL-113 — per resumable kind, the proposer stamp its self-approve gate depends
 * on. EXHAUSTIVE over {@link EscalationResumableKind} by type: a kind added to
 * `RESUMABLE_KINDS` without an entry here does not compile.
 */
export const ESCALATION_PROPOSER_STAMPS: Readonly<
  Record<EscalationResumableKind, EscalationProposerStamp>
> = {
  "payment.refund.issue": {
    payloadField: "actorId",
    stampedBy:
      "ops/ops-resolver.ts resolveRefundTarget (`actorId: deps.staffId`, STOP-GATE B) + routes/admin/payments.ts; re-forced in ops-tool-registry.ts executeRefund",
    readProposerId: (payload) => readStampedString(payload, "actorId"),
  },
  // BKL-103 — the >=R$1.000 PAID customer cancel. Unlike the refund (proposed by
  // STAFF on the ops plane), a cancel is proposed by the CUSTOMER, so the stamped
  // proposer is the authenticated CUSTOMER id and the approver is an OWNER staff id.
  //
  // ⚠ READ THIS BEFORE ADDING THE NEXT KIND — on `order.cancel` the self-approve
  // gate's protection is STRUCTURAL, NOT ACTIVELY DISCRIMINATING. A customer id and
  // an OWNER staff id are drawn from different namespaces, so
  // `approverId !== payload.actorId` is essentially always true here: the gate is
  // SATISFIED by construction rather than filtering a real population of
  // self-approvals (the one case it would catch is an owner cancelling an order they
  // placed as a customer). Contrast the refund, where proposer and approver are BOTH
  // staff ids and the gate genuinely discriminates.
  //
  // The stamp is therefore NOT decorative, and must not be skipped on that
  // reasoning. It is load-bearing three ways: (1) it is the comparand whose ABSENCE
  // silently degrades the gate to `approverId !== undefined` — the BKL-113 hazard,
  // and for this kind the pack overlay additionally refuses to convert at all
  // without it (fail-closed); (2) it is the authenticated customer scope the resume
  // re-projection reads (`escalationResumeSeedState`), because the conversational
  // envelope's `actor.sessionId` is a CONVERSATION id; (3) it rides the inner
  // refund's payload so THAT overlay's separation-of-duty check is a real
  // inequality (approved-inner-refund.ts). A future kind whose proposer and approver
  // share a namespace gets ACTIVE discrimination from the same field — which is why
  // the contract keeps the declaration mandatory for every member.
  //
  // `actorId` reuses the refund's field NAME deliberately: it keeps the two pack
  // overlays' gate expressions parallel, matches pack-orders' own
  // `OrderStatusTransitionPayload.actorId` precedent, and — load-bearing — is
  // ALREADY in `FORBIDDEN_EXTRACTION_FIELD_NAMES`
  // (claustrum/language-engine/extraction-schema.ts), so no extraction schema can
  // ever expose it to the model. That matters: a model-authored proposer could
  // set a value that never matches the approver, making the gate trivially pass.
  // Host-stamped Identity class only.
  "order.cancel": {
    payloadField: "actorId",
    stampedBy:
      "routes/order-actions.ts (both cancel envelope sites: POST /api/orders/:id/cancel and .../cancel/confirm — `actorId: customerId` off the authenticated customer) + claustrum/resolve-and-assemble.ts stampCancelProposer for the conversational plane",
    readProposerId: (payload) => readStampedString(payload, "actorId"),
  },
};

/**
 * DERIVED from {@link ESCALATION_PROPOSER_STAMPS}' declaration tuple — kept as
 * `ReadonlySet<string>` so the `String(envelope.kind)` call sites are unchanged.
 */
export const ESCALATION_RESUMABLE_KINDS: ReadonlySet<string> = new Set<string>(
  RESUMABLE_KINDS,
);

/** Narrow an arbitrary kind string to a declared resumable kind (BKL-113). */
export function isEscalationResumableKind(
  kind: string,
): kind is EscalationResumableKind {
  return Object.hasOwn(ESCALATION_PROPOSER_STAMPS, kind);
}

/**
 * The proposer stamp declared for `kind`, or undefined when the kind is not a
 * declared resumable kind (fail-closed: callers then have NO stamped proposer).
 */
export function escalationProposerStampFor(
  kind: string,
): EscalationProposerStamp | undefined {
  return isEscalationResumableKind(kind)
    ? ESCALATION_PROPOSER_STAMPS[kind]
    : undefined;
}

/** ISO-free deterministic pt-BR BRL formatter (no ICU dependency): 150000 → "R$ 1.500,00". */
function formatBrl(centavos: number): string {
  const negative = centavos < 0;
  const abs = Math.abs(Math.round(centavos));
  const grouped = String(Math.floor(abs / 100)).replace(
    /\B(?=(\d{3})+(?!\d))/g,
    ".",
  );
  const cents = String(abs % 100).padStart(2, "0");
  return `${negative ? "-" : ""}R$ ${grouped},${cents}`;
}

/** ops staff sessions are `admin:<staffId>`; strip a known plane prefix. */
function stripStaffPrefix(sessionId: string): string {
  const m = /^(?:admin|staff):(.+)$/.exec(sessionId);
  return m ? m[1]! : sessionId;
}

/** The pt-BR staff one-liner for a resumable escalation (e.g. "reembolso de R$ 1.500,00"). */
export function summarizeEscalation(envelope: IntentEnvelope): string {
  const payload = (envelope.payload ?? {}) as Record<string, unknown>;
  if (String(envelope.kind) === "payment.refund.issue") {
    const centavos =
      typeof payload.refundAmountCentavos === "number"
        ? payload.refundAmountCentavos
        : 0;
    return `reembolso de ${formatBrl(centavos)}`;
  }
  // BKL-103 — the parked paid-cancel's staff one-liner. Only the ENVELOPE is in
  // scope here, and `OrderCancelPayload` carries no amount (the refund-equivalent
  // magnitude lives in the projected `state.ctx.totalInCentavos`, which the park
  // seam never sees), so this names the ORDER. Staff get the human-readable
  // display number + amount from the paired `support.handoff_requested` reason
  // string that the same escalation publishes (routes/order-actions.ts
  // `publishPaidCancelEscalation`, BKL-103's first slice) — the two surfaces are
  // complementary, and this one must stay a pure envelope read.
  if (String(envelope.kind) === "order.cancel") {
    const orderId =
      typeof payload.orderId === "string" && payload.orderId !== ""
        ? payload.orderId
        : "não identificado";
    return `cancelamento do pedido ${orderId}`;
  }
  return String(envelope.kind);
}

/**
 * Extract the park record (rebuild inputs + projection metadata) from an
 * IntentEnvelope at ESCALATE time. `proposerId` is read through the kind's
 * BKL-113 {@link ESCALATION_PROPOSER_STAMPS} declaration — for
 * `payment.refund.issue` that is the DB-stamped `payload.actorId` (the ops
 * resolver stamps the authenticated proposer's staffId there), byte-identical to
 * the pre-BKL-113 read — with a fallback to the session-derived id. Reading via
 * the registry is what makes the declaration load-bearing: an undeclared kind
 * has no stamped proposer here and falls straight through to the (shallower)
 * session fallback, exactly as the pack overlay's gate would.
 */
export function buildEscalationParkInput(
  envelope: IntentEnvelope,
): Omit<ParkedEscalationIntent, "token"> {
  const payload = (envelope.payload ?? {}) as Record<string, unknown>;
  const stampedProposerId =
    escalationProposerStampFor(String(envelope.kind))?.readProposerId(payload) ??
    null;
  const proposerId =
    stampedProposerId ?? (stripStaffPrefix(envelope.actor.sessionId) || null);
  const role = (envelope.actor as { role?: string }).role;
  const customerId = (envelope.actor as { customerId?: string }).customerId;
  // BKL-115 — the park-time instant. It is BOTH the projection `requestedAt` and
  // the best-available ESCALATE-time predecessor (`escalatedAt`) threaded onto the
  // resume receipt's `originalAt` (the true ESCALATE audit `at` is not reachable at
  // the park seam — see ParkedEscalationIntent.escalatedAt). One coherent instant.
  const parkedAt = new Date().toISOString();
  return {
    sessionId: envelope.actor.sessionId,
    intentKind: String(envelope.kind),
    intentHash: envelope.intentHash,
    summaryPtBr: summarizeEscalation(envelope),
    proposerId,
    envelopeKind: String(envelope.kind),
    payload: envelope.payload,
    nonce: envelope.nonce,
    actorSessionId: envelope.actor.sessionId,
    actorPrincipal: envelope.actor.principal,
    ...(role !== undefined ? { actorRole: role } : {}),
    // LE2-024 — hash-bearing; see ParkedEscalationIntent.actorCustomerId.
    ...(customerId !== undefined ? { actorCustomerId: customerId } : {}),
    taint: envelope.taint,
    // BKL-103 — hash-bearing; see ParkedEscalationIntent.resourceRefs. Spread so an
    // envelope WITHOUT refs (every ops refund) parks byte-identically to before.
    ...(envelope.resourceRefs !== undefined
      ? { resourceRefs: envelope.resourceRefs }
      : {}),
    requestedAt: parkedAt,
    escalatedAt: parkedAt,
  };
}
