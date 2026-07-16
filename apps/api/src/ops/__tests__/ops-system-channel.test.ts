// ops-system-channel — the ops-plane matchToParked driver (BKL-085).
//
// Every branch of the pt-BR matcher: hash-prefix (hit / miss no-fall-through),
// defer-phrases, affirmatives, negatives, single-slot most-recent-by-parkedAt,
// mixed-signal precedence, and the load-bearing "sim with ZERO parks → null".

import { describe, expect, it } from "vitest";
import type { ChannelMessage, ParkedEnvelope, Session } from "@claustrum/core";
import {
  isAmbiguousOpsReply,
  matchOpsReplyToParked,
  OPS_AMBIGUOUS_REPLY_CLARIFY_PTBR,
  OpsSystemChannel,
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

  it.each(["sim", "confirma", "confirmo", "pode", "ok", "isso", "beleza", "manda"])(
    "affirmative lexicon: %s → confirm",
    (word) => {
      expect(matchOpsReplyToParked(word, [P1])?.userResolution).toBe("confirm");
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

  it.each(["sim", "sim, confirma", "confirmo", "pode confirmar", "ok", "beleza"])(
    "a clean unambiguous confirm still resolves to confirm: %s",
    (text) => {
      expect(matchOpsReplyToParked(text, [P1])?.userResolution).toBe("confirm");
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
