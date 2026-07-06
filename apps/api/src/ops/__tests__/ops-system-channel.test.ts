// ops-system-channel — the ops-plane matchToParked driver (BKL-085).
//
// Every branch of the pt-BR matcher: hash-prefix (hit / miss no-fall-through),
// defer-phrases, affirmatives, negatives, single-slot most-recent-by-parkedAt,
// mixed-signal precedence, and the load-bearing "sim with ZERO parks → null".

import { describe, expect, it } from "vitest";
import type { ChannelMessage, ParkedEnvelope, Session } from "@claustrum/core";
import {
  matchOpsReplyToParked,
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

  it.each(["não", "nao", "cancela", "para", "deixa", "negativo"])(
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
