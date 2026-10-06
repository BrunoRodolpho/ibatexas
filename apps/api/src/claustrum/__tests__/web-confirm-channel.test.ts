// web-confirm-channel — the customer WEB matchToParked driver (BKL-033).
//
// WebConfirmChannel = WebChannel + a real matchToParked. It delegates to the
// plane-neutral pt-BR matcher (matchOpsReplyToParked); these tests pin the
// customer-plane WIRING and the money-safety-load-bearing branches through the
// driver: affirmative → confirm, negative → deny, MIXED → null (park kept), soft
// affirmative alone → null (FE-D32 explicit-execute), #hash targeting, and the
// load-bearing "sim with ZERO parks → null" (no cross-turn false resume).

import { describe, expect, it } from "vitest";
import type { ChannelMessage, ParkedEnvelope, Session } from "@claustrum/core";
import {
  WEB_NEGATIVE_DECLINE_ACK_PTBR,
  WebConfirmChannel,
  webNegativeDeclineTarget,
  webSoftAffirmativeRestateNotice,
} from "../web-confirm-channel.js";

function driver(): WebConfirmChannel {
  return new WebConfirmChannel({
    gatewaySigningKey: "test-web-gateway-signing-key-0123456789abcdef",
    sink: async () => {},
    gateway: "ibatexas-api-test",
  });
}

function parked(intentHash: string, parkedAt: string): ParkedEnvelope {
  return {
    envelope: { intentHash } as ParkedEnvelope["envelope"],
    confirmationToken: `tok-${intentHash}`,
    userPrompt: "Confirmar o cancelamento do pedido?",
    parkedAt,
  };
}

const P1 = parked("a4b8c1d2e3f4", "2026-07-19T12:00:00.000Z");
const P2 = parked("bb99887766ff", "2026-07-19T12:05:00.000Z"); // more recent

function session(pending: ReadonlyArray<ParkedEnvelope>): Session {
  return {
    id: "web:cus-1",
    customerId: "cus-1",
    channel: "web",
    startedAt: "2026-07-19T11:00:00.000Z",
    lastActivityAt: "2026-07-19T12:06:00.000Z",
    pendingConfirmations: pending,
    deferredEnvelopes: [],
    activeGoals: [],
    workingMemory: { summary: "", facts: [], updatedAt: "2026-07-19T11:00:00.000Z" },
  } as Session;
}

function evt(text: string): ChannelMessage {
  return {
    channel: "web",
    customerId: "cus-1",
    conversationId: "sess-uuid",
    externalId: "msg-1",
    text,
    receivedAt: "2026-07-19T12:06:00.000Z",
    locale: "pt-BR",
  };
}

describe("WebConfirmChannel.matchToParked — customer confirm-resume (BKL-033)", () => {
  it("inherits WebChannel's channel kind (a web driver, one per conductor)", () => {
    expect(driver().kind).toBe("web");
  });

  it("ZERO parks + 'sim' → null (fresh utterance; no false cross-turn resume)", () => {
    expect(driver().matchToParked(evt("sim, confirma"), session([]))).toBeNull();
  });

  it("explicit 'sim' → confirm the most-recent park (resume executes it)", () => {
    const m = driver().matchToParked(evt("sim, pode confirmar"), session([P1, P2]));
    expect(m?.userResolution).toBe("confirm");
    expect(m?.parked).toBe(P2); // most-recent by parkedAt
  });

  it("'confirmo' → confirm", () => {
    expect(driver().matchToParked(evt("confirmo"), session([P1]))?.userResolution).toBe(
      "confirm",
    );
  });

  it("clean 'não' → deny (core unparks; nothing executes)", () => {
    // A clean refusal with NO affirmative token (note: "isso" is a soft
    // affirmative, so "cancela isso" would be MIXED → null — see the pin below).
    const m = driver().matchToParked(evt("não quero"), session([P1, P2]));
    expect(m?.userResolution).toBe("deny");
    expect(m?.parked).toBe(P2);
  });

  it("MONEY-SAFETY — mixed affirmative+negative ('não, pode deixar') → null (park kept, never executes)", () => {
    expect(
      driver().matchToParked(evt("não, pode deixar"), session([P1, P2])),
    ).toBeNull();
  });

  it("FE-D32 — a bare SOFT affirmative ('ok') alone → null (too weak to EXECUTE; fresh loop runs)", () => {
    expect(driver().matchToParked(evt("ok"), session([P1]))).toBeNull();
  });

  it("#hash prefix targets a SPECIFIC parked envelope regardless of recency", () => {
    const m = driver().matchToParked(evt("#a4b8c1"), session([P1, P2]));
    expect(m?.userResolution).toBe("confirm");
    expect(m?.parked).toBe(P1); // older, but hash-targeted
  });

  it("an unrelated utterance → null (fresh turn, normal cognitive loop)", () => {
    expect(
      driver().matchToParked(evt("qual o horário de vocês?"), session([P1])),
    ).toBeNull();
  });
});

// ── BKL-212: the customer-web ingress niceties (PURE halves) ─────────────────
// These are the surfaces the SSE ingress consumes BEFORE handleTurn. They are
// deliberately the STRICT complement of `matchToParked` above: every reply the
// matcher resolves (explicit confirm / #hash / defer / mixed) must fall through
// here, so the two can never both claim the same turn.

describe("webNegativeDeclineTarget — a pure negative declines the park (BKL-212)", () => {
  it("a bare 'não' targets the MOST RECENT park", () => {
    expect(webNegativeDeclineTarget("não", [P1, P2])).toBe(P2);
  });

  it.each(["nao", "cancela", "cancelar", "não quero", "pare"])(
    "%j is a pure negative",
    (text) => {
      expect(webNegativeDeclineTarget(text, [P1])).toBe(P1);
    },
  );

  it("MONEY-SAFETY — a MIXED reply ('não, pode deixar') declines NOTHING (ambiguous; the park survives)", () => {
    expect(webNegativeDeclineTarget("não, pode deixar", [P1])).toBeUndefined();
  });

  it.each([
    ["an explicit confirm", "sim"],
    ["a soft affirmative", "ok"],
    ["a #hash reply", "#a4b8c1 não"],
    ["a defer phrase", "não, amanhã"],
    ["an ordinary utterance", "qual o horário de vocês?"],
    ["empty text", ""],
  ])("%s (%j) declines nothing — the normal loop owns it", (_label, text) => {
    expect(webNegativeDeclineTarget(text, [P1, P2])).toBeUndefined();
  });

  it("no park present → undefined for every input (today's path is untouched)", () => {
    expect(webNegativeDeclineTarget("não", [])).toBeUndefined();
    expect(webNegativeDeclineTarget("não", undefined)).toBeUndefined();
  });

  it("the ACK is pt-BR, states that nothing changed, and never claims an execution", () => {
    expect(WEB_NEGATIVE_DECLINE_ACK_PTBR).toBe(
      "Ok, não vou fazer isso — nada foi alterado. Se precisar de outra coisa, é só me dizer.",
    );
  });
});

describe("webSoftAffirmativeRestateNotice — a bare soft yes restates (BKL-212)", () => {
  it("restates the MOST RECENT park's stored prompt and asks for an explicit confirm", () => {
    expect(webSoftAffirmativeRestateNotice("ok", [P1, P2])).toBe(
      `Só confirmando — você quer que eu faça "${P2.userPrompt}"? Responda "sim" para eu seguir.`,
    );
  });

  it.each(["ok", "okay", "pode", "claro", "beleza", "manda", "isso", "OK!", "ok ok"])(
    "%j is a bare soft affirmative",
    (text) => {
      expect(webSoftAffirmativeRestateNotice(text, [P1])).toContain("Só confirmando");
    },
  );

  it.each([
    ["a soft yes carrying a NEW request", "ok mas muda para 19h"],
    ["a soft yes carrying content", "pode mandar o cardápio"],
    ["an explicit confirm", "sim"],
    ["an explicit confirm with a soft token", "sim, pode"],
    ["a negative", "não"],
    ["a mixed reply", "ok, cancela"],
    ["a #hash reply", "#a4b8c1 ok"],
    ["a defer phrase", "ok, amanhã"],
    ["an ordinary utterance", "quero uma costela"],
    ["empty text", ""],
  ])("%s (%j) restates nothing — the normal loop owns it", (_label, text) => {
    expect(webSoftAffirmativeRestateNotice(text, [P1, P2])).toBeUndefined();
  });

  it("no park present → undefined (nothing to restate)", () => {
    expect(webSoftAffirmativeRestateNotice("ok", [])).toBeUndefined();
    expect(webSoftAffirmativeRestateNotice("ok", undefined)).toBeUndefined();
  });

  it("COMPLEMENT — every reply the matcher RESOLVES is refused by both niceties", () => {
    // If a reply both resolved to a ParkedMatch AND triggered a nicety, the
    // ingress and the conductor would disagree about who owns the turn.
    for (const text of ["sim", "confirmo", "#a4b8c1", "amanhã", "não, pode deixar"]) {
      const resolved = driver().matchToParked(evt(text), session([P1, P2])) !== null;
      const nicety =
        webNegativeDeclineTarget(text, [P1, P2]) !== undefined ||
        webSoftAffirmativeRestateNotice(text, [P1, P2]) !== undefined;
      expect(resolved && nicety).toBe(false);
    }
  });

  it("COMPLEMENT — a bare soft yes and a pure negative are mutually exclusive", () => {
    for (const text of ["ok", "não", "cancela", "beleza"]) {
      const decline = webNegativeDeclineTarget(text, [P1]) !== undefined;
      const restate = webSoftAffirmativeRestateNotice(text, [P1]) !== undefined;
      expect(decline && restate).toBe(false);
    }
  });
});
