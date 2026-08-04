// park-reply-triage — the ONE owner of the ingress park-reply decision (R4-S1).
//
// Drives the decision TABLE directly with synthetic parks across BOTH shipped
// plane policies (ops = confirm-TTL + verb-scope exclusion + stale branch + ops
// copy; web-customer = no TTL, no stale branch, customer copy, narrower
// soft-affirmative admission):
//   - branch selection + the ordering the module declares (and the reason the
//     three branches can never both fire on either shipped policy);
//   - TTL partitioning + the fresh-beats-expired precedence rule;
//   - verb-scope exclusion applied to EVERY park read (notice, restate, decline,
//     prune) — BKL-086 parity;
//   - soft-shaped (ops) vs soft-affirmative-ONLY (web) admission;
//   - pure-negative decline + the MIXED money-safe non-decline;
//   - zombie prune: exactly the expired in-scope set, and ONLY on the stale branch;
//   - the fail-honest unpark contract's mechanical half: `unparkParks` unparks in
//     order and PROPAGATES a failure so the ingress can fall through.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ParkedEnvelope, SessionPort } from "@claustrum/core";
import { OPS_FOREIGN_ADVERTISED_REFUND_KIND } from "@ibatexas/pack-ops";
import { excludedKindsForScope } from "../../ops/ops-verb-scope.js";
import {
  OPS_NEGATIVE_DECLINE_ACK_PTBR,
  opsParkTriagePolicy,
  triageParkReply,
  unparkParks,
  WEB_NEGATIVE_DECLINE_ACK_PTBR,
  customerParkTriagePolicy,
  type ParkTriagePolicy,
} from "../park-reply-triage.js";

/** A park with an explicit kind + prompt, so scope exclusion and the restated
 *  copy are both observable. */
function parked(input: {
  hash: string;
  parkedAt: string;
  kind?: string;
  prompt?: string;
}): ParkedEnvelope {
  return {
    envelope: {
      intentHash: input.hash,
      kind: input.kind ?? "product.availability.set",
    } as ParkedEnvelope["envelope"],
    confirmationToken: `tok-${input.hash}`,
    userPrompt: input.prompt ?? "86 a picanha",
    parkedAt: input.parkedAt,
  };
}

const NOW = "2026-07-04T12:00:00.000Z";
/** 60s old — well inside the default 900s confirm TTL. */
const FRESH_AT = "2026-07-04T11:59:00.000Z";
/** 2h old — far outside it. */
const EXPIRED_AT = "2026-07-04T10:00:00.000Z";

const FRESH = parked({ hash: "aaaa11112222", parkedAt: FRESH_AT, prompt: "86 a picanha" });
const EXPIRED = parked({
  hash: "bbbb33334444",
  parkedAt: EXPIRED_AT,
  prompt: "muda o preço da costela para R$ 89",
});
// The REAL dashboard-only money verb the WhatsApp scope subtracts (BKL-086), so
// the exclusion coverage binds to production config, not a synthetic kind.
const REFUND_FRESH = parked({
  hash: "cccc55556666",
  parkedAt: FRESH_AT,
  kind: OPS_FOREIGN_ADVERTISED_REFUND_KIND,
  prompt: "reembolsa o pedido 4242",
});
const REFUND_EXPIRED = parked({
  hash: "dddd77778888",
  parkedAt: EXPIRED_AT,
  kind: OPS_FOREIGN_ADVERTISED_REFUND_KIND,
  prompt: "reembolsa o pedido 4242",
});

const WHATSAPP_EXCLUDED = excludedKindsForScope("whatsapp");

const OPS = (): ParkTriagePolicy => opsParkTriagePolicy({ eventPrefix: "ops_chat" });
const OPS_WA = (): ParkTriagePolicy =>
  opsParkTriagePolicy({ excludedKinds: WHATSAPP_EXCLUDED, eventPrefix: "ops_wa" });
/** The CUSTOMER plane policy. Named `WEB` for the surface these cases were written
 *  against; since the 2026-08-04 mandate the customer WhatsApp surface declares the
 *  SAME policy (only its `eventPrefix` differs), so every case below holds for both. */
const WEB = (): ParkTriagePolicy => customerParkTriagePolicy();

function triage(
  text: string,
  pending: ReadonlyArray<ParkedEnvelope> | undefined,
  policy: ParkTriagePolicy,
  nowIso = NOW,
) {
  return triageParkReply({ text, pendingConfirmations: pending, nowIso, policy });
}

afterEach(() => {
  delete process.env.OPS_CONFIRM_PARK_TTL_SECONDS;
});

describe("triageParkReply — no park, no triage", () => {
  it("an empty park list PROCEEDS for every reply shape (the fresh-utterance floor)", () => {
    for (const text of ["sim", "não", "ok", "#aaaa1111", "amanhã", "86 a picanha"]) {
      expect(triage(text, [], OPS()).kind).toBe("proceed-with-turn");
      expect(triage(text, [], WEB()).kind).toBe("proceed-with-turn");
    }
  });

  it("an UNDEFINED park list (no loaded session) PROCEEDS", () => {
    expect(triage("não", undefined, OPS()).kind).toBe("proceed-with-turn");
    expect(triage("ok", undefined, WEB()).kind).toBe("proceed-with-turn");
  });

  it("an ordinary command while a park is open PROCEEDS (the normal loop owns it)", () => {
    expect(triage("86 a costela", [FRESH], OPS()).kind).toBe("proceed-with-turn");
    expect(triage("quero uma picanha", [FRESH], WEB()).kind).toBe("proceed-with-turn");
  });

  it("an EXPLICIT confirm PROCEEDS on both planes — the adjudicated resume path is untouched", () => {
    expect(triage("sim", [FRESH], OPS()).kind).toBe("proceed-with-turn");
    expect(triage("confirmo", [FRESH], WEB()).kind).toBe("proceed-with-turn");
  });

  it("a #hash and a defer phrase PROCEED (the normal loop resolves both)", () => {
    expect(triage("#aaaa1111", [FRESH], OPS()).kind).toBe("proceed-with-turn");
    expect(triage("amanhã", [FRESH], OPS()).kind).toBe("proceed-with-turn");
    expect(triage("#aaaa1111", [FRESH], WEB()).kind).toBe("proceed-with-turn");
    expect(triage("depois", [FRESH], WEB()).kind).toBe("proceed-with-turn");
  });
});

describe("triageParkReply — branch 1: stale-resume (ops TTL plane only)", () => {
  it("'sim' on an EXPIRED park → the honest expiry notice naming the park's prompt", () => {
    const verdict = triage("sim", [EXPIRED], OPS());
    expect(verdict.kind).toBe("skip-with-reply");
    if (verdict.kind !== "skip-with-reply") return;
    expect(verdict.branch).toBe("stale-resume");
    expect(verdict.notice).toBe(
      'A confirmação pendente expirou e NÃO foi executada: "muda o preço da costela para R$ 89". Por segurança, repita o comando se ainda quiser executá-lo.',
    );
    expect(verdict.unpark).toEqual([]);
  });

  it("a SOFT 'pode' on an expired park still restates the EXPIRY (broad detection)", () => {
    const verdict = triage("pode", [EXPIRED], OPS());
    expect(verdict.kind === "skip-with-reply" && verdict.branch).toBe("stale-resume");
  });

  it("a 'não' on an expired park restates the EXPIRY, never a decline (nothing to cancel)", () => {
    const verdict = triage("não", [EXPIRED], OPS());
    expect(verdict.kind === "skip-with-reply" && verdict.branch).toBe("stale-resume");
    expect(verdict.kind === "skip-with-reply" && verdict.unpark).toEqual([]);
  });

  it("FRESH BEATS EXPIRED: a fresh park the reply resumes suppresses the expiry notice", () => {
    // A legitimate fresh confirm must never be shadowed by an older park's expiry.
    expect(triage("sim", [EXPIRED, FRESH], OPS()).kind).toBe("proceed-with-turn");
  });

  it("the TTL is the boundary: a park at exactly the TTL is EXPIRED, just under is FRESH", () => {
    process.env.OPS_CONFIRM_PARK_TTL_SECONDS = "600";
    const at600s = parked({ hash: "eeee9999aaaa", parkedAt: "2026-07-04T11:50:00.000Z" });
    const at599s = parked({ hash: "ffff0000bbbb", parkedAt: "2026-07-04T11:50:01.000Z" });
    expect(triage("sim", [at600s], OPS()).kind).toBe("skip-with-reply");
    expect(triage("sim", [at599s], OPS()).kind).toBe("proceed-with-turn");
  });

  it("an unparseable clock keeps EVERY branch silent (fail-safe — expiry cannot be asserted)", () => {
    expect(triage("sim", [EXPIRED], OPS(), "not-a-date").kind).toBe("proceed-with-turn");
    expect(triage("pode", [FRESH], OPS(), "not-a-date").kind).toBe("proceed-with-turn");
    expect(triage("não", [FRESH], OPS(), "not-a-date").kind).toBe("proceed-with-turn");
  });

  it("the WEB-CUSTOMER plane has NO stale branch: an ancient park is still LIVE", () => {
    // Customer parks carry no expiresAt, so there is no honest expiry to assert —
    // an old park stays resumable and the niceties engage on it normally.
    expect(triage("sim", [EXPIRED], WEB()).kind).toBe("proceed-with-turn");
    const verdict = triage("ok", [EXPIRED], WEB());
    expect(verdict.kind === "skip-with-reply" && verdict.branch).toBe(
      "soft-affirmative-restate",
    );
  });
});

describe("triageParkReply — branch 2: soft-affirmative restate", () => {
  it("ops: a bare 'pode' on a FRESH park restates it and asks for an explicit confirm", () => {
    const verdict = triage("pode", [FRESH], OPS());
    expect(verdict.kind).toBe("skip-with-reply");
    if (verdict.kind !== "skip-with-reply") return;
    expect(verdict.branch).toBe("soft-affirmative-restate");
    expect(verdict.notice).toBe(
      'Só confirmando — você quer que eu execute "86 a picanha"? Responda "sim" ou "confirmo" para eu executar.',
    );
    // The park SURVIVES so a follow-up "sim" executes it.
    expect(verdict.unpark).toEqual([]);
    expect(verdict.prune).toEqual([]);
  });

  it("web: the CUSTOMER copy is a different sentence, from the same park prompt", () => {
    const verdict = triage("ok", [FRESH], WEB());
    expect(verdict.kind === "skip-with-reply" && verdict.notice).toBe(
      'Só confirmando — você quer que eu faça "86 a picanha"? Responda "sim" para eu seguir.',
    );
  });

  it("ADMISSION differs by plane: a soft yes that ALSO carries content restates on OPS, not on WEB", () => {
    const text = "ok muda para 19h";
    const opsVerdict = triage(text, [FRESH], OPS());
    expect(opsVerdict.kind === "skip-with-reply" && opsVerdict.branch).toBe(
      "soft-affirmative-restate",
    );
    // The customer asked for something NEW — restating would drop it, so the
    // normal loop must answer.
    expect(triage(text, [FRESH], WEB()).kind).toBe("proceed-with-turn");
  });

  it("a BARE soft yes restates on BOTH planes (punctuation is not content)", () => {
    for (const text of ["ok", "ok!", "pode", "beleza", "claro"]) {
      expect(triage(text, [FRESH], OPS()).kind).toBe("skip-with-reply");
      expect(triage(text, [FRESH], WEB()).kind).toBe("skip-with-reply");
    }
  });

  it("restates the MOST RECENT fresh park when several are open", () => {
    const older = parked({ hash: "1111aaaabbbb", parkedAt: "2026-07-04T11:58:00.000Z", prompt: "primeiro" });
    const newer = parked({ hash: "2222ccccdddd", parkedAt: "2026-07-04T11:59:30.000Z", prompt: "segundo" });
    const verdict = triage("pode", [older, newer], OPS());
    expect(verdict.kind === "skip-with-reply" && verdict.notice).toContain('"segundo"');
  });

  it("does NOT prune, even when an expired park coexists with the fresh one", () => {
    const verdict = triage("pode", [EXPIRED, FRESH], OPS());
    expect(verdict.kind).toBe("skip-with-reply");
    if (verdict.kind !== "skip-with-reply") return;
    expect(verdict.branch).toBe("soft-affirmative-restate");
    expect(verdict.prune).toEqual([]);
  });
});

describe("triageParkReply — branch 3: pure-negative decline", () => {
  it("ops: 'não, cancela essa ação' names the fresh park to unpark + the ops ACK", () => {
    const verdict = triage("não, cancela essa ação", [FRESH], OPS());
    expect(verdict.kind).toBe("skip-with-reply");
    if (verdict.kind !== "skip-with-reply") return;
    expect(verdict.branch).toBe("negative-decline");
    expect(verdict.notice).toBe(OPS_NEGATIVE_DECLINE_ACK_PTBR);
    expect(verdict.notice).toBe("Ok, cancelei a ação pendente — nada foi executado.");
    expect(verdict.unpark).toEqual([FRESH]);
    expect(verdict.prune).toEqual([]);
  });

  it("web: the same shape, the CUSTOMER ACK", () => {
    const verdict = triage("não", [FRESH], WEB());
    expect(verdict.kind).toBe("skip-with-reply");
    if (verdict.kind !== "skip-with-reply") return;
    expect(verdict.branch).toBe("negative-decline");
    expect(verdict.notice).toBe(WEB_NEGATIVE_DECLINE_ACK_PTBR);
    expect(verdict.unpark).toEqual([FRESH]);
  });

  it("MONEY-SAFETY: a MIXED reply ('não, pode deixar') declines NOTHING on either plane", () => {
    // Ambiguous about the DECISION — the park survives rather than executing a
    // refusal or being silently abandoned.
    expect(triage("não, pode deixar", [FRESH], OPS()).kind).toBe("proceed-with-turn");
    expect(triage("não, pode deixar", [FRESH], WEB()).kind).toBe("proceed-with-turn");
    expect(triage("ok, cancela", [FRESH], OPS()).kind).toBe("proceed-with-turn");
  });

  it("declines the MOST RECENT fresh park only — the rest stay parked", () => {
    const older = parked({ hash: "1111aaaabbbb", parkedAt: "2026-07-04T11:58:00.000Z" });
    const newer = parked({ hash: "2222ccccdddd", parkedAt: "2026-07-04T11:59:30.000Z" });
    const verdict = triage("não", [older, newer], OPS());
    expect(verdict.kind === "skip-with-reply" && verdict.unpark).toEqual([newer]);
  });
});

describe("verb-scope exclusion — applied to EVERY park read (BKL-086 parity)", () => {
  it("an out-of-scope FRESH money park is invisible to the restate branch", () => {
    expect(triage("pode", [REFUND_FRESH], OPS_WA()).kind).toBe("proceed-with-turn");
    // …while the dashboard, which excludes nothing, restates it.
    expect(triage("pode", [REFUND_FRESH], OPS()).kind).toBe("skip-with-reply");
  });

  it("an out-of-scope FRESH money park is invisible to the decline branch", () => {
    expect(triage("não", [REFUND_FRESH], OPS_WA()).kind).toBe("proceed-with-turn");
    expect(triage("não", [REFUND_FRESH], OPS()).kind).toBe("skip-with-reply");
  });

  it("an out-of-scope EXPIRED money park is neither RESTATED nor PRUNED", () => {
    expect(triage("sim", [REFUND_EXPIRED], OPS_WA()).kind).toBe("proceed-with-turn");
    const dashboard = triage("sim", [REFUND_EXPIRED], OPS());
    expect(dashboard.kind).toBe("skip-with-reply");
    if (dashboard.kind !== "skip-with-reply") return;
    expect(dashboard.prune).toEqual([REFUND_EXPIRED]);
  });

  it("an IN-SCOPE expired park IS restated + pruned even when an excluded one coexists", () => {
    const verdict = triage("sim", [REFUND_EXPIRED, EXPIRED], OPS_WA());
    expect(verdict.kind).toBe("skip-with-reply");
    if (verdict.kind !== "skip-with-reply") return;
    expect(verdict.notice).toContain("muda o preço da costela para R$ 89");
    expect(verdict.prune).toEqual([EXPIRED]);
  });

  it("an out-of-scope fresh park does NOT grant fresh-precedence over an in-scope expired one", () => {
    // The WhatsApp surface could not resume the refund park, so it must not use it
    // to suppress the in-scope expiry notice.
    const verdict = triage("sim", [REFUND_FRESH, EXPIRED], OPS_WA());
    expect(verdict.kind === "skip-with-reply" && verdict.branch).toBe("stale-resume");
    // The dashboard CAN resume the refund park, so there the fresh one wins.
    expect(triage("sim", [REFUND_FRESH, EXPIRED], OPS()).kind).toBe("proceed-with-turn");
  });
});

describe("zombie prune — exactly the expired in-scope set, and only on the stale branch", () => {
  it("names every expired in-scope park and no fresh one", () => {
    const otherExpired = parked({ hash: "9999eeeeffff", parkedAt: EXPIRED_AT });
    const verdict = triage("sim", [EXPIRED, otherExpired], OPS());
    expect(verdict.kind).toBe("skip-with-reply");
    if (verdict.kind !== "skip-with-reply") return;
    expect(verdict.prune).toEqual([EXPIRED, otherExpired]);
  });

  it("the WEB plane never names a zombie (no TTL ⇒ nothing is expired)", () => {
    const verdict = triage("não", [EXPIRED, FRESH], WEB());
    expect(verdict.kind === "skip-with-reply" && verdict.prune).toEqual([]);
  });
});

describe("branch precedence — the three branches are DISJOINT by construction", () => {
  // The declared order is stale → soft → negative. On both shipped policies no two
  // branches can fire for the same reply, which is the stronger statement: the
  // stale branch yields whenever a fresh in-scope park matches the reply (so soft
  // and negative own that window), and the soft/negative text predicates are
  // mutually exclusive (a soft affirmative admits no negative token and vice
  // versa). A future edit that makes two branches overlap breaks this test.
  const REPLIES = [
    "sim",
    "confirmo",
    "não",
    "não, cancela essa ação",
    "não, pode deixar",
    "ok",
    "ok!",
    "pode",
    "ok muda para 19h",
    "#bbbb3333",
    "#zzzz9999",
    "amanhã",
    "mais tarde",
    "86 a costela",
    "",
  ];
  const PARK_SETS: ReadonlyArray<ReadonlyArray<ParkedEnvelope>> = [
    [],
    [FRESH],
    [EXPIRED],
    [EXPIRED, FRESH],
    [REFUND_FRESH, EXPIRED],
    [REFUND_EXPIRED, FRESH],
  ];

  it("every (reply × park set × policy) yields at most ONE branch, deterministically", () => {
    // Counted so the sweep can never pass by producing zero skips.
    const seen = new Set<string>();
    let skips = 0;
    for (const policy of [OPS, OPS_WA, WEB]) {
      for (const parks of PARK_SETS) {
        for (const text of REPLIES) {
          const first = triage(text, parks, policy());
          const second = triage(text, parks, policy());
          expect(second).toEqual(first);
          if (first.kind === "skip-with-reply") {
            skips += 1;
            seen.add(first.branch);
            // A skip always carries a non-empty deterministic pt-BR notice.
            expect(first.notice.length).toBeGreaterThan(0);
            // Only the decline branch mutates; only the stale branch prunes.
            expect(first.unpark.length > 0).toBe(first.branch === "negative-decline");
            expect(first.prune.length > 0 && first.branch !== "stale-resume").toBe(false);
          }
        }
      }
    }
    expect(skips).toBeGreaterThan(0);
    // All three branches are actually exercised by the sweep.
    expect([...seen].sort()).toEqual([
      "negative-decline",
      "soft-affirmative-restate",
      "stale-resume",
    ]);
  });

  it("the WEB policy never yields a stale-resume branch for any input", () => {
    let skips = 0;
    for (const parks of PARK_SETS) {
      for (const text of REPLIES) {
        const verdict = triage(text, parks, WEB());
        if (verdict.kind === "skip-with-reply") {
          skips += 1;
          expect(verdict.branch).not.toBe("stale-resume");
        }
      }
    }
    expect(skips).toBeGreaterThan(0);
  });
});

describe("structured event tags — <surface prefix>.<branch>", () => {
  it("each surface stamps its own namespace on the same branch", () => {
    const wa = triage("sim", [EXPIRED], OPS_WA());
    const dash = triage("sim", [EXPIRED], OPS());
    expect(wa.kind === "skip-with-reply" && wa.event).toBe("ops_wa.stale_park_notice");
    expect(dash.kind === "skip-with-reply" && dash.event).toBe(
      "ops_chat.stale_park_notice",
    );
  });

  it("the suffix names the branch (the three tags the ingresses log today)", () => {
    const stale = triage("sim", [EXPIRED], OPS());
    const soft = triage("pode", [FRESH], OPS());
    const decline = triage("não", [FRESH], OPS());
    expect(stale.kind === "skip-with-reply" && stale.event).toBe(
      "ops_chat.stale_park_notice",
    );
    expect(soft.kind === "skip-with-reply" && soft.event).toBe(
      "ops_chat.soft_affirm_restate",
    );
    expect(decline.kind === "skip-with-reply" && decline.event).toBe(
      "ops_chat.negative_declined_park",
    );
  });

  it("the web-customer plane defaults to the `chat` namespace", () => {
    const verdict = triage("não", [FRESH], WEB());
    expect(verdict.kind === "skip-with-reply" && verdict.event).toBe(
      "chat.negative_declined_park",
    );
  });

  it("BYTE-IDENTITY — every tag the three ingresses logged before the extraction", () => {
    // The tags were hardcoded string literals at each copy; they are now composed
    // from the surface's declared prefix. This pins the composed value of all
    // EIGHT of them (web has no stale branch) against the pre-extraction spelling.
    const tagOf = (
      text: string,
      parks: ReadonlyArray<ParkedEnvelope>,
      policy: ParkTriagePolicy,
    ): string => {
      const verdict = triage(text, parks, policy);
      if (verdict.kind !== "skip-with-reply") throw new Error(`expected a skip: ${text}`);
      return verdict.event;
    };
    // ops-whatsapp-ingress.ts
    expect(tagOf("sim", [EXPIRED], OPS_WA())).toBe("ops_wa.stale_park_notice");
    expect(tagOf("pode", [FRESH], OPS_WA())).toBe("ops_wa.soft_affirm_restate");
    expect(tagOf("não", [FRESH], OPS_WA())).toBe("ops_wa.negative_declined_park");
    // routes/admin/ops-chat.ts
    expect(tagOf("sim", [EXPIRED], OPS())).toBe("ops_chat.stale_park_notice");
    expect(tagOf("pode", [FRESH], OPS())).toBe("ops_chat.soft_affirm_restate");
    expect(tagOf("não", [FRESH], OPS())).toBe("ops_chat.negative_declined_park");
    // routes/chat.ts
    expect(tagOf("ok", [FRESH], WEB())).toBe("chat.soft_affirm_restate");
    expect(tagOf("não", [FRESH], WEB())).toBe("chat.negative_declined_park");
  });
});

describe("unparkParks — the fail-honest contract's mechanical half", () => {
  it("unparks every named park, in order, against the given sessionId", async () => {
    const unpark = vi.fn<SessionPort["unpark"]>().mockResolvedValue(undefined);
    const removed = await unparkParks({
      session: { unpark },
      sessionId: "system:staff:s1",
      parks: [EXPIRED, FRESH],
    });
    expect(unpark.mock.calls).toEqual([
      ["system:staff:s1", EXPIRED.envelope.intentHash],
      ["system:staff:s1", FRESH.envelope.intentHash],
    ]);
    expect(removed).toEqual([EXPIRED, FRESH]);
  });

  it("PROPAGATES a failure (never swallows) — the ingress owns what it means", async () => {
    // This is what lets the ingress fall through to the turn on a decline whose
    // unpark did not stick, instead of acknowledging a cancellation that failed.
    const unpark = vi
      .fn<SessionPort["unpark"]>()
      .mockRejectedValue(new Error("redis down"));
    await expect(
      unparkParks({ session: { unpark }, sessionId: "web:c1", parks: [FRESH] }),
    ).rejects.toThrow("redis down");
  });

  it("an empty list is a no-op (nothing to unpark on the restate branch)", async () => {
    const unpark = vi.fn<SessionPort["unpark"]>().mockResolvedValue(undefined);
    expect(await unparkParks({ session: { unpark }, sessionId: "web:c1", parks: [] })).toEqual(
      [],
    );
    expect(unpark).not.toHaveBeenCalled();
  });
});

describe("plane policy — the declared adapter config", () => {
  it("the OPS policy declares TTL freshness, the stale branch, and soft-SHAPED admission", () => {
    const policy = opsParkTriagePolicy();
    expect(policy.freshness).toEqual({ kind: "confirm-ttl", ttlSeconds: 900 });
    expect(policy.staleResume).toBe(true);
    expect(policy.softAffirmativeAdmission).toBe("soft-shaped");
    expect(policy.excludedKinds.size).toBe(0);
    expect(policy.copy.negativeDeclineAck).toBe(OPS_NEGATIVE_DECLINE_ACK_PTBR);
  });

  it("the TTL is read from the env at CALL time (per turn, never frozen at import)", () => {
    process.env.OPS_CONFIRM_PARK_TTL_SECONDS = "60";
    expect(opsParkTriagePolicy().freshness).toEqual({
      kind: "confirm-ttl",
      ttlSeconds: 60,
    });
    // An explicit override still wins over the env.
    expect(opsParkTriagePolicy({ ttlSeconds: 30 }).freshness).toEqual({
      kind: "confirm-ttl",
      ttlSeconds: 30,
    });
  });

  it("the CUSTOMER plane policy (both customer surfaces) declares NO freshness, NO stale branch, and soft-ONLY admission", () => {
    const policy = customerParkTriagePolicy();
    expect(policy.freshness).toEqual({ kind: "none" });
    expect(policy.staleResume).toBe(false);
    expect(policy.softAffirmativeAdmission).toBe("soft-only");
    expect(policy.excludedKinds.size).toBe(0);
    // A plane whose parks never expire declares NO stale copy — it has no honest
    // expiry to assert, so the branch is structurally unavailable to it.
    expect(policy.copy.staleResumeNotice).toBeUndefined();
    expect(policy.copy.negativeDeclineAck).toBe(WEB_NEGATIVE_DECLINE_ACK_PTBR);
  });

  it("PURE — triaging never mutates the caller's park list", () => {
    const pending = [EXPIRED, FRESH];
    const snapshot = [...pending];
    triage("sim", pending, OPS());
    triage("pode", pending, OPS());
    triage("não", pending, WEB());
    expect(pending).toEqual(snapshot);
  });
});
