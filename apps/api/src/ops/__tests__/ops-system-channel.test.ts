// ops-system-channel — the ops-plane matchToParked driver (BKL-085).
//
// Every branch of the pt-BR matcher: hash-prefix (hit / miss no-fall-through),
// defer-phrases, affirmatives, negatives, single-slot most-recent-by-parkedAt,
// mixed-signal precedence, and the load-bearing "sim with ZERO parks → null".

import { afterEach, describe, expect, it } from "vitest";
import type { ChannelMessage, ParkedEnvelope, Session } from "@claustrum/core";
import {
  expiredOpsParkNotice,
  getOpsConfirmParkTtlSeconds,
  isAmbiguousOpsReply,
  matchOpsReplyToParked,
  opsConfirmParkExpiresAt,
  opsExpiredInScopeParks,
  opsNegativeDeclineTarget,
  opsSoftAffirmativeRestateNotice,
  opsStaleResumeNotice,
  OPS_AMBIGUOUS_REPLY_CLARIFY_PTBR,
  OpsSystemChannel,
  partitionOpsParksByFreshness,
  pruneExpiredOpsParks,
} from "../ops-system-channel.js";

function parked(intentHash: string, parkedAt: string): ParkedEnvelope {
  return {
    envelope: { intentHash } as ParkedEnvelope["envelope"],
    confirmationToken: `tok-${intentHash}`,
    userPrompt: "Confirmar?",
    parkedAt,
  };
}

const P1 = parked("a4b8c1d2e3f4", "2026-07-04T12:00:00.000Z");
const P2 = parked("bb99887766ff", "2026-07-04T12:05:00.000Z"); // more recent

describe("matchOpsReplyToParked — pt-BR ops confirm-resume matcher", () => {
  it("returns null for an empty park list even on 'sim' (fresh utterance)", () => {
    expect(matchOpsReplyToParked("sim, confirma", [])).toBeNull();
  });

  it("affirmative 'sim' → confirm the most-recent park", () => {
    const m = matchOpsReplyToParked("sim", [P1, P2]);
    expect(m?.userResolution).toBe("confirm");
    expect(m?.parked).toBe(P2); // most recent by parkedAt
  });

  it.each(["sim", "confirma", "confirmo", "aprovo"])(
    "EXPLICIT affirmative lexicon: %s → confirm (FE-D32)",
    (word) => {
      expect(matchOpsReplyToParked(word, [P1])?.userResolution).toBe("confirm");
    },
  );

  it.each(["pode", "ok", "isso", "beleza", "manda"])(
    "SOFT affirmative lexicon: %s → null (FE-D32 — too weak to execute; the ingress restates)",
    (word) => {
      expect(matchOpsReplyToParked(word, [P1])).toBeNull();
    },
  );

  it.each(["não", "nao", "cancela", "cancelar", "pare", "negativo", "nega"])(
    "negative lexicon: %s → deny",
    (word) => {
      expect(matchOpsReplyToParked(word, [P1])?.userResolution).toBe("deny");
    },
  );

  it.each([
    "amanhã",
    "amanha",
    "mais tarde",
    "depois",
    "à noite",
    "daqui a 2 horas",
  ])("defer lexicon: %s → defer (carries the phrase)", (phrase) => {
    const m = matchOpsReplyToParked(`faz ${phrase}`, [P1]);
    expect(m?.userResolution).toBe("defer");
    expect(typeof m?.deferPhrase).toBe("string");
  });

  it("defer BEATS affirmative — 'sim, amanhã' is a defer, not a confirm", () => {
    expect(matchOpsReplyToParked("sim, amanhã", [P1])?.userResolution).toBe(
      "defer",
    );
  });

  it("hash-prefix (6-12 hex) targets the matching park regardless of recency", () => {
    // #a4b8c1 addresses P1 (the OLDER park), not the most-recent P2.
    const m = matchOpsReplyToParked("#a4b8c1 confirma", [P1, P2]);
    expect(m?.parked).toBe(P1);
    expect(m?.userResolution).toBe("confirm");
  });

  it("hash-prefix with a negative infers deny", () => {
    const m = matchOpsReplyToParked("#bb9988 não", [P1, P2]);
    expect(m?.parked).toBe(P2);
    expect(m?.userResolution).toBe("deny");
  });

  it("hash-prefix that matches NOTHING does NOT fall through (returns null)", () => {
    // Explicit hash → a miss is a fresh utterance, never a fallback confirm.
    expect(matchOpsReplyToParked("#dead00 sim", [P1, P2])).toBeNull();
  });

  it("bare hash (no text) defaults to confirm on a match", () => {
    expect(matchOpsReplyToParked("#a4b8c1", [P1])?.userResolution).toBe("confirm");
  });

  it("a too-short hash (<6 hex) is NOT treated as a hash probe", () => {
    // "#a4b" is 3 hex — below the 6-char floor; falls through to lexical matching
    // (here 'sim' → confirm on the most-recent park).
    const m = matchOpsReplyToParked("#a4b sim", [P1, P2]);
    expect(m?.userResolution).toBe("confirm");
    expect(m?.parked).toBe(P2);
  });

  it("an unrelated utterance → null (fresh turn, normal loop)", () => {
    expect(matchOpsReplyToParked("como está a cozinha?", [P1])).toBeNull();
  });

  it("most-recent selection skips a malformed parkedAt (NaN-sticky guard)", () => {
    const bad = parked("cccccccccccc", "not-a-date");
    // P2 (valid, most recent) must still win over the malformed entry.
    const m = matchOpsReplyToParked("sim", [bad, P2]);
    expect(m?.parked).toBe(P2);
  });
});

// ── BKL-063: compound (multi-envelope) park → SEQUENTIAL, one-at-a-time resume ──
//
// claustrum 0.6.0 dispatch parks EVERY envelope of a compound REQUEST_CONFIRMATION
// plan into `session.pendingConfirmations` (the adopter SessionStore appends each,
// de-duped by intentHash — claustrum-bootstrap.ts:parkPendingConfirmation), so NO
// envelope silently vanishes the way pre-0.6.0 dropped everything but envelopes[0].
//
// The RESUME is single-match by design and OWNED UPSTREAM: `matchToParked` returns
// ONE `ParkedMatch` (the most-recently-parked on a bare "sim") and claustrum's
// `resolveResume` (handle-turn.ts) re-adjudicates + audits exactly that one, then
// unparks it. So a compound park is confirmed ONE ENVELOPE PER "sim", most-recent-
// first — the MONEY-SAFE semantics: a single "sim" can never fire N money actions,
// and each resumed EXECUTE is backed by its own fresh audited Decision. A specific
// envelope can be targeted out-of-order by its `#hash` prefix. This test pins that
// sequential behavior as PRODUCT behavior (unpark modeled as the store's pure
// intentHash filter, mirroring redisSessionStore.unpark + resolveResume).
describe("matchOpsReplyToParked — BKL-063 compound multi-park sequential resume", () => {
  // The conductor's unpark-on-confirm, as a pure filter (redisSessionStore.unpark).
  const unpark = (
    list: ReadonlyArray<ParkedEnvelope>,
    intentHash: string,
  ): ParkedEnvelope[] => list.filter((p) => p.envelope.intentHash !== intentHash);

  it("a single 'sim' resolves EXACTLY ONE envelope (most-recent), never both", () => {
    const both = [P1, P2];
    const m = matchOpsReplyToParked("sim", both);
    expect(m?.userResolution).toBe("confirm");
    expect(m?.parked).toBe(P2); // most recent only — P1 stays parked
    // Money-safety: the matcher is pure — the park list is never mutated, so P1
    // remains pending (the conductor unparks only the one it re-adjudicates).
    expect(both).toEqual([P1, P2]);
  });

  it("both parked envelopes replay across TWO confirms (most-recent-first), none lost", () => {
    // Turn 1: compound plan parked both → "sim" confirms the most recent (P2).
    let pending: ParkedEnvelope[] = [P1, P2];
    const first = matchOpsReplyToParked("sim", pending);
    expect(first?.userResolution).toBe("confirm");
    expect(first?.parked).toBe(P2);
    // Conductor re-adjudicates + unparks P2.
    pending = unpark(pending, P2.envelope.intentHash);
    expect(pending).toEqual([P1]);
    // Turn 2: the remaining envelope is still pending → the next "sim" confirms it.
    const second = matchOpsReplyToParked("sim", pending);
    expect(second?.userResolution).toBe("confirm");
    expect(second?.parked).toBe(P1);
    pending = unpark(pending, P1.envelope.intentHash);
    expect(pending).toEqual([]); // both replayed — nothing silently vanished
  });

  it("a #hash prefix targets a SPECIFIC parked envelope out of the compound set", () => {
    // Staff can confirm the older P1 first by addressing its hash — order-independent.
    const m = matchOpsReplyToParked("#a4b8c1 confirma", [P1, P2]);
    expect(m?.parked).toBe(P1);
    expect(m?.userResolution).toBe("confirm");
  });

  it("a single 'não' denies EXACTLY ONE envelope (most-recent) — the rest stay parked", () => {
    // Symmetry with confirm: a compound park is abandoned one envelope per reply, so
    // a customer/staff never blanket-denies a whole compound plan with one word.
    const m = matchOpsReplyToParked("não", [P1, P2]);
    expect(m?.userResolution).toBe("deny");
    expect(m?.parked).toBe(P2);
  });
});

// ── Money-execution safety (BKL-085 hardening) ───────────────────────────────
// A parked money action (e.g. a CONFIRM-band refund) may ONLY execute on a clear,
// unambiguous yes; an unrelated fresh command must never abandon the park.
describe("matchOpsReplyToParked — money-execution safety", () => {
  it.each([
    "não confirmo", // "I do not confirm" — refusal that contains "confirmo"
    "não, pode deixar", // "no, you can leave it" — refusal that contains "pode"
    "ok, cancela", // affirmative "ok" alongside the refusal "cancela"
    "sim, mas não", // yes-but-no
  ])(
    "an explicit refusal containing an affirmative token is NEVER a confirm: %s",
    (text) => {
      const m = matchOpsReplyToParked(text, [P1]);
      // Money must not execute on a refusal: resolves to NEITHER (null), which
      // preserves the park (the conductor unparks only on deny/defer).
      expect(m).toBeNull();
      expect(m?.userResolution).not.toBe("confirm");
    },
  );

  it.each([
    "muda o preço da costela para R$ 89", // WS6 guided example (contains "para")
    "avança o pedido 4242 para pronto", // WS6 guided example (contains "para")
    "reserva a mesa 5 para hoje", // fresh command with the preposition "para"
  ])(
    "an unrelated fresh command containing 'para' is NOT a denial: %s",
    (text) => {
      // "para" the preposition must not eat the command as a deny → null (fresh
      // utterance; the normal loop runs and the park is untouched).
      expect(matchOpsReplyToParked(text, [P1])).toBeNull();
    },
  );

  it.each(["sim", "sim, confirma", "confirmo", "pode confirmar"])(
    "a clean EXPLICIT confirm still resolves to confirm: %s",
    (text) => {
      expect(matchOpsReplyToParked(text, [P1])?.userResolution).toBe("confirm");
    },
  );

  it.each(["ok", "beleza"])(
    "a bare SOFT affirmative no longer resolves to confirm (FE-D32): %s",
    (text) => {
      expect(matchOpsReplyToParked(text, [P1])).toBeNull();
    },
  );

  it("ambiguous (mixed affirmative + negative) input resolves to NEITHER, park preserved", () => {
    const parkList = [P1];
    const m = matchOpsReplyToParked("sim, mas não sei", parkList);
    expect(m).toBeNull(); // neither confirm nor deny
    // Pure matcher: the park list it was handed is never mutated (the durable
    // park is untouched — only the conductor unparks, and only on deny/defer).
    expect(parkList).toEqual([P1]);
  });

  it("keeps deny for a clean refusal with no affirmative token", () => {
    expect(matchOpsReplyToParked("não", [P1])?.userResolution).toBe("deny");
    expect(matchOpsReplyToParked("cancela o reembolso", [P1])?.userResolution).toBe(
      "deny",
    );
  });
});

describe("isAmbiguousOpsReply + OPS_AMBIGUOUS_REPLY_CLARIFY_PTBR", () => {
  it.each(["não confirmo", "ok, cancela", "sim, mas não"])(
    "flags a mixed affirmative+negative reply as ambiguous: %s",
    (text) => {
      expect(isAmbiguousOpsReply(text)).toBe(true);
    },
  );

  it.each(["sim", "confirma", "não", "cancela", "muda o preço para R$ 89", ""])(
    "does NOT flag a clean confirm / clean deny / fresh command / empty as ambiguous: %s",
    (text) => {
      expect(isAmbiguousOpsReply(text)).toBe(false);
    },
  );

  it("a defer phrase is a valid resolution, not ambiguous", () => {
    // "sim, amanhã, não" carries a defer → matcher resolves to defer, not ambiguous.
    expect(isAmbiguousOpsReply("sim, amanhã, não")).toBe(false);
  });

  it("the clarification is a non-empty pt-BR line offering confirm/cancel", () => {
    expect(OPS_AMBIGUOUS_REPLY_CLARIFY_PTBR.length).toBeGreaterThan(0);
    expect(OPS_AMBIGUOUS_REPLY_CLARIFY_PTBR).toMatch(/confirmar/i);
    expect(OPS_AMBIGUOUS_REPLY_CLARIFY_PTBR).toMatch(/cancelar/i);
  });
});

describe("OpsSystemChannel — driver integration", () => {
  const channel = new OpsSystemChannel({
    gatewaySigningKey: "test-ops-signing-key-abcdefghijklmnop",
    gateway: "ibatexas-ops-test",
  });

  function session(pending: ParkedEnvelope[]): Session {
    return {
      id: "system:staff:s1",
      customerId: "staff:s1",
      channel: "system",
      startedAt: "2026-07-04T00:00:00.000Z",
      lastActivityAt: "2026-07-04T00:00:00.000Z",
      pendingConfirmations: pending,
      deferredEnvelopes: [],
      activeGoals: [],
      workingMemory: { summary: "", facts: [], updatedAt: "2026-07-04T00:00:00.000Z" },
    };
  }

  function msg(text: string): ChannelMessage {
    return {
      channel: "system",
      customerId: "staff:s1",
      conversationId: "admin:s1",
      externalId: "x",
      text,
      receivedAt: "2026-07-04T12:00:00.000Z",
      locale: "pt-BR",
    };
  }

  it("matchToParked reads session.pendingConfirmations and resolves 'sim'", () => {
    const m = channel.matchToParked(msg("sim, confirma"), session([P1]));
    expect(m?.userResolution).toBe("confirm");
    expect(m?.parked).toBe(P1);
  });

  it("matchToParked returns null with no parks (normal cognitive loop)", () => {
    expect(channel.matchToParked(msg("sim"), session([]))).toBeNull();
  });

  it("kind is 'system' (SystemChannel behaviour preserved)", () => {
    expect(channel.kind).toBe("system");
  });
});

// ── FE-D13: confirm-park TTL + honest stale-resume ───────────────────────────
// A parked ops CONFIRM must resume only within a freshness window; an older park
// is invisible to BOTH bare-affirmative AND #hash resume (a forgotten park must
// never execute on a later unrelated "sim" — the two live FE-D13 incidents), and
// the ingress restates the expiry honestly instead of silently running the fresh
// loop. Fail-CLOSED: an age that cannot be established ⇒ expired.

/** A parked envelope carrying an intent `kind` (for the scope-exclusion cases). */
function parkedKind(
  intentHash: string,
  parkedAt: string,
  kind: string,
  userPrompt = "Confirmar?",
): ParkedEnvelope {
  return {
    envelope: { intentHash, kind } as ParkedEnvelope["envelope"],
    confirmationToken: `tok-${intentHash}`,
    userPrompt,
    parkedAt,
  };
}

describe("partitionOpsParksByFreshness — FE-D13 confirm-park TTL", () => {
  // P1 parkedAt 12:00:00 → 900s old at NOW; P2 parkedAt 12:05:00 → 600s old.
  const NOW = "2026-07-04T12:15:00.000Z";

  it("a park EXACTLY at the TTL boundary is EXPIRED (age >= ttl)", () => {
    // P1 is 900s old; ttl 900s → age(900_000ms) >= ttl(900_000ms) → expired.
    const { fresh, expired } = partitionOpsParksByFreshness([P1], NOW, 900);
    expect(fresh).toHaveLength(0);
    expect(expired).toEqual([P1]);
  });

  it("a park just UNDER the TTL boundary is FRESH", () => {
    // P1 is 900s old; ttl 901s → age < ttl → fresh (both sides of the boundary).
    const { fresh, expired } = partitionOpsParksByFreshness([P1], NOW, 901);
    expect(fresh).toEqual([P1]);
    expect(expired).toHaveLength(0);
  });

  it("splits a mixed list at the boundary (P1 expired 900s, P2 fresh 600s)", () => {
    const { fresh, expired } = partitionOpsParksByFreshness([P1, P2], NOW, 900);
    expect(expired).toEqual([P1]);
    expect(fresh).toEqual([P2]);
  });

  it("fail-CLOSED: a malformed parkedAt ⇒ expired (inverts the NaN keep-alive)", () => {
    // Contrast the most-recent SELECTION guard, which keeps a NaN-timestamp park
    // resumable; for the EXPIRY decision an unparseable age fails closed.
    const bad = parked("cccccccccccc", "not-a-date");
    const { fresh, expired } = partitionOpsParksByFreshness([bad], NOW, 900);
    expect(fresh).toHaveLength(0);
    expect(expired).toEqual([bad]);
  });

  it("fail-CLOSED: a malformed nowIso ⇒ ALL parks expired", () => {
    const { fresh, expired } = partitionOpsParksByFreshness([P1, P2], "not-a-date", 900);
    expect(fresh).toHaveLength(0);
    expect(expired).toEqual([P1, P2]);
  });

  it("PURE — never mutates the input list", () => {
    const input = [P1, P2];
    partitionOpsParksByFreshness(input, NOW, 900);
    expect(input).toEqual([P1, P2]);
  });
});

describe("OpsSystemChannel.matchToParked — FE-D13 TTL freshness gate", () => {
  const channel = new OpsSystemChannel({
    gatewaySigningKey: "test-ops-signing-key-abcdefghijklmnop",
    gateway: "ibatexas-ops-test",
  });
  function session(pending: ParkedEnvelope[]): Session {
    return {
      id: "system:staff:s1",
      customerId: "staff:s1",
      channel: "system",
      startedAt: "2026-07-04T00:00:00.000Z",
      lastActivityAt: "2026-07-04T00:00:00.000Z",
      pendingConfirmations: pending,
      deferredEnvelopes: [],
      activeGoals: [],
      workingMemory: { summary: "", facts: [], updatedAt: "2026-07-04T00:00:00.000Z" },
    };
  }
  function msg(text: string, receivedAt: string): ChannelMessage {
    return {
      channel: "system",
      customerId: "staff:s1",
      conversationId: "admin:s1",
      externalId: "x",
      text,
      receivedAt,
      locale: "pt-BR",
    };
  }

  it("a FRESH park (age 0) resolves 'sim' — byte-identical to pre-FE-D13", () => {
    const m = channel.matchToParked(
      msg("sim, confirma", "2026-07-04T12:00:00.000Z"),
      session([P1]),
    );
    expect(m?.userResolution).toBe("confirm");
    expect(m?.parked).toBe(P1);
  });

  it("a park older than the default 900s TTL is INVISIBLE to a bare 'sim' → null", () => {
    // P1 parkedAt 12:00; received 12:16 (>15 min) → expired → no resume.
    expect(
      channel.matchToParked(msg("sim", "2026-07-04T12:16:00.000Z"), session([P1])),
    ).toBeNull();
  });

  it("an expired park is INVISIBLE to a #hash resume too (consistent with hash-miss)", () => {
    expect(
      channel.matchToParked(
        msg("#a4b8c1 confirma", "2026-07-04T12:16:00.000Z"),
        session([P1]),
      ),
    ).toBeNull();
  });

  it("only-expired parks ⇒ 'sim' returns null (nothing to resume)", () => {
    // At 12:30 both P1 (12:00) and P2 (12:05) exceed the 900s TTL.
    expect(
      channel.matchToParked(msg("sim", "2026-07-04T12:30:00.000Z"), session([P1, P2])),
    ).toBeNull();
  });

  it("a still-FRESH park among expired ones still resolves (partition keeps the fresh)", () => {
    const P3 = parked("dddddddddddd", "2026-07-04T12:15:30.000Z"); // 30s old at 12:16
    const m = channel.matchToParked(
      msg("sim", "2026-07-04T12:16:00.000Z"),
      session([P1, P3]),
    );
    expect(m?.parked).toBe(P3);
    expect(m?.userResolution).toBe("confirm");
  });
});

describe("opsSoftAffirmativeRestateNotice — FE-D32 soft-affirmative restatement", () => {
  const FRESH_NOW = "2026-07-04T12:00:30.000Z"; // 30s after P1's park → fresh

  it.each(["pode", "ok", "manda", "beleza", "isso", "claro"])(
    "a bare SOFT affirmative on a fresh park RESTATES (names the prompt, asks for explicit): %s",
    (text) => {
      const notice = opsSoftAffirmativeRestateNotice({
        text,
        pendingConfirmations: [P1],
        nowIso: FRESH_NOW,
      });
      expect(notice).toBeDefined();
      expect(notice).toContain(P1.userPrompt); // "Confirmar?"
      expect(notice).toContain('"sim"'); // asks for an explicit confirm
    },
  );

  it.each(["sim", "confirmo", "sim, confirma", "#a4b8c1"])(
    "an EXPLICIT confirm / #hash is deferred to the normal loop (undefined — it executes): %s",
    (text) => {
      expect(
        opsSoftAffirmativeRestateNotice({ text, pendingConfirmations: [P1], nowIso: FRESH_NOW }),
      ).toBeUndefined();
    },
  );

  it.each(["não", "cancela", "amanhã", "muda o preço da costela para 89"])(
    "a negative / defer / ordinary command → undefined (normal loop): %s",
    (text) => {
      expect(
        opsSoftAffirmativeRestateNotice({ text, pendingConfirmations: [P1], nowIso: FRESH_NOW }),
      ).toBeUndefined();
    },
  );

  it("no fresh in-scope park → undefined (soft reply is a fresh utterance; the stale path owns expired parks)", () => {
    expect(
      opsSoftAffirmativeRestateNotice({ text: "pode", pendingConfirmations: [], nowIso: FRESH_NOW }),
    ).toBeUndefined();
    const EXPIRED_NOW = "2026-07-04T13:00:00.000Z";
    expect(
      opsSoftAffirmativeRestateNotice({ text: "pode", pendingConfirmations: [P1], nowIso: EXPIRED_NOW }),
    ).toBeUndefined();
  });
});

describe("expiredOpsParkNotice — FE-D13 honest stale-resume restatement", () => {
  const NOW = "2026-07-04T12:16:00.000Z";
  // P1's userPrompt is "Confirmar?" (the parked() helper), parkedAt 12:00 → expired.

  it.each(["sim", "pode", "#a4b8c1 confirma", "não", "cancela"])(
    "restates (naming the parked kernel prompt) on a resume signal: %s",
    (text) => {
      const notice = expiredOpsParkNotice(text, [P1], NOW);
      expect(notice).toBeDefined();
      expect(notice).toContain(P1.userPrompt); // "Confirmar?"
      expect(notice).toContain("expirou");
      expect(notice).toContain("NÃO foi executada");
    },
  );

  it("undefined on a no-signal fresh utterance (ordinary command runs the normal loop)", () => {
    expect(expiredOpsParkNotice("como está a cozinha?", [P1], NOW)).toBeUndefined();
  });

  it("undefined on an empty expired set", () => {
    expect(expiredOpsParkNotice("sim", [], NOW)).toBeUndefined();
  });

  it("fail-safe: undefined when nowIso is unparseable (cannot honestly assert expiry)", () => {
    expect(expiredOpsParkNotice("sim", [P1], "not-a-date")).toBeUndefined();
  });
});

describe("opsStaleResumeNotice — FE-D13 ingress orchestrator", () => {
  const TTL = 900;
  const parkedAt = "2026-07-04T12:00:00.000Z";
  const staleNow = "2026-07-04T12:16:00.000Z"; // 16 min → expired
  const freshNow = "2026-07-04T12:05:00.000Z"; // 5 min → fresh

  it("returns the notice for a 'sim' against an EXPIRED park", () => {
    const p = parkedKind("aaaa11112222", parkedAt, "payment.refund.issue", "Confirmar reembolso de R$ 50,00?");
    const notice = opsStaleResumeNotice({
      text: "sim",
      pendingConfirmations: [p],
      nowIso: staleNow,
      ttlSeconds: TTL,
    });
    expect(notice).toBeDefined();
    expect(notice).toContain("Confirmar reembolso de R$ 50,00?");
  });

  it("returns undefined (normal loop) when the reply resumes a still-FRESH park", () => {
    const p = parkedKind("aaaa11112222", parkedAt, "payment.refund.issue");
    expect(
      opsStaleResumeNotice({
        text: "sim",
        pendingConfirmations: [p],
        nowIso: freshNow,
        ttlSeconds: TTL,
      }),
    ).toBeUndefined();
  });

  it("fresh precedence: a fresh park the reply resumes WINS over an older expired one (no notice)", () => {
    const expired = parkedKind("aaaa00000000", parkedAt, "payment.refund.issue");
    const fresh = parkedKind("bbbb11112222", "2026-07-04T12:15:30.000Z", "payment.refund.issue");
    expect(
      opsStaleResumeNotice({
        text: "sim",
        pendingConfirmations: [expired, fresh],
        nowIso: staleNow,
        ttlSeconds: TTL,
      }),
    ).toBeUndefined();
  });

  it("BKL-086 parity: an excluded (out-of-scope) EXPIRED money park is NOT restated", () => {
    const p = parkedKind("aaaa11112222", parkedAt, "payment.refund.issue", "Confirmar reembolso?");
    const excluded = new Set(["payment.refund.issue"]);
    expect(
      opsStaleResumeNotice({
        text: "sim",
        pendingConfirmations: [p],
        nowIso: staleNow,
        excludedKinds: excluded,
        ttlSeconds: TTL,
      }),
    ).toBeUndefined();
  });

  it("an in-scope expired park IS restated even when an excluded one coexists", () => {
    const refund = parkedKind("aaaa00000000", parkedAt, "payment.refund.issue", "Confirmar reembolso?");
    const price = parkedKind("bbbb11112222", parkedAt, "product.price.set", "Confirmar novo preço?");
    const excluded = new Set(["payment.refund.issue"]);
    const notice = opsStaleResumeNotice({
      text: "sim",
      pendingConfirmations: [refund, price],
      nowIso: staleNow,
      excludedKinds: excluded,
      ttlSeconds: TTL,
    });
    expect(notice).toBeDefined();
    expect(notice).toContain("Confirmar novo preço?");
    expect(notice).not.toContain("reembolso");
  });

  it("undefined on an ordinary command while an expired park exists (normal loop)", () => {
    const p = parkedKind("aaaa11112222", parkedAt, "payment.refund.issue");
    expect(
      opsStaleResumeNotice({
        text: "muda o preço da costela para R$ 89",
        pendingConfirmations: [p],
        nowIso: staleNow,
        ttlSeconds: TTL,
      }),
    ).toBeUndefined();
  });
});

describe("getOpsConfirmParkTtlSeconds — env parse fallback", () => {
  const KEY = "OPS_CONFIRM_PARK_TTL_SECONDS";
  const original = process.env[KEY];
  afterEach(() => {
    if (original === undefined) delete process.env[KEY];
    else process.env[KEY] = original;
  });

  it("defaults to 900 when unset", () => {
    delete process.env[KEY];
    expect(getOpsConfirmParkTtlSeconds()).toBe(900);
  });

  it("parses a valid override", () => {
    process.env[KEY] = "60";
    expect(getOpsConfirmParkTtlSeconds()).toBe(60);
  });

  it.each(["", "abc", "0", "-5"])(
    "falls back to 900 for an invalid value: %s",
    (val) => {
      process.env[KEY] = val;
      expect(getOpsConfirmParkTtlSeconds()).toBe(900);
    },
  );
});

// ── FE-D33: expiresAt stamping + zombie-park pruning ─────────────────────────

describe("opsConfirmParkExpiresAt — FE-D33 forward-compat stamping", () => {
  const KEY = "OPS_CONFIRM_PARK_TTL_SECONDS";
  const original = process.env[KEY];
  afterEach(() => {
    if (original === undefined) delete process.env[KEY];
    else process.env[KEY] = original;
  });

  it("stamps an ops/system-plane park at parkedAt + the confirm TTL (default 900s)", () => {
    delete process.env[KEY];
    expect(opsConfirmParkExpiresAt("system:staff:s1", "2026-07-04T12:00:00.000Z")).toBe(
      "2026-07-04T12:15:00.000Z",
    );
  });

  it("honors the env TTL override", () => {
    process.env[KEY] = "60";
    expect(opsConfirmParkExpiresAt("system:staff:s1", "2026-07-04T12:00:00.000Z")).toBe(
      "2026-07-04T12:01:00.000Z",
    );
  });

  it.each(["whatsapp:cust_1", "web:sess_1"])(
    "returns undefined for a customer-plane park (no confirm-freshness TTL): %s",
    (sessionId) => {
      expect(opsConfirmParkExpiresAt(sessionId, "2026-07-04T12:00:00.000Z")).toBeUndefined();
    },
  );

  it("returns undefined for a malformed parkedAt (nothing truthful to stamp)", () => {
    expect(opsConfirmParkExpiresAt("system:staff:s1", "not-a-date")).toBeUndefined();
  });
});

describe("opsExpiredInScopeParks + pruneExpiredOpsParks — FE-D33 zombie pruning", () => {
  const NOW = "2026-07-04T12:16:00.000Z"; // 16 min after 12:00 (> the 900s TTL)
  const TTL = 900;
  const oldAt = "2026-07-04T12:00:00.000Z"; // 16 min old → expired
  const freshAt = "2026-07-04T12:15:30.000Z"; // 30s old → fresh

  it("selects ONLY expired in-scope parks (fresh survive)", () => {
    const expired = parkedKind("aaaa00000000", oldAt, "product.price.set");
    const fresh = parkedKind("bbbb11112222", freshAt, "product.price.set");
    expect(
      opsExpiredInScopeParks({
        pendingConfirmations: [expired, fresh],
        nowIso: NOW,
        ttlSeconds: TTL,
      }),
    ).toEqual([expired]);
  });

  it("never selects an out-of-scope park, even when expired (BKL-086 parity)", () => {
    const refund = parkedKind("aaaa00000000", oldAt, "payment.refund.issue"); // expired but excluded
    const price = parkedKind("bbbb11112222", oldAt, "product.price.set"); // expired in-scope
    expect(
      opsExpiredInScopeParks({
        pendingConfirmations: [refund, price],
        nowIso: NOW,
        excludedKinds: new Set(["payment.refund.issue"]),
        ttlSeconds: TTL,
      }),
    ).toEqual([price]);
  });

  it("prune unparks ONLY expired in-scope hashes and returns the pruned set", async () => {
    const expired1 = parkedKind("aaaa00000000", oldAt, "product.price.set");
    const fresh = parkedKind("bbbb11112222", freshAt, "product.price.set");
    const expired2 = parkedKind("cccc00000000", oldAt, "order.status.transition");
    const refundExpired = parkedKind("dddd00000000", oldAt, "payment.refund.issue");
    const unparked: Array<{ sessionId: string; hash: string }> = [];
    const session = {
      unpark: async (sessionId: string, hash: string) => {
        unparked.push({ sessionId, hash });
      },
    };
    const pruned = await pruneExpiredOpsParks({
      session,
      sessionId: "system:staff:s1",
      pendingConfirmations: [expired1, fresh, expired2, refundExpired],
      nowIso: NOW,
      excludedKinds: new Set(["payment.refund.issue"]),
      ttlSeconds: TTL,
    });
    // Fresh (bbbb) and out-of-scope refund (dddd) survive; only aaaa + cccc pruned.
    expect(pruned).toEqual([expired1, expired2]);
    expect(unparked).toEqual([
      { sessionId: "system:staff:s1", hash: "aaaa00000000" },
      { sessionId: "system:staff:s1", hash: "cccc00000000" },
    ]);
  });

  it("prune is a no-op (no unpark calls) when nothing is expired", async () => {
    const fresh = parkedKind("bbbb11112222", freshAt, "product.price.set");
    let calls = 0;
    const session = {
      unpark: async () => {
        calls += 1;
      },
    };
    const pruned = await pruneExpiredOpsParks({
      session,
      sessionId: "system:staff:s1",
      pendingConfirmations: [fresh],
      nowIso: NOW,
      ttlSeconds: TTL,
    });
    expect(pruned).toEqual([]);
    expect(calls).toBe(0);
  });

  it("prune propagates an unpark rejection (the INGRESS wraps it — fail-safe there)", async () => {
    const expired = parkedKind("aaaa00000000", oldAt, "product.price.set");
    const session = {
      unpark: async () => {
        throw new Error("redis down");
      },
    };
    await expect(
      pruneExpiredOpsParks({
        session,
        sessionId: "system:staff:s1",
        pendingConfirmations: [expired],
        nowIso: NOW,
        ttlSeconds: TTL,
      }),
    ).rejects.toThrow("redis down");
  });
});

// ── BKL-191 — the ingress-side negative decline target ───────────────────────
// A PURE-negative reply on a fresh in-scope park is declined AT THE INGRESS
// (unpark + ack, turn skipped) so the planner never re-reads "não, cancela essa
// ação" as a fresh command (the live re-prompt). The target selection mirrors
// matchOpsReplyToParked's deny resolution exactly.
describe("opsNegativeDeclineTarget — BKL-191 pure-negative park decline", () => {
  const NOW = "2026-07-04T12:06:00.000Z"; // both P1/P2 fresh at the default TTL

  it("a pure negative targets the most-recent fresh park", () => {
    const target = opsNegativeDeclineTarget({
      text: "não, cancela essa ação",
      pendingConfirmations: [P1, P2],
      nowIso: NOW,
    });
    expect(target).toBe(P2);
  });

  it("a MIXED reply ('não, pode deixar') is ambiguous → undefined (park survives)", () => {
    expect(
      opsNegativeDeclineTarget({
        text: "não, pode deixar",
        pendingConfirmations: [P1, P2],
        nowIso: NOW,
      }),
    ).toBeUndefined();
  });

  it("explicit confirm / soft affirmative / #hash / defer never decline", () => {
    for (const text of ["sim", "pode", "#a4b8", "não, amanhã"]) {
      expect(
        opsNegativeDeclineTarget({
          text,
          pendingConfirmations: [P1, P2],
          nowIso: NOW,
        }),
      ).toBeUndefined();
    }
  });

  it("a negative with NO fresh park is an ordinary utterance → undefined", () => {
    expect(
      opsNegativeDeclineTarget({
        text: "não",
        pendingConfirmations: [],
        nowIso: NOW,
      }),
    ).toBeUndefined();
    // Expired-only parks: invisible to decline, same as to resume.
    expect(
      opsNegativeDeclineTarget({
        text: "não",
        pendingConfirmations: [P1],
        nowIso: "2026-07-05T12:00:00.000Z", // >> TTL past P1.parkedAt
      }),
    ).toBeUndefined();
  });

  it("out-of-scope parks are excluded (BKL-086 parity)", () => {
    expect(
      opsNegativeDeclineTarget({
        text: "não, cancela",
        pendingConfirmations: [P2],
        nowIso: NOW,
        excludedKinds: new Set([String(P2.envelope.kind)]),
      }),
    ).toBeUndefined();
  });
});
