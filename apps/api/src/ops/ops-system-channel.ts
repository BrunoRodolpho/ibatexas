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

import type {
  ChannelMessage,
  ParkedEnvelope,
  ParkedMatch,
  Session,
  SessionPort,
  UserResolution,
} from "@claustrum/core";
import { SystemChannel } from "../claustrum/system-channel.js";

// pt-BR lexicons — word-boundary-anchored so a token never matches inside a
// larger word. Diacritic variants are listed explicitly (staff type both).
//
// FE-D32 — the affirmative lexicon is SPLIT by strength. Only an EXPLICIT confirm
// ("sim"/"confirmo"/… — an unambiguous yes) or a `#hash` may EXECUTE a parked
// money/ops action; a bare conversational SOFT affirmative ("pode"/"ok"/"manda"/…)
// is too weak to execute — the ingress RESTATES the parked action and asks for an
// explicit confirm. The BROAD union (either) is kept for the ambiguity check and
// the expired-park resume DETECTION (which must still recognize a soft "pode" as an
// attempted resume of an already-expired park).
const EXPLICIT_CONFIRM_RE =
  /\b(sim|confirmo|confirmar|confirma|confirmado|aprovo|aprovar|aprovado)\b/i;
const SOFT_AFFIRMATIVE_RE = /\b(pode|ok|okay|isso|claro|manda|beleza)\b/i;
/** BROAD affirmative = explicit confirm OR soft affirmative (the pre-FE-D32 union). */
function hasBroadAffirmative(text: string): boolean {
  return EXPLICIT_CONFIRM_RE.test(text) || SOFT_AFFIRMATIVE_RE.test(text);
}
// NEGATIVE lexicon — refusals ONLY. The bare preposition "para" ("para o jantar",
// "para R$ 89") and the imperative "deixa" ("deixa disponível") were REMOVED: they
// are over-broad and match ordinary FRESH ops commands — including the WS6 guided
// examples ("muda o preço da costela para R$ 89", "avança o pedido 4242 para
// pronto") — so while a money confirmation was parked, an unrelated command
// resolved to `deny` and SILENTLY abandoned the pending park. "pare" (the
// whole-word imperative "stop") stays; real refusals ("não", "cancela(r)",
// "negativo", "nega(r)") stay.
const NEGATIVE_RE =
  /\b(n[ãa]o|cancela|cancelar|cancelado|pare|negativo|nega|negar)\b/i;
// Defer phrases: amanhã / mais tarde / depois / à noite / daqui a N horas|minutos|dias.
const DEFER_RE =
  /(amanh[ãa]|mais tarde|depois|[àa] noite|hoje [àa] noite|daqui a? ?\d+\s*(horas?|minutos?|min|dias?))/i;
const HASH_PREFIX_RE = /#([a-f0-9]{6,12})/i;

/** Most-recently-parked envelope, skipping malformed timestamps (NaN-sticky-bug
 *  guard, mirroring the whatsapp driver). Falls back to the last element when no
 *  entry has a parseable `parkedAt` so a non-empty list always yields a result.
 *
 *  EXPORTED for the CUSTOMER-plane ingresses (BKL-212). Customer parks carry NO
 *  confirm-freshness TTL (`opsConfirmParkExpiresAt` stamps ops sessions only), so
 *  the web plane selects its target with this single-slot rule DIRECTLY, without
 *  the ops freshness partition — exactly as `WebConfirmChannel.matchToParked`
 *  already does via `matchOpsReplyToParked`. */
export function pickMostRecentlyParked(
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

/**
 * Confirm-park freshness TTL, seconds (FE-D13). A bare-affirmative "sim" or a
 * `#hash` reply may resume an ops confirm ONLY while its park is within this
 * window; an older park is invisible to BOTH resume paths (money-safety — a
 * forgotten park must never execute on a later unrelated "sim"; the two live
 * FE-D13 incidents were HOURS-old parks). Default 900s (15 min); a lapsed park is
 * simply re-issued by re-running the command (the ingress restates it honestly —
 * see {@link expiredOpsParkNotice}). Env override `OPS_CONFIRM_PARK_TTL_SECONDS`.
 * Byte-mirrors `getEscalationParkTtlSeconds` (escalation-park-store.ts) per Hard
 * Rule #3 (config from process.env, never hardcoded).
 */
export function getOpsConfirmParkTtlSeconds(): number {
  const raw = process.env.OPS_CONFIRM_PARK_TTL_SECONDS;
  if (!raw) return 900;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n) || n < 1) return 900;
  return n;
}

/**
 * FE-D33 — the confirm-park `expiresAt` for the SessionPort park-write site
 * (claustrum-bootstrap.ts). FORWARD-COMPAT ONLY: nothing upstream READS it today —
 * the {@link partitionOpsParksByFreshness} gate above stays the enforcement point,
 * so stamping this NEVER changes matching semantics. Returns a value ONLY for the
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

/** A park list split by freshness at a reference instant (FE-D13). */
export interface PartitionedOpsParks {
  readonly fresh: ParkedEnvelope[];
  readonly expired: ParkedEnvelope[];
}

/**
 * Split parked confirmations into `{ fresh, expired }` by age at `nowIso`. A park
 * is EXPIRED once `age = Date.parse(nowIso) − Date.parse(park.parkedAt) ≥
 * ttlSeconds*1000`. FAIL-CLOSED: a malformed `parkedAt` OR a malformed `nowIso`
 * ⇒ EXPIRED — deliberately INVERTING {@link pickMostRecentlyParked}'s NaN
 * keep-alive fallback for the EXPIRY decision (a park whose age cannot be
 * established must never stay resumable). Determinism: callers pass the inbound
 * `receivedAt` (never `Date.now()`), so the same message always partitions the
 * same way. PURE — never mutates the input list.
 */
export function partitionOpsParksByFreshness(
  parked: ReadonlyArray<ParkedEnvelope>,
  nowIso: string,
  ttlSeconds: number,
): PartitionedOpsParks {
  const now = Date.parse(nowIso);
  const ttlMs = ttlSeconds * 1000;
  const nowInvalid = !Number.isFinite(now);
  const fresh: ParkedEnvelope[] = [];
  const expired: ParkedEnvelope[] = [];
  for (const park of parked) {
    const parkedAt = Date.parse(park.parkedAt);
    if (nowInvalid || !Number.isFinite(parkedAt) || now - parkedAt >= ttlMs) {
      expired.push(park); // fail-closed on a malformed clock; else aged-out
    } else {
      fresh.push(park);
    }
  }
  return { fresh, expired };
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
 *   3. UNAMBIGUOUS affirmative (an affirmative token, NO negative token) →
 *      `confirm` on the most-recent park.
 *   4. UNAMBIGUOUS negative (a negative token, NO affirmative token) → `deny`.
 *   5. MIXED affirmative + negative — an AMBIGUOUS reply (e.g. a refusal that
 *      merely contains an affirmative word, "não, pode deixar") → `null`
 *      (NEITHER). Money-safety: a parked money action is NEVER executed on a
 *      refusal, and the park is NEVER silently abandoned on ambiguity (`null`
 *      keeps it — the conductor unparks only on `deny`/`defer`). The ingress
 *      surfaces {@link OPS_AMBIGUOUS_REPLY_CLARIFY_PTBR} via
 *      {@link isAmbiguousOpsReply}.
 * No signal ⇒ null (fresh utterance; the normal cognitive loop runs). "sim" with
 * ZERO parks ⇒ null. Defer is checked BEFORE affirmative so "sim, amanhã" defers.
 */
export function matchOpsReplyToParked(
  text: string,
  parked: ReadonlyArray<ParkedEnvelope>,
  // FE-D32 — "explicit" (default): only "sim"/"confirmo"/… or `#hash` CONFIRM (the
  // execute path). "broad": the pre-FE-D32 union incl. soft "pode"/"ok"/… — used
  // ONLY by the expired-park resume DETECTION, which must still recognize a soft
  // affirmative as an attempted resume of an already-expired park.
  affirmativeMode: "explicit" | "broad" = "explicit",
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
  // 3-5. Lexical resolution — MONEY-SAFETY precedence. A confirm requires an
  // UNAMBIGUOUS whole-message yes: an affirmative token AND the ABSENCE of any
  // negative token. A reply carrying BOTH signals — an explicit refusal that
  // merely contains an affirmative word ("não, pode deixar", "ok, cancela") — is
  // AMBIGUOUS and resolves to NEITHER (`null`): the parked money action is never
  // executed on a refusal, and `null` keeps the park (the conductor unparks only
  // on `deny`/`defer`, so the pending confirmation is NOT silently abandoned).
  // AMBIGUITY uses the BROAD lexicon so a soft affirmative MIXED with a refusal
  // ("não, pode deixar", "ok, cancela") is still NEITHER (money-safety — never
  // execute a refusal, keep the park). The CONFIRM branch uses the MODE's lexicon:
  // EXPLICIT for the execute path (a soft affirmative ALONE → null → the ingress
  // restates it, FE-D32), BROAD for the expired-resume detection path.
  const hasBroadAff = hasBroadAffirmative(text);
  const hasConfirmAffirmative =
    affirmativeMode === "broad" ? hasBroadAff : EXPLICIT_CONFIRM_RE.test(text);
  const hasNegative = NEGATIVE_RE.test(text);
  if (hasBroadAff && hasNegative) return null; // ambiguous → keep the park
  if (hasConfirmAffirmative) return { parked: mostRecent, userResolution: "confirm" };
  if (hasNegative) return { parked: mostRecent, userResolution: "deny" };
  return null;
}

/**
 * pt-BR clarification for an AMBIGUOUS parked reply (BKL-085 money-safety). When a
 * money/confirm action is parked and the operator's reply mixes an affirmative AND
 * a negative signal (e.g. "sim, mas não sei"), `matchOpsReplyToParked` resolves it
 * to `null` (NEITHER) — nothing executes and the park is preserved. The ingress
 * shows this line so the operator re-answers unambiguously, rather than letting an
 * unclear reply run the fresh-utterance loop or silently vanish. See
 * {@link isAmbiguousOpsReply}.
 */
export const OPS_AMBIGUOUS_REPLY_CLARIFY_PTBR =
  "Não entendi se é para confirmar ou cancelar. A ação segue pendente — " +
  'responda "sim" para confirmar ou "não" para cancelar.';

/**
 * Does an inbound ops reply mix an affirmative AND a negative signal (with no
 * defer phrase)? Such a reply is AMBIGUOUS about the DECISION, so
 * `matchOpsReplyToParked` deliberately resolves it to `null` (money-safety — never
 * execute a refusal, never silently abandon the park). An ingress SHOULD call this
 * after a `null` match WHILE a confirmation is parked and, when it returns true,
 * reply with {@link OPS_AMBIGUOUS_REPLY_CLARIFY_PTBR} instead of running the
 * fresh-utterance loop. A reply with NEITHER signal is a genuine fresh utterance
 * (not ambiguous) and must run the normal loop unchanged.
 */
export function isAmbiguousOpsReply(text: string): boolean {
  if (typeof text !== "string" || text.length === 0) return false;
  if (DEFER_RE.test(text)) return false; // a defer phrase is a valid resolution
  return hasBroadAffirmative(text) && NEGATIVE_RE.test(text);
}

// ── Plane-neutral reply SHAPES (BKL-212) ─────────────────────────────────────
// The two ingress niceties below (BKL-191 decline, FE-D32 soft restate) each
// decompose into a PURE TEXT question ("what shape is this reply?") and a PARK
// question ("is there a park to act on?"). The park half differs per plane (ops
// partitions by the confirm TTL + kind scope; a CUSTOMER park has neither), but
// the text half is IDENTICAL — same lexicons, same precedence. These two
// predicates ARE that text half, so the ops helpers and the customer-web ingress
// share one definition and can never drift. PURE.

/**
 * Is this reply a PURE NEGATIVE — a refusal and nothing else? True only for a
 * reply that carries a negative token AND no `#hash`, no defer phrase, and no
 * affirmative token of either strength. The exclusions mirror
 * `matchOpsReplyToParked`'s deny resolution exactly: a hash/defer reply is
 * resolved by the normal loop, and a MIXED affirmative+negative ("não, pode
 * deixar") is AMBIGUOUS — money-safety keeps the park rather than declining it.
 */
export function isPureNegativeReplyText(text: string): boolean {
  if (typeof text !== "string" || text.length === 0) return false;
  if (HASH_PREFIX_RE.test(text)) return false;
  if (DEFER_RE.test(text)) return false;
  if (!NEGATIVE_RE.test(text)) return false;
  return !hasBroadAffirmative(text);
}

/**
 * Is this reply SOFT-AFFIRMATIVE-shaped — a conversational "pode"/"ok"/"beleza"
 * and nothing stronger? True only for a reply carrying a soft affirmative token
 * AND no explicit confirm ("sim"/"confirmo"), no `#hash`, no negative, and no
 * defer phrase. Such a reply is too weak to EXECUTE a parked action (FE-D32): an
 * ingress restates the park and asks for an explicit confirm. NOTE this says
 * nothing about the REST of the message — see {@link isSoftAffirmativeOnlyText}.
 */
export function isSoftAffirmativeReplyText(text: string): boolean {
  if (typeof text !== "string" || text.length === 0) return false;
  if (EXPLICIT_CONFIRM_RE.test(text)) return false;
  if (HASH_PREFIX_RE.test(text)) return false;
  if (NEGATIVE_RE.test(text)) return false;
  if (DEFER_RE.test(text)) return false;
  return SOFT_AFFIRMATIVE_RE.test(text);
}

/** Word-ish tokens (Unicode letters/digits), so accents and punctuation are handled. */
const WORD_TOKEN_RE = /[\p{L}\p{N}]+/gu;

/**
 * The STRICTER sibling of {@link isSoftAffirmativeReplyText}: soft-affirmative
 * shaped AND carrying nothing else — every word token in the message is itself a
 * soft-affirmative token ("ok", "ok!", "pode", "beleza"). A reply that says yes
 * AND adds content ("ok mas muda para 19h") is NOT this: the customer issued a
 * NEW request, and answering it with a bare restatement would drop what they
 * asked for, so such a reply belongs to the normal cognitive loop.
 *
 * This is the CUSTOMER-plane admission test (BKL-212). It is strictly NARROWER
 * than the ops FE-D32 rule — deliberately: on the ops plane a staff "ok muda o
 * preço" restating the park is an acceptable prompt for an explicit confirm,
 * whereas silently restating at a customer reads as not having listened. Narrower
 * also means every message it rejects keeps today's exact behaviour.
 */
export function isSoftAffirmativeOnlyText(text: string): boolean {
  if (!isSoftAffirmativeReplyText(text)) return false;
  const tokens = text.match(WORD_TOKEN_RE);
  if (tokens === null) return false;
  return tokens.every((token) => SOFT_AFFIRMATIVE_RE.test(token));
}

// ── FE-D13: honest stale-resume restatement ──────────────────────────────────
// Once the TTL makes a park invisible to matchToParked (above), a later "sim" (or
// #hash, or "não") aimed at that park would otherwise silently run the fresh loop —
// the operator believes their reply resumed the earlier action. These surfaces let
// an ingress state plainly that the pending confirmation EXPIRED and was NOT
// executed, so re-issuing the command re-parks against fresh state. Deterministic
// pt-BR (Hard Rule #4), mirroring OPS_AMBIGUOUS_REPLY_CLARIFY_PTBR.

const EXPIRED_OPS_PARK_NOTICE_PREFIX_PTBR =
  "A confirmação pendente expirou e NÃO foi executada: ";
const EXPIRED_OPS_PARK_NOTICE_SUFFIX_PTBR =
  ". Por segurança, repita o comando se ainda quiser executá-lo.";

/** Build the stale-resume restatement from the park's stored kernel prompt. */
function buildExpiredOpsParkNotice(userPrompt: string): string {
  return `${EXPIRED_OPS_PARK_NOTICE_PREFIX_PTBR}"${userPrompt}"${EXPIRED_OPS_PARK_NOTICE_SUFFIX_PTBR}`;
}

const EMPTY_EXCLUDED_KINDS: ReadonlySet<string> = new Set<string>();

/**
 * If an ops reply signals a resume (affirmative / `#hash` / negative — the SAME
 * lexicon {@link matchOpsReplyToParked} uses) of an EXPIRED park, return the honest
 * pt-BR restatement naming that park's stored kernel prompt; otherwise `undefined`
 * (a no-signal fresh utterance must run the normal loop). Callers pass the
 * ALREADY-expired parks (partitioned at `nowIso` via
 * {@link partitionOpsParksByFreshness}). `nowIso` — the inbound `receivedAt` — is
 * the freshness clock: with NO valid clock we cannot honestly assert expiry, so we
 * stay silent (fail-safe) and let the normal loop run. PURE.
 */
export function expiredOpsParkNotice(
  text: string,
  expiredParks: ReadonlyArray<ParkedEnvelope>,
  nowIso: string,
): string | undefined {
  if (expiredParks.length === 0) return undefined;
  if (!Number.isFinite(Date.parse(nowIso))) return undefined;
  // BROAD detection — a soft "pode" aimed at an EXPIRED park is still an attempted
  // resume the operator must be told expired (FE-D32 keeps the expiry path broad).
  const match = matchOpsReplyToParked(text, expiredParks, "broad");
  if (!match) return undefined;
  return buildExpiredOpsParkNotice(match.parked.userPrompt);
}

/**
 * The ingress orchestrator for the honest stale-resume notice (FE-D13). Given the
 * session's pending confirmations and the inbound `nowIso` (receivedAt), partitions
 * by the confirm-TTL and returns:
 *   - `undefined` when the reply would resume a still-FRESH in-scope park — the
 *     normal loop resumes it (a fresh confirm must WIN over an older expired one,
 *     so an expiry notice never shadows a legitimate fresh "sim");
 *   - else the honest restatement ({@link expiredOpsParkNotice}) when the reply
 *     signals a resume of an EXPIRED in-scope park;
 *   - else `undefined` (an ordinary command → normal loop).
 * `excludedKinds` drops out-of-scope parks (BKL-086 WhatsApp money-verb parity)
 * from BOTH the fresh-precedence check AND the expired set — the ingress must never
 * restate a park it could not resume in the first place (the driver's
 * `scopeResumeChannel` applies the SAME exclusion). PURE; the clock is the inbound
 * receivedAt (never `Date.now()`).
 */
export function opsStaleResumeNotice(input: {
  readonly text: string;
  readonly pendingConfirmations: ReadonlyArray<ParkedEnvelope>;
  readonly nowIso: string;
  readonly excludedKinds?: ReadonlySet<string>;
  readonly ttlSeconds?: number;
}): string | undefined {
  const excluded = input.excludedKinds ?? EMPTY_EXCLUDED_KINDS;
  const ttlSeconds = input.ttlSeconds ?? getOpsConfirmParkTtlSeconds();
  const inScope = input.pendingConfirmations.filter(
    (p) => !excluded.has(String(p.envelope.kind)),
  );
  const { fresh, expired } = partitionOpsParksByFreshness(
    inScope,
    input.nowIso,
    ttlSeconds,
  );
  // A fresh in-scope park the reply resumes takes precedence — never shadow a
  // legitimate fresh confirm (or a fresh soft-affirmative that will RESTATE, FE-D32)
  // with an expiry notice. BROAD so a fresh soft "pode" also suppresses the notice.
  if (matchOpsReplyToParked(input.text, fresh, "broad") !== null) return undefined;
  return expiredOpsParkNotice(input.text, expired, input.nowIso);
}

// ── FE-D32: soft-affirmative restatement ──────────────────────────────────────
// A bare conversational affirmative ("pode"/"ok"/"manda"/"beleza" — NOT "sim"/
// "confirmo"/#hash) aimed at a still-FRESH in-scope money/ops park is too weak to
// EXECUTE the action. Instead the ingress RESTATES the parked action and asks for
// an explicit confirm. Deterministic pt-BR (Hard Rule #4), mirroring the FE-D13
// stale-resume surfaces — but note it does NOT prune/unpark the fresh park (the
// park survives, so a follow-up "sim" executes it).

const SOFT_AFFIRM_RESTATE_PREFIX_PTBR = "Só confirmando — você quer que eu execute ";
const SOFT_AFFIRM_RESTATE_SUFFIX_PTBR =
  '? Responda "sim" ou "confirmo" para eu executar.';

/** Build the soft-affirmative restatement from the park's stored kernel prompt. */
function buildSoftAffirmativeRestateNotice(userPrompt: string): string {
  return `${SOFT_AFFIRM_RESTATE_PREFIX_PTBR}"${userPrompt}"${SOFT_AFFIRM_RESTATE_SUFFIX_PTBR}`;
}

/**
 * FE-D32 — the ingress orchestrator for the soft-affirmative restatement. A bare
 * SOFT affirmative ("pode"/"ok"/"manda"/… — NOT an explicit "sim"/"confirmo" or a
 * `#hash`) aimed at a still-FRESH in-scope park RESTATES that park's stored prompt
 * and asks for an explicit confirm — it never executes and never unparks (the fresh
 * park survives so a later "sim" executes it). Returns the restatement, or
 * `undefined` for: an explicit confirm / `#hash` / negative / defer (resolved by the
 * normal loop), a mixed/ambiguous reply (handled by {@link isAmbiguousOpsReply}), a
 * reply with no fresh in-scope park, or an ordinary command. `excludedKinds` drops
 * out-of-scope parks (BKL-086 parity). PURE; clock = `nowIso` (never `Date.now()`).
 */
export function opsSoftAffirmativeRestateNotice(input: {
  readonly text: string;
  readonly pendingConfirmations: ReadonlyArray<ParkedEnvelope>;
  readonly nowIso: string;
  readonly excludedKinds?: ReadonlySet<string>;
  readonly ttlSeconds?: number;
}): string | undefined {
  if (!Number.isFinite(Date.parse(input.nowIso))) return undefined;
  // Soft-ONLY: anything the normal loop resolves (explicit confirm / #hash /
  // negative / defer) is deferred to it; a non-soft utterance is an ordinary command.
  if (!isSoftAffirmativeReplyText(input.text)) return undefined;

  const excluded = input.excludedKinds ?? EMPTY_EXCLUDED_KINDS;
  const ttlSeconds = input.ttlSeconds ?? getOpsConfirmParkTtlSeconds();
  const inScope = input.pendingConfirmations.filter(
    (p) => !excluded.has(String(p.envelope.kind)),
  );
  const { fresh } = partitionOpsParksByFreshness(inScope, input.nowIso, ttlSeconds);
  const mostRecent = pickMostRecentlyParked(fresh);
  if (!mostRecent) return undefined; // no fresh in-scope park to restate
  return buildSoftAffirmativeRestateNotice(mostRecent.userPrompt);
}

// ── BKL-191: negative declines the park at the INGRESS ───────────────────────
// claustrum's own deny path (handle-turn resolveResume) unparks and then runs the
// "no" text through the NORMAL cognitive loop — where the planner re-reads
// "não, cancela essa ação" as a fresh command and re-proposes/re-parks the same
// action (the live re-prompt w-cal3 observed). The fix is ingress-side: a
// PURE-negative reply aimed at a fresh in-scope park is answered by the ingress
// itself — unpark + acknowledge — and the turn is SKIPPED so the negative text
// never reaches the planner. A staff "no" sticks.

/** pt-BR acknowledgment for a declined park (BKL-191). */
export const OPS_NEGATIVE_DECLINE_ACK_PTBR =
  "Ok, cancelei a ação pendente — nada foi executado.";

/**
 * BKL-191 — the FRESH in-scope park a PURE-NEGATIVE reply declines, or
 * `undefined` when this branch must not engage. Mirrors `matchOpsReplyToParked`'s
 * deny resolution EXACTLY (so the ingress and the matcher can never disagree):
 *   - a `#hash` / defer ("amanhã") / explicit-or-soft affirmative reply →
 *     `undefined` (the normal loop or its own branch resolves those);
 *   - a MIXED reply (broad affirmative + negative, "não, pode deixar") →
 *     `undefined` (ambiguous — money-safety, the park survives and
 *     {@link isAmbiguousOpsReply} clarifies);
 *   - a NEGATIVE with no fresh in-scope park → `undefined` (ordinary utterance).
 * KNOWN TRADEOFF (documented): a decline that ALSO embeds a brand-new command
 * ("não quero, cancela o pedido 42") is swallowed with the acknowledgment — the
 * staff re-sends the command against a clean slate; the alternative (running the
 * loop) is the live re-prompt bug this closes. PURE; clock = `nowIso`.
 */
export function opsNegativeDeclineTarget(input: {
  readonly text: string;
  readonly pendingConfirmations: ReadonlyArray<ParkedEnvelope>;
  readonly nowIso: string;
  readonly excludedKinds?: ReadonlySet<string>;
  readonly ttlSeconds?: number;
}): ParkedEnvelope | undefined {
  if (!Number.isFinite(Date.parse(input.nowIso))) return undefined;
  // Pure-negative ONLY: a hash/defer reply belongs to the normal loop, and a mixed
  // affirmative+negative is AMBIGUOUS (the matcher's null) — never decline.
  if (!isPureNegativeReplyText(input.text)) return undefined;

  const excluded = input.excludedKinds ?? EMPTY_EXCLUDED_KINDS;
  const ttlSeconds = input.ttlSeconds ?? getOpsConfirmParkTtlSeconds();
  const inScope = input.pendingConfirmations.filter(
    (p) => !excluded.has(String(p.envelope.kind)),
  );
  const { fresh } = partitionOpsParksByFreshness(inScope, input.nowIso, ttlSeconds);
  return pickMostRecentlyParked(fresh) ?? undefined;
}

// ── FE-D33: zombie-park pruning ──────────────────────────────────────────────
// An expired park is already inert (invisible to matchToParked), but it lingers in
// the session blob until the 24h/48h Redis TTL lapses. When an ingress surfaces the
// stale-resume notice it is the natural moment to also remove the now-inert EXPIRED
// IN-SCOPE parks, so the blob doesn't accrue zombies. This is pure HYGIENE — the
// partition stays the enforcement point, and pruning failure is non-fatal (the
// caller wraps it; a lingering expired park stays invisible either way).

/**
 * The EXPIRED IN-SCOPE parks in `pendingConfirmations` at `nowIso` — i.e. what an
 * ingress may prune. `excludedKinds` drops out-of-scope parks (BKL-086 parity: a
 * WhatsApp turn must not prune a dashboard-only money park). PURE; same partition +
 * scope filter {@link opsStaleResumeNotice} uses, so the pruned set is EXACTLY the
 * zombies the notice path leaves behind.
 */
export function opsExpiredInScopeParks(input: {
  readonly pendingConfirmations: ReadonlyArray<ParkedEnvelope>;
  readonly nowIso: string;
  readonly excludedKinds?: ReadonlySet<string>;
  readonly ttlSeconds?: number;
}): ParkedEnvelope[] {
  const excluded = input.excludedKinds ?? EMPTY_EXCLUDED_KINDS;
  const ttlSeconds = input.ttlSeconds ?? getOpsConfirmParkTtlSeconds();
  const inScope = input.pendingConfirmations.filter(
    (p) => !excluded.has(String(p.envelope.kind)),
  );
  return partitionOpsParksByFreshness(inScope, input.nowIso, ttlSeconds).expired;
}

/**
 * Prune the EXPIRED IN-SCOPE parks from the session via the SessionPort's `unpark`
 * (the sanctioned durable mutation — the Conductor holds the per-session lock for
 * the whole capsule and re-reads on close, so a prune here sticks). Removes ONLY
 * expired in-scope parks; fresh and out-of-scope parks survive. Returns the pruned
 * set (for logging/tests). Does NOT swallow — the ingress wraps the call so a prune
 * failure is non-fatal to the notice/turn (the expired parks stay inert regardless).
 */
export async function pruneExpiredOpsParks(input: {
  readonly session: Pick<SessionPort, "unpark">;
  readonly sessionId: string;
  readonly pendingConfirmations: ReadonlyArray<ParkedEnvelope>;
  readonly nowIso: string;
  readonly excludedKinds?: ReadonlySet<string>;
  readonly ttlSeconds?: number;
}): Promise<ParkedEnvelope[]> {
  const expired = opsExpiredInScopeParks(input);
  for (const park of expired) {
    await input.session.unpark(input.sessionId, park.envelope.intentHash);
  }
  return expired;
}

/**
 * The ops-plane system channel: SystemChannel VERBATIM plus a REAL pt-BR
 * `matchToParked`. Constructed exactly like SystemChannel (same config), so the
 * bootstrap swap is drop-in.
 *
 * `matchToParked` returns `null` for an AMBIGUOUS reply (mixed affirmative +
 * negative) — money-safety: nothing executes and the park is preserved. To close
 * the "unclear reply while a money action is parked" UX, an ingress that already
 * holds the loaded session SHOULD, on a `null` match with a non-empty
 * `pendingConfirmations`, call {@link isAmbiguousOpsReply} and reply with
 * {@link OPS_AMBIGUOUS_REPLY_CLARIFY_PTBR} rather than running the fresh-utterance
 * loop (the pure ChannelDriver contract cannot emit that clarification itself).
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
