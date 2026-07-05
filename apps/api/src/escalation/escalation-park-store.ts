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
  /** The parked `actor.role` — MUST round-trip so `staffRoleGuard` re-runs on resume. */
  readonly actorRole?: string;
  readonly taint: IntentEnvelope["taint"];
  readonly requestedAt: string;
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

/**
 * The intent kinds whose ESCALATE is RESUMABLE — parked here so an OWNER can
 * approve-and-execute it. Today: only the above-threshold staff refund. Adding a
 * kind here is a deliberate governance decision (a resumable money verb).
 */
export const ESCALATION_RESUMABLE_KINDS: ReadonlySet<string> = new Set([
  "payment.refund.issue",
]);

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
  return String(envelope.kind);
}

/**
 * Extract the park record (rebuild inputs + projection metadata) from an
 * IntentEnvelope at ESCALATE time. `proposerId` is read from the DB-stamped
 * `payload.actorId` (the ops resolver stamps the authenticated proposer's
 * staffId there) with a fallback to the session-derived id.
 */
export function buildEscalationParkInput(
  envelope: IntentEnvelope,
): Omit<ParkedEscalationIntent, "token"> {
  const payload = (envelope.payload ?? {}) as Record<string, unknown>;
  const proposerId =
    typeof payload.actorId === "string" && payload.actorId !== ""
      ? payload.actorId
      : stripStaffPrefix(envelope.actor.sessionId) || null;
  const role = (envelope.actor as { role?: string }).role;
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
    taint: envelope.taint,
    requestedAt: new Date().toISOString(),
  };
}
