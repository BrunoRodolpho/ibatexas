/**
 * LE2-007 — the funnel's L0 tier: the closed social lexicon, the L0 decision, the
 * pt-BR templates and the per-turn stage store.
 *
 * The turn-seam proof (a social turn costing ZERO model calls through a REAL
 * handleTurn) lives in `apps/api/src/__tests__/l0-social-short-circuit.e2e.test.ts`.
 * These are the pure-core pins that suite would not catch: the lexicon's CLOSURE, its
 * census against the plane-shared smalltalk lexicon, the reserved personalization
 * slot, and the fail-closed confirm-window gate.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  SMALLTALK_PHRASES,
  SMALLTALK_TOKENS,
  isSmalltalkOnly,
} from "../interrogative-discriminator.js";
import {
  assertsClosedNow,
  assertsOpenOrImmediate,
  closedHoursPromptNote,
} from "../closed-hours.js";
import {
  EMPTY_L0_SLOTS,
  classifySocialOnly,
  closeFunnelTurn,
  createL0Funnel,
  decideL0,
  funnelStage,
  funnelTurnContext,
  openFunnelTurn,
  renderL0Reply,
  tierAuthorsOwnReply,
  type SocialKind,
} from "../funnel-tier.js";

/** A minimal CognitiveState — the funnel seam reads exactly two fields. */
function state(text: string, turnId: string) {
  return {
    perception: { text, channel: "web", receivedAt: "2026-07-26T12:00:00.000Z" },
    memory: { customerId: "cus_1", episodic: [], semantic: [], procedural: [], relational: [], assembledAt: "2026-07-26T12:00:00.000Z" },
    retrieval: { docs: [], retrievedAt: "2026-07-26T12:00:00.000Z", modelId: "mock" },
    tenantId: "ibatexas",
    locale: "pt-BR",
    conversationId: "conv_1",
    turnId,
  } as never;
}

const OPEN_WINDOW = { confirmWindowOpen: false } as const;

describe("L0 lexicon — the three social speech acts", () => {
  const GREETINGS = [
    "Oi",
    "oi!",
    "Olá",
    "olá!!!",
    "opa",
    "Alô",
    "Bom dia",
    "bom dia!",
    "Boa tarde",
    "Boa noite",
    "boa madrugada",
    "e aí",
    "E aí, tudo bem?",
    "oi, tudo bem?",
    "tudo bem",
    "tudo bom?",
    "tudo certo?",
    "como vai",
    "Fala",
    "fala aí",
    "oi, bom dia",
  ];
  const THANKS = [
    "obrigado",
    "Obrigada!",
    "muito obrigado",
    "muito obrigada!",
    "obrigadão",
    "obg",
    "valeu",
    "vlw",
    "brigado",
    "grato",
    "obrigado, tudo bem?",
  ];
  const FAREWELLS = [
    "tchau",
    "Tchau!",
    "tchauzinho",
    "xau",
    "até",
    "até logo",
    "Até mais!",
    "até breve",
    "até amanhã",
    "até a próxima",
    "adeus",
    "falou",
    "flw",
    "abraço",
    "abraços",
    "tmj",
    "bom fim de semana",
  ];

  it.each(GREETINGS)("classifies %j as a greeting", (text) => {
    expect(classifySocialOnly(text)).toBe("greeting");
  });

  it.each(THANKS)("classifies %j as thanks", (text) => {
    expect(classifySocialOnly(text)).toBe("thanks");
  });

  it.each(FAREWELLS)("classifies %j as a farewell", (text) => {
    expect(classifySocialOnly(text)).toBe("farewell");
  });

  it("resolves a multi-act utterance by terminality: farewell ▷ thanks ▷ greeting", () => {
    expect(classifySocialOnly("obrigado, tchau!")).toBe("farewell");
    expect(classifySocialOnly("boa noite, até amanhã")).toBe("farewell");
    expect(classifySocialOnly("oi, obrigado")).toBe("thanks");
    expect(classifySocialOnly("oi, bom dia")).toBe("greeting");
  });

  // ── The MIXED-utterance bar (AC #2): anything information-bearing parses ──────
  const MIXED = [
    "oi, vocês entregam em Ibaté?",
    "Oi, quero uma coca",
    "bom dia, qual o horário de funcionamento?",
    "obrigado, mas cancela meu pedido",
    "tchau, mas antes me manda o total",
    "oi, tem picanha?",
    "valeu! o pedido chegou errado",
    "boa noite, vocês estão abertos?",
  ];
  it.each(MIXED)("does NOT claim %j — it still parses", (text) => {
    expect(classifySocialOnly(text)).toBeNull();
  });

  // ── The AFFIRMATION family is NOT social (owner decision 8 + FE-D32) ─────────
  const AFFIRMATIONS = [
    "ok",
    "okay",
    "sim",
    "não",
    "certo",
    "isso",
    "combinado",
    "show",
    "massa",
    "beleza",
    "blz",
    "suave",
    "tranquilo",
    "pode",
    "pode ser",
    "confirmo",
  ];
  it.each(AFFIRMATIONS)(
    "leaves %j to the confirm window — never L0",
    (text) => {
      expect(classifySocialOnly(text)).toBeNull();
    },
  );

  it("requires a speech-act token — neutral remnants alone claim nothing", () => {
    for (const text of ["bem", "boa", "tarde", "tudo", "muito", "!!!", "", "   "]) {
      expect(classifySocialOnly(text)).toBeNull();
    }
  });

  it("treats any digit as information — never social", () => {
    expect(classifySocialOnly("oi 2")).toBeNull();
    expect(classifySocialOnly("obrigado pelos 3")).toBeNull();
  });

  it("is CLOSED, not fuzzy: an unrecognised form falls through to the parser", () => {
    // No similarity matching, no stemming, no repeated-letter tolerance (owner
    // decision). These are the documented misses, and a miss is the SAFE direction.
    for (const text of ["oii", "oiii", "bom-dia", "brigadão", "tchauu"]) {
      expect(classifySocialOnly(text)).toBeNull();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// The CENSUS against the plane-shared smalltalk lexicon.
//
// L0 (promote: a match SUPERSEDES the model) and `isSmalltalkOnly` (demote-only: a
// match keeps a turn on the clamped prose path) are deliberately DIFFERENT sets with
// opposite failure directions. This census enumerates BOTH deltas so neither lexicon
// can drift into the other unnoticed: changing either side fails here first, and the
// reviewer sees exactly which tokens crossed.
// ═══════════════════════════════════════════════════════════════════════════════

describe("L0 ↔ smalltalk lexicon census", () => {
  /** Every token the L0 net accepts, recovered through the public predicate so the
   *  census can never test a stale private copy of the lexicon. */
  const L0_ACCEPTED_TOKENS = [
    // greetings
    "oi", "ola", "opa", "alo", "eae", "eai", "fala",
    // thanks
    "obrigado", "obrigada", "obrigadao", "obg", "obgd", "brigado", "brigada",
    "valeu", "vlw", "grato", "grata",
    // farewells
    "tchau", "tchauzinho", "xau", "ate", "adeus", "falou", "flw", "abraco",
    "abracos", "tmj",
  ];

  it("every enumerated L0 token really is claimed by the classifier", () => {
    for (const token of L0_ACCEPTED_TOKENS) {
      expect(classifySocialOnly(token), token).not.toBeNull();
    }
  });

  it("L0 ∖ smalltalk is EXACTLY the reviewed set (mostly the farewell family)", () => {
    const delta = L0_ACCEPTED_TOKENS.filter((t) => !SMALLTALK_TOKENS.has(t)).sort();
    // The ops smalltalk lexicon (BKL-110's 0/15 corpus) simply never needed
    // farewells or the colloquial thanks spellings: nothing on that plane keyed off
    // them. L0 does. Adding them THERE would widen the ops plane's raw-prose
    // retirement gate (LE2-013's ratified surface) from a customer-plane ticket, so
    // they live here instead — and this assertion is the record of that boundary.
    expect(delta).toEqual(
      [
        "abraco",
        "abracos",
        "adeus",
        "alo",
        "ate",
        "brigada",
        "brigado",
        "eae",
        "eai",
        "flw",
        "grata",
        "grato",
        "obgd",
        "obrigadao",
        "tchau",
        "tchauzinho",
        "xau",
      ].sort(),
    );
  });

  it("smalltalk ∖ L0 is EXACTLY the affirmation family — the confirm window's vocabulary", () => {
    const accepted = new Set(L0_ACCEPTED_TOKENS);
    // Neutral tokens are phrase remnants, not speech acts: they keep an utterance
    // L0-eligible but never claim it, so they belong on the L0 side of this census.
    const neutral = new Set([
      "e", "ai", "de", "muito", "mesmo", "tudo", "bem", "bom", "boa", "dia",
      "tarde", "noite", "madrugada", "certo", "joia", "tranquilo", "tranquila",
      "como", "vai", "entao", "fim", "semana",
    ]);
    const delta = [...SMALLTALK_TOKENS]
      .filter((t) => !accepted.has(t) && !neutral.has(t))
      .sort();
    // THE OWNER DECISION, MADE VISIBLE: everything smalltalk holds that L0 does not
    // is an AFFIRMATION or an acknowledgement — precisely the tokens FE-D32 reserves
    // for the restate-then-confirm path. A future token appearing here means someone
    // taught L0 to answer an affirmative, which is the one thing it must never do.
    expect(delta).toEqual(
      ["beleza", "blz", "combinado", "isso", "massa", "nao", "ok", "okay", "show", "sim", "suave"].sort(),
    );
  });

  it("both nets share ONE normalizer — diacritics can never disagree", () => {
    // `normalize` is imported by funnel-tier.ts rather than re-implemented; this is
    // the behavioural proof over the accented forms of both lexicons.
    expect(classifySocialOnly("Olá")).toBe("greeting");
    expect(classifySocialOnly("até amanhã")).toBe("farewell");
    expect(isSmalltalkOnly("Olá")).toBe(true);
    expect(SMALLTALK_PHRASES.length).toBeGreaterThan(0);
  });
});

describe("decideL0 — the FE-D32 confirm-window gate", () => {
  it("fires on a social turn with a published context and no park", () => {
    expect(decideL0({ text: "Oi", context: OPEN_WINDOW })).toEqual({
      kind: "greeting",
    });
  });

  it("does NOT fire while a confirmation is parked — not even bare courtesy", () => {
    for (const text of ["Oi", "bom dia", "obrigado", "valeu", "tchau", "até logo"]) {
      expect(
        decideL0({ text, context: { confirmWindowOpen: true } }),
        text,
      ).toBeUndefined();
    }
  });

  it("FAILS CLOSED on a missing context — 'nobody told us' is not 'no park'", () => {
    expect(decideL0({ text: "Oi", context: undefined })).toBeUndefined();
  });

  it("does not fire on a non-social turn even with a clean context", () => {
    expect(
      decideL0({ text: "oi, vocês entregam em Ibaté?", context: OPEN_WINDOW }),
    ).toBeUndefined();
  });
});

describe("L0 templates", () => {
  const KINDS: ReadonlyArray<SocialKind> = ["greeting", "thanks", "farewell"];

  it("renders warm pt-BR for each act", () => {
    expect(renderL0Reply("greeting")).toBe(
      "Oi! Tudo bem? Como posso te ajudar hoje?",
    );
    expect(renderL0Reply("thanks")).toBe(
      "Eu que agradeço! Se precisar de mais alguma coisa, é só me chamar.",
    );
    expect(renderL0Reply("farewell")).toBe(
      "Até logo! Quando quiser pedir, é só me mandar uma mensagem.",
    );
  });

  it("RESERVES the personalization slot: empty ⟹ byte-identical to no slot", () => {
    for (const kind of KINDS) {
      expect(renderL0Reply(kind, EMPTY_L0_SLOTS)).toBe(renderL0Reply(kind));
      expect(renderL0Reply(kind)).not.toMatch(/ {2}/);
    }
  });

  it("the reserved slot is a real seam — ticket 28 fills it without touching these strings", () => {
    expect(
      renderL0Reply("greeting", { personalization: "Como estava o brisket?" }),
    ).toBe("Oi! Tudo bem? Como estava o brisket? Como posso te ajudar hoje?");
  });

  it("asserts NOTHING about the world — no digits, no store state", () => {
    for (const kind of KINDS) {
      const text = renderL0Reply(kind);
      expect(text).not.toMatch(/\d/);
      // The closed-hours guard's own predicates are the authority on whether a text
      // makes a store-state claim: both must be false, which is WHY running the
      // backstop over an L0 template is a proven no-op in either state.
      expect(assertsOpenOrImmediate(text), kind).toBe(false);
      expect(assertsClosedNow(text), kind).toBe(false);
    }
  });
});

describe("closed-hours behaviour on the L0 domain (the before/after pin)", () => {
  const CLOSED = {
    isClosed: true,
    nextOpenDay: "amanhã às 18h",
    mealPeriod: undefined,
  } as never;

  it("the deterministic closure note was ALREADY suppressed for the smalltalk-shaped L0 domain", () => {
    // This is the mechanism AC #4 protects: `closedHoursPromptNote` returns "" on a
    // phatic turn (the greeting-blurt fix), so a greeting NEVER carried a closure
    // note into the model prompt before L0 either. L0 cannot regress what was
    // already empty.
    for (const text of ["Oi", "bom dia", "tudo bem?", "obrigado", "valeu", "falou"]) {
      expect(closedHoursPromptNote(CLOSED, text), text).toBe("");
    }
  });

  it("DOCUMENTED DELTA: the farewell family outside the smalltalk lexicon did carry the note", () => {
    // Honest record of the one behavioural change L0 makes to closed-hours copy: a
    // farewell the ops smalltalk lexicon does not hold ("tchau", "até logo") used to
    // put the CLOSED note in the planner/responder prompt, so the model could answer
    // a goodbye with a closure + scheduling offer. Under L0 it gets the neutral
    // farewell template instead. Pinned so the delta stays deliberate.
    expect(closedHoursPromptNote(CLOSED, "tchau")).not.toBe("");
    expect(classifySocialOnly("tchau")).toBe("farewell");
  });
});

describe("the per-turn stage store + seam", () => {
  afterEach(() => {
    closeFunnelTurn("t_stage");
  });

  it("stamps a stage record the responder half can render from", () => {
    const funnel = createL0Funnel({ now: () => Date.parse("2026-07-26T12:00:00Z") });
    openFunnelTurn("t_stage", OPEN_WINDOW);
    const stage = funnel.claim(state("Oi", "t_stage"));
    expect(stage).toEqual({
      tier: "L0",
      reason: "social_only",
      detail: { socialKind: "greeting" },
      at: "2026-07-26T12:00:00.000Z",
    });
    expect(funnel.stageFor("t_stage")).toEqual(stage);
    expect(funnelStage("t_stage")).toEqual(stage);
    expect(funnel.reply(stage!)).toBe("Oi! Tudo bem? Como posso te ajudar hoje?");
  });

  it("stamps nothing when no tier claims the turn", () => {
    const funnel = createL0Funnel();
    openFunnelTurn("t_stage", OPEN_WINDOW);
    expect(funnel.claim(state("quero uma coca", "t_stage"))).toBeUndefined();
    expect(funnel.stageFor("t_stage")).toBeUndefined();
  });

  it("closeFunnelTurn drops BOTH the context and the stage", () => {
    const funnel = createL0Funnel();
    openFunnelTurn("t_stage", OPEN_WINDOW);
    funnel.claim(state("tchau", "t_stage"));
    expect(funnelTurnContext("t_stage")).toEqual(OPEN_WINDOW);
    closeFunnelTurn("t_stage");
    expect(funnelTurnContext("t_stage")).toBeUndefined();
    expect(funnelStage("t_stage")).toBeUndefined();
  });

  it("is bounded — a turn that never closes cannot leak unboundedly", () => {
    const funnel = createL0Funnel();
    for (let i = 0; i < 700; i += 1) {
      const turnId = `t_leak_${i}`;
      openFunnelTurn(turnId, OPEN_WINDOW);
      funnel.claim(state("Oi", turnId));
    }
    // The LRU cap (500, mirroring the turn_trace buffer's MAX_PENDING_TURNS) evicted
    // the oldest; the newest turn is always present.
    expect(funnelStage("t_leak_0")).toBeUndefined();
    expect(funnelStage("t_leak_699")).toBeDefined();
    for (let i = 0; i < 700; i += 1) closeFunnelTurn(`t_leak_${i}`);
  });
});

/**
 * BKL-276 — the tier predicate the claim short-circuit reads.
 *
 * A funnel STAMP alone never meant "this turn already has a reply", but the claim
 * path used to treat it that way (`stageFor(turnId) !== undefined`), which silenced
 * the claims plane on every L2 turn once a retriever was configured. These pins are
 * the cheap guard on the SPLIT itself; the turn-seam proof is in
 * `apps/api/src/__tests__/bkl276-funnel-claims-suppression.e2e.test.ts`.
 */
describe("BKL-276 — tierAuthorsOwnReply", () => {
  it("only L0 and ALIAS author their own reply", () => {
    // These two RESOLVE the turn from a deterministic template — no parse, no model
    // call — so the claim plane is correctly skipped for them.
    expect(tierAuthorsOwnReply("L0")).toBe(true);
    expect(tierAuthorsOwnReply("ALIAS")).toBe(true);
    // These two still PARSE; their reply is produced downstream exactly as on a
    // miss, and on a miss the claim plane runs — so it must run for them too.
    expect(tierAuthorsOwnReply("L1")).toBe(false);
    expect(tierAuthorsOwnReply("L2")).toBe(false);
  });

  it("agrees with the responder seam's reply(): the authoring tiers are exactly the ones that return a sentence", () => {
    const funnel = createL0Funnel();
    // L1/L2 stage records get no deterministic reply from the seam …
    for (const tier of ["L1", "L2"] as const) {
      const stage = {
        tier,
        reason: "scoped_parse",
        detail: {},
        at: new Date().toISOString(),
      };
      expect(funnel.reply(stage as never)).toBeUndefined();
      expect(tierAuthorsOwnReply(tier)).toBe(false);
    }
    // … while L0 does, for every social kind.
    for (const socialKind of ["greeting", "thanks", "farewell"] as const) {
      const stage = {
        tier: "L0",
        reason: "social_only",
        detail: { socialKind },
        at: new Date().toISOString(),
      };
      expect(funnel.reply(stage as never)).toBe(renderL0Reply(socialKind));
      expect(tierAuthorsOwnReply("L0")).toBe(true);
    }
  });
});
