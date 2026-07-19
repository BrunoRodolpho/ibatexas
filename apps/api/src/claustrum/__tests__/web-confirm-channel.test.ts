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
import { WebConfirmChannel } from "../web-confirm-channel.js";

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
