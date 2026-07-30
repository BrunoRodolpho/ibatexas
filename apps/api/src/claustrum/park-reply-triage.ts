// park-reply-triage.ts — the ONE owner of "what does this inbound reply mean while
// a confirmation is parked?" (R4-S1).
//
// Before this module the triage sequence was hand-copied at three ingresses
// (ops-whatsapp-ingress.ts, routes/admin/ops-chat.ts, routes/chat.ts) with no
// owning seam: the same four-step decision, the same helper call sites, the same
// ordering comments restated at each copy. The DECISION now lives here once and
// each ingress consumes a VERDICT; what stays at the ingress is the genuinely
// per-channel work (delivery, healing, HTTP codes, history append, logging) and
// the store handle that executes the unparks this module names.
//
// ── THE ORDERING INVARIANT (documented ONCE, here) ──────────────────────────
// A park-bearing turn is triaged in exactly this order, first match wins:
//   1. STALE-RESUME — the reply signals a resume of an EXPIRED in-scope park:
//      restate honestly that it expired and was NOT executed, and name the
//      now-inert zombies to prune. A still-FRESH in-scope park the reply resumes
//      takes precedence (a legitimate fresh confirm is never shadowed by an
//      expiry notice). TTL-bearing planes only.
//   2. SOFT-AFFIRMATIVE RESTATE — a bare conversational yes ("pode"/"ok") aimed
//      at a still-FRESH park is too weak to EXECUTE: restate the parked prompt
//      and ask for an explicit "sim". Nothing is unparked — the park SURVIVES so
//      a follow-up "sim" executes it through the normal adjudicated path.
//   3. NEGATIVE DECLINE — a PURE-negative reply on a fresh in-scope park declines
//      it: unpark + acknowledge, and the turn is SKIPPED so the negative text
//      never reaches the planner (claustrum's own deny path unparks and THEN
//      re-plans the "no" as a fresh command — the BKL-191 re-prompt).
//   4. otherwise PROCEED-WITH-TURN — the normal cognitive loop runs unchanged.
// Steps 1-3 SKIP the turn, so no turn_trace/intent_audit row is written; the
// ingress is expected to emit the verdict's structured event for forensics.
//
// ── THE FAIL-HONEST UNPARK CONTRACT ────────────────────────────────────────
// This module is PURE: it never touches the store. A `skip-with-reply` verdict
// names the parks to `unpark` (the decline target) and to `prune` (stale
// zombies); the INGRESS executes them because it owns the session handle.
//   - `unpark` is LOAD-BEARING: the acknowledgment asserts the pending action was
//     cancelled, so it must not be sent unless the unpark STUCK. If the unpark
//     fails (or no session is loaded), the ingress reports the failure and falls
//     through to PROCEED-WITH-TURN semantics — claustrum's own deny path still
//     unparks there — rather than claiming a cancellation that did not stick.
//   - `prune` is pure HYGIENE: the freshness partition is the enforcement point,
//     so an expired park stays inert whether or not it is pruned. A prune failure
//     is non-fatal and the notice is still delivered.
//
// ── PLANE POLICY (declared adapter config) ─────────────────────────────────
// Two planes exist today; each ingress declares one (see the two builders below):
//   - OPS ({@link opsParkTriagePolicy}) — confirm-TTL freshness partitioning,
//     verb-scope kind exclusion, the stale-resume branch, ops staff-facing pt-BR
//     copy. The WhatsApp surface additionally passes `excludedKindsForScope
//     ("whatsapp")` so it never restates or prunes a dashboard-only money park.
//   - WEB-CUSTOMER ({@link webCustomerParkTriagePolicy}) — no TTL (customer parks
//     carry no `expiresAt`, so every pending confirmation is live), hence no
//     stale branch and no kind exclusion, and customer-register pt-BR copy.
// The soft-affirmative ADMISSION rule is a per-plane knob and differs BY DESIGN:
// ops admits a soft-affirmative-SHAPED reply, web only a soft-affirmative-ONLY
// one (on the ops plane a staff "ok muda o preço" restating the park is an
// acceptable prompt for an explicit confirm, whereas silently restating at a
// customer reads as not having listened — see routes/chat.ts:449-451).
//
// NOT WIRED — customer WhatsApp (routes/whatsapp-webhook.ts) runs its turn with
// NO triage at all: a customer "não" on a parked confirmation still reaches the
// planner (the BKL-191 re-prompt class). That plane's driver confirms on a bare
// "ok" BY DESIGN, so wiring it is a behaviour change and an OWNER decision, not a
// refactor. The opt-out is recorded at that ingress's turn entry.

import type {
  ParkedEnvelope,
  ParkedMatch,
  SessionPort,
  UserResolution,
} from "@claustrum/core";

// ── pt-BR reply lexicons ─────────────────────────────────────────────────────
// Word-boundary-anchored so a token never matches inside a larger word.
// Diacritic variants are listed explicitly (staff and customers type both).
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
 *  Plane-neutral: customer parks carry NO confirm-freshness TTL
 *  (`opsConfirmParkExpiresAt` stamps ops sessions only), so the web plane selects
 *  its target with this single-slot rule DIRECTLY, without the ops freshness
 *  partition — exactly as `WebConfirmChannel.matchToParked` already does via
 *  {@link matchOpsReplyToParked}. */
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
 *      surfaces `OPS_AMBIGUOUS_REPLY_CLARIFY_PTBR` via {@link isAmbiguousOpsReply}.
 * No signal ⇒ null (fresh utterance; the normal cognitive loop runs). "sim" with
 * ZERO parks ⇒ null. Defer is checked BEFORE affirmative so "sim, amanhã" defers.
 *
 * Plane-neutral: the lexicon is customer-identical, so both ChannelDrivers
 * (`OpsSystemChannel`, `WebConfirmChannel`) resolve replies through this one
 * matcher and can never drift.
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
 * Does an inbound ops reply mix an affirmative AND a negative signal (with no
 * defer phrase)? Such a reply is AMBIGUOUS about the DECISION, so
 * {@link matchOpsReplyToParked} deliberately resolves it to `null` (money-safety —
 * never execute a refusal, never silently abandon the park). An ingress SHOULD call
 * this after a `null` match WHILE a confirmation is parked and, when it returns
 * true, reply with `OPS_AMBIGUOUS_REPLY_CLARIFY_PTBR` (ops-system-channel.ts)
 * instead of running the fresh-utterance loop. A reply with NEITHER signal is a
 * genuine fresh utterance (not ambiguous) and must run the normal loop unchanged.
 */
export function isAmbiguousOpsReply(text: string): boolean {
  if (typeof text !== "string" || text.length === 0) return false;
  if (DEFER_RE.test(text)) return false; // a defer phrase is a valid resolution
  return hasBroadAffirmative(text) && NEGATIVE_RE.test(text);
}

// ── Plane-neutral reply SHAPES (BKL-212) ─────────────────────────────────────
// The two ingress niceties (BKL-191 decline, FE-D32 soft restate) each decompose
// into a PURE TEXT question ("what shape is this reply?") and a PARK question
// ("is there a park to act on?"). The park half differs per plane (ops partitions
// by the confirm TTL + kind scope; a CUSTOMER park has neither), but the text
// half is IDENTICAL — same lexicons, same precedence. These predicates ARE that
// text half, so every plane shares one definition and they can never drift. PURE.

/**
 * Is this reply a PURE NEGATIVE — a refusal and nothing else? True only for a
 * reply that carries a negative token AND no `#hash`, no defer phrase, and no
 * affirmative token of either strength. The exclusions mirror
 * {@link matchOpsReplyToParked}'s deny resolution exactly: a hash/defer reply is
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

// ── Plane copy (deterministic pt-BR, Hard Rule #4) ───────────────────────────

const EXPIRED_OPS_PARK_NOTICE_PREFIX_PTBR =
  "A confirmação pendente expirou e NÃO foi executada: ";
const EXPIRED_OPS_PARK_NOTICE_SUFFIX_PTBR =
  ". Por segurança, repita o comando se ainda quiser executá-lo.";

/** Build the stale-resume restatement from the park's stored kernel prompt. */
function buildExpiredOpsParkNotice(userPrompt: string): string {
  return `${EXPIRED_OPS_PARK_NOTICE_PREFIX_PTBR}"${userPrompt}"${EXPIRED_OPS_PARK_NOTICE_SUFFIX_PTBR}`;
}

const SOFT_AFFIRM_RESTATE_PREFIX_PTBR = "Só confirmando — você quer que eu execute ";
const SOFT_AFFIRM_RESTATE_SUFFIX_PTBR =
  '? Responda "sim" ou "confirmo" para eu executar.';

/** Build the ops soft-affirmative restatement from the park's stored prompt. */
function buildSoftAffirmativeRestateNotice(userPrompt: string): string {
  return `${SOFT_AFFIRM_RESTATE_PREFIX_PTBR}"${userPrompt}"${SOFT_AFFIRM_RESTATE_SUFFIX_PTBR}`;
}

/** pt-BR acknowledgment for a declined ops park (BKL-191). */
export const OPS_NEGATIVE_DECLINE_ACK_PTBR =
  "Ok, cancelei a ação pendente — nada foi executado.";

/** pt-BR acknowledgment for a park the customer declined (web mirror of
 *  {@link OPS_NEGATIVE_DECLINE_ACK_PTBR}, customer register). */
export const WEB_NEGATIVE_DECLINE_ACK_PTBR =
  "Ok, não vou fazer isso — nada foi alterado. Se precisar de outra coisa, é só me dizer.";

const WEB_SOFT_AFFIRM_RESTATE_PREFIX_PTBR = "Só confirmando — você quer que eu faça ";
const WEB_SOFT_AFFIRM_RESTATE_SUFFIX_PTBR = '? Responda "sim" para eu seguir.';

/** Build the customer-web soft-affirmative restatement from the park's prompt. */
function buildWebSoftAffirmativeRestateNotice(userPrompt: string): string {
  return `${WEB_SOFT_AFFIRM_RESTATE_PREFIX_PTBR}"${userPrompt}"${WEB_SOFT_AFFIRM_RESTATE_SUFFIX_PTBR}`;
}

// ── Plane policy ─────────────────────────────────────────────────────────────

/** The deterministic pt-BR surfaces a plane speaks (Hard Rule #4). */
export interface ParkTriageCopy {
  /** Stale-resume restatement, from the expired park's stored kernel prompt. Only
   *  a TTL-bearing plane has one — a plane whose parks never expire has no honest
   *  expiry to assert, so it declares none and the stale branch cannot run. */
  readonly staleResumeNotice?: (userPrompt: string) => string;
  /** Soft-affirmative restatement, from the fresh park's stored kernel prompt. */
  readonly softAffirmativeRestate: (userPrompt: string) => string;
  /** Fixed acknowledgment for a declined park. */
  readonly negativeDeclineAck: string;
}

/**
 * How one plane triages a park-bearing reply. Declared adapter config — the
 * decision logic below is plane-neutral and reads EVERY plane difference from
 * here, so a new surface is a policy, never another copy of the sequence.
 */
export interface ParkTriagePolicy {
  /**
   * Park freshness. `confirm-ttl` partitions by age (the ops confirm-park TTL —
   * an aged-out park is invisible to resume and eligible for the stale branch);
   * `none` treats every pending confirmation as live (customer parks carry no
   * `expiresAt`, so there is nothing to partition and no honest expiry to
   * assert). A `none` plane has NO clock dependency at all.
   */
  readonly freshness:
    | { readonly kind: "confirm-ttl"; readonly ttlSeconds: number }
    | { readonly kind: "none" };
  /** Intent kinds dropped from EVERY park read (the ops verb-scope exclusion —
   *  a WhatsApp turn must never restate or prune a dashboard-only money park). */
  readonly excludedKinds: ReadonlySet<string>;
  /** Does this plane run the stale-resume branch? Only a `confirm-ttl` plane that
   *  declares {@link ParkTriageCopy.staleResumeNotice} can; both are checked. */
  readonly staleResume: boolean;
  /**
   * Which soft-affirmative replies are admitted for the restate branch. Differs
   * BY DESIGN — `soft-shaped` (ops) admits "ok muda o preço"; `soft-only` (web
   * customer) admits only a bare "ok"/"pode"/"beleza", because restating at a
   * customer who added a NEW request reads as not having listened.
   */
  readonly softAffirmativeAdmission: "soft-shaped" | "soft-only";
  readonly copy: ParkTriageCopy;
  /** Structured-event namespace for this SURFACE (`ops_wa` / `ops_chat` / `chat`). */
  readonly eventPrefix: string;
}

const EMPTY_EXCLUDED_KINDS: ReadonlySet<string> = new Set<string>();

/** The web-customer plane has NO freshness clock (no TTL to compare against), so
 *  its two named selectors take no `nowIso`; the branches never read the clock
 *  under a `none`-freshness policy, and this placeholder makes that explicit at
 *  the call site instead of threading a value nothing can use. */
const WEB_CLOCKLESS_NOW = "";

/**
 * The OPS plane policy: confirm-TTL freshness, verb-scope exclusion, the
 * stale-resume branch, and staff-facing pt-BR copy. `excludedKinds` is the
 * WhatsApp surface's `excludedKindsForScope("whatsapp")` (the dashboard passes
 * none); `ttlSeconds` defaults to {@link getOpsConfirmParkTtlSeconds} — read at
 * CALL time, so an env override applies per turn.
 */
export function opsParkTriagePolicy(input?: {
  readonly excludedKinds?: ReadonlySet<string>;
  readonly ttlSeconds?: number;
  readonly eventPrefix?: string;
}): ParkTriagePolicy {
  return {
    freshness: {
      kind: "confirm-ttl",
      ttlSeconds: input?.ttlSeconds ?? getOpsConfirmParkTtlSeconds(),
    },
    excludedKinds: input?.excludedKinds ?? EMPTY_EXCLUDED_KINDS,
    staleResume: true,
    softAffirmativeAdmission: "soft-shaped",
    copy: {
      staleResumeNotice: buildExpiredOpsParkNotice,
      softAffirmativeRestate: buildSoftAffirmativeRestateNotice,
      negativeDeclineAck: OPS_NEGATIVE_DECLINE_ACK_PTBR,
    },
    eventPrefix: input?.eventPrefix ?? "ops",
  };
}

/**
 * The WEB-CUSTOMER plane policy: no TTL (hence no stale branch), no kind
 * exclusion, the narrower soft-affirmative-ONLY admission, and customer-register
 * pt-BR copy. Customer parks carry no `expiresAt`
 * (`opsConfirmParkExpiresAt` stamps ops sessions only), so every pending
 * confirmation is live — the same premise `WebConfirmChannel.matchToParked` is
 * built on. A TTL filter here would silently disable the niceties for older parks
 * the matcher itself still resumes, which is exactly the divergence to avoid.
 */
export function webCustomerParkTriagePolicy(input?: {
  readonly eventPrefix?: string;
}): ParkTriagePolicy {
  return {
    freshness: { kind: "none" },
    excludedKinds: EMPTY_EXCLUDED_KINDS,
    staleResume: false,
    softAffirmativeAdmission: "soft-only",
    copy: {
      softAffirmativeRestate: buildWebSoftAffirmativeRestateNotice,
      negativeDeclineAck: WEB_NEGATIVE_DECLINE_ACK_PTBR,
    },
    eventPrefix: input?.eventPrefix ?? "chat",
  };
}

// ── The plane-neutral park reads ─────────────────────────────────────────────

/** Drop out-of-scope kinds (BKL-086 parity). Order-preserving, PURE. */
function inScopeParks(
  pending: ReadonlyArray<ParkedEnvelope>,
  policy: ParkTriagePolicy,
): ParkedEnvelope[] {
  return pending.filter((p) => !policy.excludedKinds.has(String(p.envelope.kind)));
}

/** The in-scope parks a reply may still act on. A `none`-freshness plane has no
 *  partition (every pending confirmation is live). PURE. */
function freshInScopeParks(
  pending: ReadonlyArray<ParkedEnvelope>,
  nowIso: string,
  policy: ParkTriagePolicy,
): ParkedEnvelope[] {
  const inScope = inScopeParks(pending, policy);
  if (policy.freshness.kind === "none") return inScope;
  return partitionOpsParksByFreshness(inScope, nowIso, policy.freshness.ttlSeconds)
    .fresh;
}

/** Does this plane's decision depend on a parseable clock? Only a TTL plane's
 *  does — with no valid clock it cannot honestly place a park on either side of
 *  the window, so the FRESH-park branches stay silent (fail-safe). */
function needsClock(policy: ParkTriagePolicy): boolean {
  return policy.freshness.kind === "confirm-ttl";
}

// ── The three triage branches (plane-neutral, policy-driven) ─────────────────

/**
 * If a reply signals a resume (affirmative / `#hash` / negative — the SAME
 * lexicon {@link matchOpsReplyToParked} uses) of an EXPIRED park, the honest pt-BR
 * restatement naming that park's stored kernel prompt; otherwise `undefined`.
 * `nowIso` — the inbound `receivedAt` — is the freshness clock: with NO valid
 * clock we cannot honestly assert expiry, so we stay silent (fail-safe) and let
 * the normal loop run. PURE.
 */
function expiredParkNotice(
  text: string,
  expiredParks: ReadonlyArray<ParkedEnvelope>,
  nowIso: string,
  render: (userPrompt: string) => string,
): string | undefined {
  if (expiredParks.length === 0) return undefined;
  if (!Number.isFinite(Date.parse(nowIso))) return undefined;
  // BROAD detection — a soft "pode" aimed at an EXPIRED park is still an attempted
  // resume the operator must be told expired (FE-D32 keeps the expiry path broad).
  const match = matchOpsReplyToParked(text, expiredParks, "broad");
  if (!match) return undefined;
  return render(match.parked.userPrompt);
}

/** Branch 1 — the stale-resume notice (see the ORDERING INVARIANT header). */
function staleResumeBranch(
  text: string,
  pending: ReadonlyArray<ParkedEnvelope>,
  nowIso: string,
  policy: ParkTriagePolicy,
): string | undefined {
  const render = policy.copy.staleResumeNotice;
  if (!policy.staleResume || policy.freshness.kind === "none" || !render) {
    return undefined;
  }
  const { fresh, expired } = partitionOpsParksByFreshness(
    inScopeParks(pending, policy),
    nowIso,
    policy.freshness.ttlSeconds,
  );
  // A fresh in-scope park the reply resumes takes precedence — never shadow a
  // legitimate fresh confirm (or a fresh soft-affirmative that will RESTATE, FE-D32)
  // with an expiry notice. BROAD so a fresh soft "pode" also suppresses the notice.
  if (matchOpsReplyToParked(text, fresh, "broad") !== null) return undefined;
  return expiredParkNotice(text, expired, nowIso, render);
}

/** Branch 2 — the soft-affirmative restatement (see the ORDERING INVARIANT). */
function softAffirmativeRestateBranch(
  text: string,
  pending: ReadonlyArray<ParkedEnvelope>,
  nowIso: string,
  policy: ParkTriagePolicy,
): string | undefined {
  if (needsClock(policy) && !Number.isFinite(Date.parse(nowIso))) return undefined;
  // Soft-ONLY: anything the normal loop resolves (explicit confirm / #hash /
  // negative / defer) is deferred to it; a non-soft utterance is an ordinary command.
  const admits =
    policy.softAffirmativeAdmission === "soft-only"
      ? isSoftAffirmativeOnlyText
      : isSoftAffirmativeReplyText;
  if (!admits(text)) return undefined;
  const target = pickMostRecentlyParked(freshInScopeParks(pending, nowIso, policy));
  if (!target) return undefined; // no live in-scope park to restate
  return policy.copy.softAffirmativeRestate(target.userPrompt);
}

/** Branch 3 — the park a PURE-NEGATIVE reply declines (see the ORDERING INVARIANT).
 *  Mirrors {@link matchOpsReplyToParked}'s deny resolution EXACTLY, so the ingress
 *  and the matcher can never disagree:
 *    - a `#hash` / defer ("amanhã") / explicit-or-soft affirmative reply →
 *      `undefined` (the normal loop or an earlier branch resolves those);
 *    - a MIXED reply (broad affirmative + negative, "não, pode deixar") →
 *      `undefined` (ambiguous — money-safety, the park survives and
 *      {@link isAmbiguousOpsReply} clarifies);
 *    - a NEGATIVE with no live in-scope park → `undefined` (ordinary utterance).
 *  KNOWN TRADEOFF (documented): a decline that ALSO embeds a brand-new command
 *  ("não quero, cancela o pedido 42") is swallowed with the acknowledgment — the
 *  sender re-sends the command against a clean slate; the alternative (running the
 *  loop) is the live re-prompt bug this closes. PURE; clock = `nowIso`. */
function negativeDeclineBranch(
  text: string,
  pending: ReadonlyArray<ParkedEnvelope>,
  nowIso: string,
  policy: ParkTriagePolicy,
): ParkedEnvelope | undefined {
  if (needsClock(policy) && !Number.isFinite(Date.parse(nowIso))) return undefined;
  // Pure-negative ONLY: a hash/defer reply belongs to the normal loop, and a mixed
  // affirmative+negative is AMBIGUOUS (the matcher's null) — never decline.
  if (!isPureNegativeReplyText(text)) return undefined;
  return pickMostRecentlyParked(freshInScopeParks(pending, nowIso, policy)) ?? undefined;
}

/** The EXPIRED in-scope parks at `nowIso` — the zombies the stale branch leaves
 *  behind (FE-D33). A `none`-freshness plane has none by construction. PURE. */
function expiredInScopeParks(
  pending: ReadonlyArray<ParkedEnvelope>,
  nowIso: string,
  policy: ParkTriagePolicy,
): ParkedEnvelope[] {
  if (policy.freshness.kind === "none") return [];
  return partitionOpsParksByFreshness(
    inScopeParks(pending, policy),
    nowIso,
    policy.freshness.ttlSeconds,
  ).expired;
}

// ── The VERDICT ──────────────────────────────────────────────────────────────

/** Which triage branch answered the reply (the ORDERING INVARIANT's step). */
export type ParkTriageBranch =
  | "stale-resume"
  | "soft-affirmative-restate"
  | "negative-decline";

/** Structured-event suffix per branch — the ingress emits `<prefix>.<suffix>`. */
const PARK_TRIAGE_EVENT_SUFFIX: Readonly<Record<ParkTriageBranch, string>> = {
  "stale-resume": "stale_park_notice",
  "soft-affirmative-restate": "soft_affirm_restate",
  "negative-decline": "negative_declined_park",
};

/**
 * What an ingress must do with a park-bearing reply. `proceed-with-turn` ⇒ run
 * the normal cognitive loop unchanged. `skip-with-reply` ⇒ deliver `notice`
 * instead of running the turn, after executing the named store mutations (see
 * THE FAIL-HONEST UNPARK CONTRACT in the module header).
 */
export type ParkTriageVerdict =
  | { readonly kind: "proceed-with-turn" }
  | {
      readonly kind: "skip-with-reply";
      /** Which branch answered — the ingress keys its per-surface reporting on this. */
      readonly branch: ParkTriageBranch;
      /** This surface's structured event tag, `<eventPrefix>.<branch suffix>`. */
      readonly event: string;
      /** The deterministic pt-BR reply to deliver (never model prose). */
      readonly notice: string;
      /** Parks the ingress MUST unpark for `notice` to be true. A failure means
       *  fall through to `proceed-with-turn` semantics — never send `notice`. */
      readonly unpark: ReadonlyArray<ParkedEnvelope>;
      /** Now-inert zombies to prune (hygiene). A failure is non-fatal. */
      readonly prune: ReadonlyArray<ParkedEnvelope>;
    };

const PROCEED: ParkTriageVerdict = { kind: "proceed-with-turn" };

/**
 * Triage one inbound reply against the session's parked confirmations. PURE — the
 * single decision every ingress consumes. Branch order, the per-plane knobs, and
 * the fail-honest unpark contract are documented ONCE in the module header.
 *
 * `nowIso` MUST be the inbound `receivedAt` (never `Date.now()`), so the same
 * message always triages the same way.
 */
export function triageParkReply(input: {
  readonly text: string;
  readonly pendingConfirmations: ReadonlyArray<ParkedEnvelope> | undefined;
  readonly nowIso: string;
  readonly policy: ParkTriagePolicy;
}): ParkTriageVerdict {
  const { text, nowIso, policy } = input;
  const pending = input.pendingConfirmations ?? [];
  if (pending.length === 0) return PROCEED;

  const tag = (branch: ParkTriageBranch): string =>
    `${policy.eventPrefix}.${PARK_TRIAGE_EVENT_SUFFIX[branch]}`;

  // 1. STALE-RESUME — restate the expiry and name the zombies to prune.
  const stale = staleResumeBranch(text, pending, nowIso, policy);
  if (stale !== undefined) {
    return {
      kind: "skip-with-reply",
      branch: "stale-resume",
      event: tag("stale-resume"),
      notice: stale,
      unpark: [],
      prune: expiredInScopeParks(pending, nowIso, policy),
    };
  }

  // 2. SOFT-AFFIRMATIVE RESTATE — the park SURVIVES (nothing to unpark or prune).
  const restate = softAffirmativeRestateBranch(text, pending, nowIso, policy);
  if (restate !== undefined) {
    return {
      kind: "skip-with-reply",
      branch: "soft-affirmative-restate",
      event: tag("soft-affirmative-restate"),
      notice: restate,
      unpark: [],
      prune: [],
    };
  }

  // 3. NEGATIVE DECLINE — the acknowledgment is only true if the unpark sticks.
  const declined = negativeDeclineBranch(text, pending, nowIso, policy);
  if (declined !== undefined) {
    return {
      kind: "skip-with-reply",
      branch: "negative-decline",
      event: tag("negative-decline"),
      notice: policy.copy.negativeDeclineAck,
      unpark: [declined],
      prune: [],
    };
  }

  return PROCEED;
}

/**
 * Execute the unparks a verdict names, in order, via the SessionPort's `unpark`
 * (the sanctioned durable mutation — the Conductor holds the per-session lock for
 * the whole capsule and re-reads on close, so an unpark here sticks). Returns the
 * parks it removed. Does NOT swallow: the INGRESS decides what a failure means
 * (fatal for `unpark`, non-fatal for `prune` — see the module header).
 */
export async function unparkParks(input: {
  readonly session: Pick<SessionPort, "unpark">;
  readonly sessionId: string;
  readonly parks: ReadonlyArray<ParkedEnvelope>;
}): Promise<ParkedEnvelope[]> {
  for (const park of input.parks) {
    await input.session.unpark(input.sessionId, park.envelope.intentHash);
  }
  return [...input.parks];
}

// ── Named per-plane surfaces (the pre-R4-S1 API, now thin adapters) ──────────
// These are the exact signatures the ops helpers and the web-confirm selectors
// carried before the extraction. They are kept so their existing unit suites keep
// asserting the moved logic verbatim, and so nothing outside this slice changes
// its imports; each is a policy + one branch, with no logic of its own.

/**
 * FE-D13 — the ops stale-resume notice. Returns `undefined` when the reply would
 * resume a still-FRESH in-scope park (the normal loop resumes it), else the honest
 * restatement when the reply signals a resume of an EXPIRED in-scope park, else
 * `undefined` (an ordinary command → normal loop). `excludedKinds` drops
 * out-of-scope parks (BKL-086 WhatsApp money-verb parity) from BOTH the
 * fresh-precedence check AND the expired set. PURE.
 */
export function opsStaleResumeNotice(input: {
  readonly text: string;
  readonly pendingConfirmations: ReadonlyArray<ParkedEnvelope>;
  readonly nowIso: string;
  readonly excludedKinds?: ReadonlySet<string>;
  readonly ttlSeconds?: number;
}): string | undefined {
  return staleResumeBranch(
    input.text,
    input.pendingConfirmations,
    input.nowIso,
    opsPolicyFrom(input),
  );
}

/**
 * FE-D32 — the ops soft-affirmative restatement. A bare SOFT affirmative
 * ("pode"/"ok"/"manda"/… — NOT an explicit "sim"/"confirmo" or a `#hash`) aimed at
 * a still-FRESH in-scope park restates that park's stored prompt and asks for an
 * explicit confirm; it never executes and never unparks. PURE.
 */
export function opsSoftAffirmativeRestateNotice(input: {
  readonly text: string;
  readonly pendingConfirmations: ReadonlyArray<ParkedEnvelope>;
  readonly nowIso: string;
  readonly excludedKinds?: ReadonlySet<string>;
  readonly ttlSeconds?: number;
}): string | undefined {
  return softAffirmativeRestateBranch(
    input.text,
    input.pendingConfirmations,
    input.nowIso,
    opsPolicyFrom(input),
  );
}

/** BKL-191 — the FRESH in-scope ops park a PURE-NEGATIVE reply declines, or
 *  `undefined` when this branch must not engage. PURE; the caller owns the unpark. */
export function opsNegativeDeclineTarget(input: {
  readonly text: string;
  readonly pendingConfirmations: ReadonlyArray<ParkedEnvelope>;
  readonly nowIso: string;
  readonly excludedKinds?: ReadonlySet<string>;
  readonly ttlSeconds?: number;
}): ParkedEnvelope | undefined {
  return negativeDeclineBranch(
    input.text,
    input.pendingConfirmations,
    input.nowIso,
    opsPolicyFrom(input),
  );
}

/**
 * FE-D33 — the EXPIRED IN-SCOPE ops parks at `nowIso`, i.e. what an ingress may
 * prune. `excludedKinds` drops out-of-scope parks (BKL-086 parity: a WhatsApp turn
 * must not prune a dashboard-only money park). PURE; the same partition + scope
 * filter {@link opsStaleResumeNotice} uses, so the pruned set is EXACTLY the
 * zombies the notice path leaves behind.
 */
export function opsExpiredInScopeParks(input: {
  readonly pendingConfirmations: ReadonlyArray<ParkedEnvelope>;
  readonly nowIso: string;
  readonly excludedKinds?: ReadonlySet<string>;
  readonly ttlSeconds?: number;
}): ParkedEnvelope[] {
  return expiredInScopeParks(
    input.pendingConfirmations,
    input.nowIso,
    opsPolicyFrom(input),
  );
}

/**
 * FE-D33 — prune the EXPIRED IN-SCOPE ops parks from the session. Removes ONLY
 * expired in-scope parks; fresh and out-of-scope parks survive. Returns the pruned
 * set (for logging/tests). Does NOT swallow — the ingress wraps the call so a
 * prune failure is non-fatal to the notice/turn (the expired parks stay inert
 * regardless).
 */
export async function pruneExpiredOpsParks(input: {
  readonly session: Pick<SessionPort, "unpark">;
  readonly sessionId: string;
  readonly pendingConfirmations: ReadonlyArray<ParkedEnvelope>;
  readonly nowIso: string;
  readonly excludedKinds?: ReadonlySet<string>;
  readonly ttlSeconds?: number;
}): Promise<ParkedEnvelope[]> {
  return unparkParks({
    session: input.session,
    sessionId: input.sessionId,
    parks: opsExpiredInScopeParks(input),
  });
}

/** FE-D13 — the honest stale-resume restatement for ALREADY-expired ops parks
 *  (callers partition at `nowIso` via {@link partitionOpsParksByFreshness}). PURE. */
export function expiredOpsParkNotice(
  text: string,
  expiredParks: ReadonlyArray<ParkedEnvelope>,
  nowIso: string,
): string | undefined {
  return expiredParkNotice(text, expiredParks, nowIso, buildExpiredOpsParkNotice);
}

/** The ops policy an `excludedKinds`/`ttlSeconds` call site declares. */
function opsPolicyFrom(input: {
  readonly excludedKinds?: ReadonlySet<string>;
  readonly ttlSeconds?: number;
}): ParkTriagePolicy {
  return opsParkTriagePolicy({
    ...(input.excludedKinds ? { excludedKinds: input.excludedKinds } : {}),
    ...(input.ttlSeconds !== undefined ? { ttlSeconds: input.ttlSeconds } : {}),
  });
}

/**
 * BKL-212 — the park a PURE-NEGATIVE customer-web reply declines, or `undefined`
 * when this branch must not engage (a `#hash`/defer/affirmative reply, a MIXED
 * reply — the money-safe ambiguous case that keeps the park — or no park at all).
 * PURE — the caller owns the unpark.
 */
export function webNegativeDeclineTarget(
  text: string,
  pendingConfirmations: ReadonlyArray<ParkedEnvelope> | undefined,
): ParkedEnvelope | undefined {
  if (!pendingConfirmations || pendingConfirmations.length === 0) return undefined;
  return negativeDeclineBranch(
    text,
    pendingConfirmations,
    WEB_CLOCKLESS_NOW,
    webCustomerParkTriagePolicy(),
  );
}

/**
 * BKL-212 — the pt-BR restatement for a BARE SOFT AFFIRMATIVE ("ok"/"pode"/
 * "beleza") aimed at a parked confirmation, or `undefined` when this branch must
 * not engage (an explicit "sim"/`#hash`/negative/defer — all resolved by the
 * normal loop — a soft affirmative that ALSO carries content ("ok mas muda para
 * 19h" — a new request the loop must answer), an ordinary utterance, or no park at
 * all). Restating is the WHOLE effect: nothing executes and the park survives, so
 * a follow-up "sim" still resumes it through the normal adjudicated path. PURE.
 */
export function webSoftAffirmativeRestateNotice(
  text: string,
  pendingConfirmations: ReadonlyArray<ParkedEnvelope> | undefined,
): string | undefined {
  if (!pendingConfirmations || pendingConfirmations.length === 0) return undefined;
  return softAffirmativeRestateBranch(
    text,
    pendingConfirmations,
    WEB_CLOCKLESS_NOW,
    webCustomerParkTriagePolicy(),
  );
}
