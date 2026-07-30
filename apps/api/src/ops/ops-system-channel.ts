// ops-system-channel.ts — the ops-plane "system"-kind ChannelDriver (BKL-085).
//
// SystemChannel's behaviour (perceive / render / attest) VERBATIM, PLUS a REAL
// `matchToParked` so a REQUEST_CONFIRMATION parked by a governed ops verb (the
// BKL-085 refunds-by-message flow, and any future CONFIRM-band ops kind) resumes
// conversationally on the ops channel — "sim, confirma" → the conductor
// re-adjudicates the ORIGINAL parked envelope through the composed router
// (staffRoleGuard re-asserted with the parked role; the receipt flips
// REQUEST_CONFIRMATION → EXECUTE for the matching intentHash). SystemChannel's own
// `matchToParked` returns null unconditionally (a trigger event is never a
// yes/no reply), so this driver REPLACES it in the ops conductor only — one
// driver per kind per conductor.
//
// R4-S1 — the pt-BR reply LEXICON, the parked-reply MATCHER, the freshness
// partition, the reply-shape predicates, and the whole ingress TRIAGE sequence now
// live in ../claustrum/park-reply-triage.ts (the plane-neutral owner: the ops and
// customer-web planes share them, and the header there documents the branch
// ordering and the fail-honest unpark contract ONCE). This module keeps what is
// genuinely OPS: the driver, the ops park-write TTL stamp, and the ops ambiguity
// copy — and RE-EXPORTS the moved surfaces below so nothing outside this slice
// changes its imports.
//
// The matcher MIRRORS the published `@claustrum/channel-whatsapp` parked-match
// (priority: hash-prefix > defer-phrase > UNAMBIGUOUS-affirmative > UNAMBIGUOUS-
// negative; a MIXED affirmative+negative reply resolves to NEITHER — money-safety,
// see `matchOpsReplyToParked`; single-slot most-recent-by-parkedAt;
// NaN-sticky-timestamp guard) but the lexicons are
// pt-BR ONLY (CLAUDE.md rule #4 — the ops channel is staff-facing pt-BR). It is a
// PURE read of `session.pendingConfirmations` and never mutates state (the
// SessionPort owns durable park/unpark). A hash-prefix that matches nothing does
// NOT fall through (the staff was explicit → fresh utterance → null).
//
// Ops parks are STAFF-SESSION-SCOPED as-built: the ops ingress passes
// customerId=`staff:{staffId}`, so the durable park key is
// rk(claustrum:session:system:staff:{staffId}) — a park on one staff session is
// structurally invisible to another (no cross-staff "sim" hazard).

import type { ChannelMessage, ParkedMatch, Session } from "@claustrum/core";
import { SystemChannel } from "../claustrum/system-channel.js";
import {
  getOpsConfirmParkTtlSeconds,
  matchOpsReplyToParked,
  partitionOpsParksByFreshness,
} from "../claustrum/park-reply-triage.js";

// ── R4-S1 compatibility re-exports ───────────────────────────────────────────
// Every one of these MOVED to ../claustrum/park-reply-triage.ts (the plane-neutral
// owner). They are re-exported here unchanged so the ops ingresses, the
// customer-web driver, the bootstrap, and their existing suites keep importing
// from the same path. New call sites should import from the triage module.
export {
  expiredOpsParkNotice,
  getOpsConfirmParkTtlSeconds,
  isAmbiguousOpsReply,
  isPureNegativeReplyText,
  isSoftAffirmativeOnlyText,
  isSoftAffirmativeReplyText,
  matchOpsReplyToParked,
  opsExpiredInScopeParks,
  opsNegativeDeclineTarget,
  opsSoftAffirmativeRestateNotice,
  opsStaleResumeNotice,
  OPS_NEGATIVE_DECLINE_ACK_PTBR,
  partitionOpsParksByFreshness,
  pickMostRecentlyParked,
  pruneExpiredOpsParks,
} from "../claustrum/park-reply-triage.js";
export type { PartitionedOpsParks } from "../claustrum/park-reply-triage.js";

/**
 * FE-D33 — the confirm-park `expiresAt` for the SessionPort park-write site
 * (claustrum-bootstrap.ts). FORWARD-COMPAT ONLY: nothing upstream READS it today —
 * the freshness partition in park-reply-triage.ts stays the enforcement point, so
 * stamping this NEVER changes matching semantics. Returns a value ONLY for the
 * ops/system plane, whose confirm parks carry the freshness TTL
 * ({@link getOpsConfirmParkTtlSeconds}); a CUSTOMER-plane park (`whatsapp:`/`web:`/…)
 * has no confirm-freshness TTL, so `undefined` — never imply an unenforced
 * guarantee. Keyed off the sessionId channel prefix (`system:` ⇔ the ops plane —
 * the ops conductor keys sessions `system:staff:<id>`). A malformed `parkedAt` ⇒
 * `undefined` (nothing truthful to stamp). NOTE: the escalation
 * (`ESCALATION_PARK_TTL_SECONDS`) plane is a SEPARATE store
 * (escalation-park-store.ts), not this SessionPort — it never reaches here.
 */
export function opsConfirmParkExpiresAt(
  sessionId: string,
  parkedAt: string,
): string | undefined {
  if (!sessionId.startsWith("system:")) return undefined;
  const base = Date.parse(parkedAt);
  if (!Number.isFinite(base)) return undefined;
  return new Date(base + getOpsConfirmParkTtlSeconds() * 1000).toISOString();
}

/**
 * pt-BR clarification for an AMBIGUOUS parked reply (BKL-085 money-safety). When a
 * money/confirm action is parked and the operator's reply mixes an affirmative AND
 * a negative signal (e.g. "sim, mas não sei"), `matchOpsReplyToParked` resolves it
 * to `null` (NEITHER) — nothing executes and the park is preserved. The ingress
 * shows this line so the operator re-answers unambiguously, rather than letting an
 * unclear reply run the fresh-utterance loop or silently vanish. See
 * `isAmbiguousOpsReply` (park-reply-triage.ts).
 */
export const OPS_AMBIGUOUS_REPLY_CLARIFY_PTBR =
  "Não entendi se é para confirmar ou cancelar. A ação segue pendente — " +
  'responda "sim" para confirmar ou "não" para cancelar.';

/**
 * The ops-plane system channel: SystemChannel VERBATIM plus a REAL pt-BR
 * `matchToParked`. Constructed exactly like SystemChannel (same config), so the
 * bootstrap swap is drop-in.
 *
 * `matchToParked` returns `null` for an AMBIGUOUS reply (mixed affirmative +
 * negative) — money-safety: nothing executes and the park is preserved. To close
 * the "unclear reply while a money action is parked" UX, an ingress that already
 * holds the loaded session SHOULD, on a `null` match with a non-empty
 * `pendingConfirmations`, call `isAmbiguousOpsReply` (park-reply-triage.ts) and
 * reply with {@link OPS_AMBIGUOUS_REPLY_CLARIFY_PTBR} rather than running the
 * fresh-utterance loop (the pure ChannelDriver contract cannot emit that
 * clarification itself).
 */
export class OpsSystemChannel extends SystemChannel {
  override matchToParked(
    channelEvent: ChannelMessage,
    session: Session,
  ): ParkedMatch | null {
    // FE-D13 — a park older than the confirm-TTL is invisible to resume (bare
    // affirmative AND #hash alike, consistent with the hash-miss no-fall-through):
    // a forgotten park must never execute on a later "sim". The freshness clock is
    // the inbound receivedAt (deterministic — never Date.now()), the exact
    // session-filter idiom scopeResumeChannel uses (ops-verb-scope.ts).
    const { fresh } = partitionOpsParksByFreshness(
      session.pendingConfirmations,
      channelEvent.receivedAt,
      getOpsConfirmParkTtlSeconds(),
    );
    return matchOpsReplyToParked(channelEvent.text, fresh);
  }
}
