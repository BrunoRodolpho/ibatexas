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
// The matcher MIRRORS the published `@claustrum/channel-whatsapp` parked-match
// (priority: hash-prefix > defer-phrase > affirmative > negative; single-slot
// most-recent-by-parkedAt; NaN-sticky-timestamp guard) but the lexicons are
// pt-BR ONLY (CLAUDE.md rule #4 — the ops channel is staff-facing pt-BR). It is a
// PURE read of `session.pendingConfirmations` and never mutates state (the
// SessionPort owns durable park/unpark). A hash-prefix that matches nothing does
// NOT fall through (the staff was explicit → fresh utterance → null).
//
// Ops parks are STAFF-SESSION-SCOPED as-built: the ops ingress passes
// customerId=`staff:{staffId}`, so the durable park key is
// rk(claustrum:session:system:staff:{staffId}) — a park on one staff session is
// structurally invisible to another (no cross-staff "sim" hazard).

import type {
  ChannelMessage,
  ParkedEnvelope,
  ParkedMatch,
  Session,
  UserResolution,
} from "@claustrum/core";
import { SystemChannel } from "../claustrum/system-channel.js";

// pt-BR lexicons — word-boundary-anchored so a token never matches inside a
// larger word. Diacritic variants are listed explicitly (staff type both).
const AFFIRMATIVE_RE =
  /\b(sim|confirmo|confirmar|confirma|confirmado|pode|ok|okay|isso|claro|aprovo|aprovar|aprovado|manda|beleza)\b/i;
const NEGATIVE_RE =
  /\b(n[ãa]o|cancela|cancelar|cancelado|para|pare|deixa|negativo|nega|negar)\b/i;
// Defer phrases: amanhã / mais tarde / depois / à noite / daqui a N horas|minutos|dias.
const DEFER_RE =
  /(amanh[ãa]|mais tarde|depois|[àa] noite|hoje [àa] noite|daqui a? ?\d+\s*(horas?|minutos?|min|dias?))/i;
const HASH_PREFIX_RE = /#([a-f0-9]{6,12})/i;

/** Most-recently-parked envelope, skipping malformed timestamps (NaN-sticky-bug
 *  guard, mirroring the whatsapp driver). Falls back to the last element when no
 *  entry has a parseable `parkedAt` so a non-empty list always yields a result. */
function pickMostRecentlyParked(
  parked: ReadonlyArray<ParkedEnvelope>,
): ParkedEnvelope | null {
  if (parked.length === 0) return null;
  let best: ParkedEnvelope | undefined;
  let bestTs = -Infinity;
  const fallback = parked[parked.length - 1]!;
  for (const entry of parked) {
    const ts = Date.parse(entry.parkedAt);
    if (!Number.isFinite(ts)) continue;
    if (ts >= bestTs) {
      bestTs = ts;
      best = entry;
    }
  }
  return best ?? fallback;
}

/** Infer the resolution a hash-prefix reply expresses from its surrounding text.
 *  Defer beats negative beats (default) confirm — addressing a park by hash
 *  without an explicit negative/defer is a positive act of attention. */
function inferResolutionFromText(text: string): UserResolution {
  if (DEFER_RE.test(text)) return "defer";
  if (NEGATIVE_RE.test(text)) return "deny";
  return "confirm";
}

/**
 * Match an inbound ops reply to a parked confirmation. PURE — reads only
 * `session.pendingConfirmations`. Priority:
 *   1. `#hash` prefix (6-12 hex) → the park whose intentHash starts with it; a
 *      MISS does NOT fall through (returns null — the staff was explicit).
 *   2. defer-phrase (pt-BR) → `defer` on the most-recent park (carries the phrase).
 *   3. affirmative (pt-BR) → `confirm` on the most-recent park.
 *   4. negative (pt-BR) → `deny` on the most-recent park.
 * No signal ⇒ null (fresh utterance; the normal cognitive loop runs). "sim" with
 * ZERO parks ⇒ null. Defer is checked BEFORE affirmative so "sim, amanhã" defers.
 */
export function matchOpsReplyToParked(
  text: string,
  parked: ReadonlyArray<ParkedEnvelope>,
): ParkedMatch | null {
  if (typeof text !== "string" || text.length === 0) return null;
  if (!parked || parked.length === 0) return null;

  // 1. Hash-prefix probe — most explicit.
  const hashMatch = text.match(HASH_PREFIX_RE);
  const hashGroup = hashMatch?.[1];
  if (hashGroup !== undefined) {
    const prefix = hashGroup.toLowerCase();
    const hit = parked.find((p) =>
      p.envelope.intentHash.toLowerCase().startsWith(prefix),
    );
    if (hit) {
      return { parked: hit, userResolution: inferResolutionFromText(text) };
    }
    // Explicit hash that matches nothing parked ⇒ fresh utterance, NO fall-through.
    return null;
  }

  const mostRecent = pickMostRecentlyParked(parked);
  if (!mostRecent) return null;

  // 2. Defer before affirmative — "sim, amanhã" is a defer, not an immediate confirm.
  const deferMatch = text.match(DEFER_RE);
  if (deferMatch) {
    return {
      parked: mostRecent,
      userResolution: "defer",
      deferPhrase: deferMatch[0],
    };
  }
  if (AFFIRMATIVE_RE.test(text)) {
    return { parked: mostRecent, userResolution: "confirm" };
  }
  if (NEGATIVE_RE.test(text)) {
    return { parked: mostRecent, userResolution: "deny" };
  }
  return null;
}

/**
 * The ops-plane system channel: SystemChannel VERBATIM plus a REAL pt-BR
 * `matchToParked`. Constructed exactly like SystemChannel (same config), so the
 * bootstrap swap is drop-in.
 */
export class OpsSystemChannel extends SystemChannel {
  override matchToParked(
    channelEvent: ChannelMessage,
    session: Session,
  ): ParkedMatch | null {
    return matchOpsReplyToParked(channelEvent.text, session.pendingConfirmations);
  }
}
