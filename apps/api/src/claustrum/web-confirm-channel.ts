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

import type { ChannelMessage, ParkedMatch, Session } from "@claustrum/core";
import { WebChannel } from "@claustrum/channel-web";
import { matchOpsReplyToParked } from "./park-reply-triage.js";

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
// R4-S1 — both selectors, their pt-BR copy, and the whole triage sequence they
// belong to now live in ./park-reply-triage.ts as the CUSTOMER plane policy
// (`customerParkTriagePolicy`, declared by BOTH customer surfaces since the
// 2026-08-04 mandate wired routes/whatsapp-webhook.ts): no freshness partition,
// the narrower soft-affirmative-ONLY admission, customer-register copy. The two
// names below are
// re-exported unchanged so routes/chat.ts and this driver's suite keep importing
// from here; routes/chat.ts consumes the VERDICT (`triageParkReply`) directly.
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

export {
  webNegativeDeclineTarget,
  webSoftAffirmativeRestateNotice,
  WEB_NEGATIVE_DECLINE_ACK_PTBR,
} from "./park-reply-triage.js";
