// web-confirm-channel.ts — the customer WEB ChannelDriver WITH conversational
// confirm-resume (BKL-033).
//
// `@claustrum/channel-web`'s `WebChannel.matchToParked` returns null
// UNCONDITIONALLY BY DESIGN (0.1.x: "a web client resumes by re-submitting the
// intent; parked matching is out of scope here"). That left every customer web
// REQUEST_CONFIRMATION dead-ended: a chat "sim" after a parked money/mutation
// action was re-planned as a fresh utterance instead of resuming the parked
// envelope, so ~a dozen MODIFY/cancel/amend flows reached the RC park but none
// could ever EXECUTE conversationally.
//
// This driver is the WEB-plane analog of `OpsSystemChannel` (BKL-085): it
// inherits `WebChannel`'s perceive / render / attest / signing VERBATIM and
// overrides ONLY `matchToParked`, so a customer's "sim, confirma" resumes the
// parked envelope. The conductor (`handleTurn` → `resolveResume`) does the rest:
// on `userResolution: "confirm"` it RE-ADJUDICATES the ORIGINAL parked envelope
// through the audited kernel path with a confirmation receipt — the receipt only
// satisfies the "ask first" threshold (REQUEST_CONFIRMATION → EXECUTE); every
// state/taint/auth/MONEY-BAND guard re-runs against fresh state, so a since-parked
// ≥R$1000 / illegal / unowned target still ESCALATEs/REFUSEs (money-safety is the
// kernel's, unchanged — this driver never bypasses re-adjudication).
//
// The matcher itself is the plane-neutral pt-BR `matchOpsReplyToParked` (the
// lexicon is customer-identical; a MIXED "não, pode deixar" → null keeps the
// park; a bare soft "ok" alone → null under the FE-D32 explicit-execute mode).
// It is a PURE read of `session.pendingConfirmations` and never mutates state
// (the SessionPort owns durable park/unpark). Customer web parks carry NO
// confirm-freshness TTL — `redisSessionStore.parkPendingConfirmation` stamps
// `expiresAt` for ops sessions ONLY (`opsConfirmParkExpiresAt`) — so every
// pending confirmation is live and there is no freshness partition to apply
// (unlike the ops driver, which prunes expired parks first).
//
// Web parks are SESSION-SCOPED: `redisSessionStore` keys the session
// `web:{customerId}` (an authed customer's id, or `guest:{sessionId}` for a
// guest), so a "sim" only ever resumes a park on the SAME customer's own
// session — no cross-session resume hazard.

import type {
  ChannelMessage,
  ParkedEnvelope,
  ParkedMatch,
  Session,
} from "@claustrum/core";
import { WebChannel } from "@claustrum/channel-web";
import {
  isPureNegativeReplyText,
  isSoftAffirmativeOnlyText,
  matchOpsReplyToParked,
  pickMostRecentlyParked,
} from "../ops/ops-system-channel.js";

/**
 * `WebChannel` + a real customer-plane `matchToParked`. One driver per channel
 * kind per conductor — this REPLACES the bare `WebChannel` in the production
 * conductor's channel set so `channel: "web"` turns get confirm-resume.
 */
export class WebConfirmChannel extends WebChannel {
  override matchToParked(
    channelEvent: ChannelMessage,
    session: Session,
  ): ParkedMatch | null {
    const parked = session.pendingConfirmations;
    if (!parked || parked.length === 0) return null;
    // No freshness partition: customer parks have no TTL (see the header). The
    // default "explicit" affirmative mode is the FE-D32 execute path — only an
    // unambiguous "sim"/"confirmo"/`#hash` CONFIRMs; a mixed refusal keeps the
    // park; a bare soft affirmative resolves to null (the fresh loop runs).
    return matchOpsReplyToParked(channelEvent.text, parked);
  }
}

// ── BKL-212: the customer-web ingress niceties ───────────────────────────────
// `matchToParked` above resolves a bare soft "ok" and (via the conductor's deny
// path) a "não" to OUTCOMES the customer never sees crisply: the soft affirmative
// falls through to a full model turn, and claustrum's deny unparks but then
// re-plans the "no" text as a fresh command (the BKL-191 re-prompt). The OPS
// ingresses already close both at the ingress — a pure-negative unparks +
// acknowledges BEFORE handleTurn, and a bare soft affirmative restates the park —
// and these are the WEB-plane mirrors of those two surfaces.
//
// PARK SELECTION differs from ops by ONE thing, deliberately: there is NO
// freshness partition. A customer park carries no `expiresAt`
// (`opsConfirmParkExpiresAt` stamps ops sessions only), so every pending
// confirmation is live — the same premise `matchToParked` above is built on. Any
// TTL filter here would silently disable the niceties for older parks that the
// matcher itself still resumes, which is exactly the divergence to avoid.
//
// NEITHER surface can EXECUTE: the decline path only unparks, and the restate
// path touches no state at all (the park SURVIVES so a follow-up "sim" still runs
// the normal, fully-adjudicated confirm-resume). The money-safety posture from
// #352 is untouched — a soft affirmative still never executes on web.

/** pt-BR acknowledgment for a park the customer declined (web mirror of
 *  `OPS_NEGATIVE_DECLINE_ACK_PTBR`, customer register). */
export const WEB_NEGATIVE_DECLINE_ACK_PTBR =
  "Ok, não vou fazer isso — nada foi alterado. Se precisar de outra coisa, é só me dizer.";

const WEB_SOFT_AFFIRM_RESTATE_PREFIX_PTBR = "Só confirmando — você quer que eu faça ";
const WEB_SOFT_AFFIRM_RESTATE_SUFFIX_PTBR = '? Responda "sim" para eu seguir.';

/**
 * The park a PURE-NEGATIVE customer reply declines, or `undefined` when this
 * branch must not engage (a `#hash`/defer/affirmative reply, a MIXED reply — the
 * money-safe ambiguous case that keeps the park — or no park at all). The text
 * test is the shared {@link isPureNegativeReplyText}, so this can never disagree
 * with `matchToParked`'s deny resolution. PURE — the caller owns the unpark.
 */
export function webNegativeDeclineTarget(
  text: string,
  pendingConfirmations: ReadonlyArray<ParkedEnvelope> | undefined,
): ParkedEnvelope | undefined {
  if (!pendingConfirmations || pendingConfirmations.length === 0) return undefined;
  if (!isPureNegativeReplyText(text)) return undefined;
  return pickMostRecentlyParked(pendingConfirmations) ?? undefined;
}

/**
 * The pt-BR restatement for a BARE SOFT AFFIRMATIVE ("ok"/"pode"/"beleza") aimed
 * at a parked confirmation, or `undefined` when this branch must not engage (an
 * explicit "sim"/`#hash`/negative/defer — all resolved by the normal loop — a
 * soft affirmative that ALSO carries content ("ok mas muda para 19h" — a new
 * request the loop must answer), an ordinary utterance, or no park at all).
 * Restating is the WHOLE effect: nothing executes and the park survives, so a
 * follow-up "sim" still resumes it through the normal adjudicated path. PURE.
 */
export function webSoftAffirmativeRestateNotice(
  text: string,
  pendingConfirmations: ReadonlyArray<ParkedEnvelope> | undefined,
): string | undefined {
  if (!pendingConfirmations || pendingConfirmations.length === 0) return undefined;
  if (!isSoftAffirmativeOnlyText(text)) return undefined;
  const target = pickMostRecentlyParked(pendingConfirmations);
  if (!target) return undefined;
  return `${WEB_SOFT_AFFIRM_RESTATE_PREFIX_PTBR}"${target.userPrompt}"${WEB_SOFT_AFFIRM_RESTATE_SUFFIX_PTBR}`;
}
