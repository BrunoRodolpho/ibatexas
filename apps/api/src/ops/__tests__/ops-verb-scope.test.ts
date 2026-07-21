// ops-verb-scope — the BKL-086 SIM-swap compensating control, unit-proven.
//
// Two deterministic composition-time filters + one named exclusion set:
//   - scopeCapabilityPlanner: the WhatsApp scope drops payment.refund.issue from
//     the planner's advertised/allowlisted intents while keeping every reversible
//     verb (86/notes/transition/alert/incident) and the ops_snapshot read.
//   - scopeResumeChannel: the WhatsApp scope hides an out-of-scope PARKED verb
//     from matchToParked, so "sim" over WhatsApp can NEVER resume a dashboard-
//     parked refund — while the (unscoped) dashboard channel resumes it normally.
//   - dashboard scope excludes nothing ⇒ both filters are identity.

import { describe, expect, it, vi } from "vitest";
import type { IntentEnvelope } from "@adjudicate/core";
import type {
  ChannelDriver,
  ChannelMessage,
  ParkedEnvelope,
  Session,
} from "@claustrum/core";
import {
  opsCapabilityPlanner,
  OPS_FOREIGN_ADVERTISED_REFUND_KIND,
  OPS_FOREIGN_ADVERTISED_KIND,
  OPS_FOREIGN_ADVERTISED_TRANSITION_KIND,
  OPS_ALERT_RESOLVE_STAFF_KIND,
  OPS_INCIDENT_CLOSE_STAFF_KIND,
  OPS_SNAPSHOT_READ_TOOL,
  type OpsContext,
  type OpsState,
} from "@ibatexas/pack-ops";
import { OpsSystemChannel } from "../ops-system-channel.js";
import {
  excludedKindsForScope,
  scopeCapabilityPlanner,
  scopeResumeChannel,
  WA_EXCLUDED_OPS_KINDS,
} from "../ops-verb-scope.js";

const STAFF_STATE: OpsState = {
  ctx: { channel: "staff", customerId: null, staffId: "staff_1" },
};
const STAFF_CTX: OpsContext = { channel: "staff", customerId: null, staffId: "staff_1" };

describe("excludedKindsForScope + WA_EXCLUDED_OPS_KINDS", () => {
  it("dashboard excludes nothing; whatsapp excludes the refund verb only", () => {
    expect(excludedKindsForScope("dashboard").size).toBe(0);
    const wa = excludedKindsForScope("whatsapp");
    expect(wa.has(OPS_FOREIGN_ADVERTISED_REFUND_KIND)).toBe(true);
    expect(wa).toBe(WA_EXCLUDED_OPS_KINDS);
    // The excluded set is money/two-person only — reversible verbs are NOT in it.
    expect(WA_EXCLUDED_OPS_KINDS.has(OPS_FOREIGN_ADVERTISED_KIND)).toBe(false);
    expect(WA_EXCLUDED_OPS_KINDS.has("product.availability.set")).toBe(false);
    expect(WA_EXCLUDED_OPS_KINDS.has(OPS_ALERT_RESOLVE_STAFF_KIND)).toBe(false);
  });
});

describe("scopeCapabilityPlanner", () => {
  it("dashboard (empty exclusion) returns the SAME planner reference (identity)", () => {
    const same = scopeCapabilityPlanner(opsCapabilityPlanner, excludedKindsForScope("dashboard"));
    expect(same).toBe(opsCapabilityPlanner);
  });

  it("WhatsApp scope drops payment.refund.issue but keeps every reversible verb + the read", () => {
    // Baseline: the dashboard planner DOES advertise the refund verb on a staff
    // session (so the drop below is a real subtraction, not a vacuous pass).
    const dash = opsCapabilityPlanner.plan(STAFF_STATE, STAFF_CTX);
    expect(dash.allowedIntents).toContain(OPS_FOREIGN_ADVERTISED_REFUND_KIND);

    const wa = scopeCapabilityPlanner(opsCapabilityPlanner, WA_EXCLUDED_OPS_KINDS);
    const waPlan = wa.plan(STAFF_STATE, STAFF_CTX);

    // The money verb is NOT advertised on the WhatsApp plane…
    expect(waPlan.allowedIntents).not.toContain(OPS_FOREIGN_ADVERTISED_REFUND_KIND);
    // …but every reversible verb still is.
    expect(waPlan.allowedIntents).toContain("product.availability.set");
    expect(waPlan.allowedIntents).toContain(OPS_FOREIGN_ADVERTISED_KIND);
    expect(waPlan.allowedIntents).toContain(OPS_FOREIGN_ADVERTISED_TRANSITION_KIND);
    expect(waPlan.allowedIntents).toContain(OPS_ALERT_RESOLVE_STAFF_KIND);
    expect(waPlan.allowedIntents).toContain(OPS_INCIDENT_CLOSE_STAFF_KIND);
    // Exactly ONE fewer intent than the dashboard plan.
    expect(waPlan.allowedIntents).toHaveLength(dash.allowedIntents.length - 1);
    // Read tools are never touched by an intent-scope filter.
    expect(waPlan.visibleReadTools).toEqual(dash.visibleReadTools);
    expect(waPlan.visibleReadTools).toContain(OPS_SNAPSHOT_READ_TOOL);
  });

  it("returns the SAME plan object when nothing is filtered (a non-staff session advertises none)", () => {
    // A non-staff session advertises no intents, so the WhatsApp filter subtracts
    // nothing → fast-path returns the underlying plan unchanged.
    const nonStaff: OpsState = { ctx: { channel: "whatsapp", customerId: "c1", staffId: null } };
    const wa = scopeCapabilityPlanner(opsCapabilityPlanner, WA_EXCLUDED_OPS_KINDS);
    const base = opsCapabilityPlanner.plan(nonStaff, { channel: "whatsapp", customerId: "c1", staffId: null });
    const scoped = wa.plan(nonStaff, { channel: "whatsapp", customerId: "c1", staffId: null });
    expect(scoped.allowedIntents).toEqual([]);
    expect(scoped).toEqual(base);
  });
});

// ── scopeResumeChannel — the defense-in-depth resume gate ────────────────────

function envelope(kind: string, intentHash: string): IntentEnvelope {
  return {
    kind,
    intentHash,
    payload: {},
    actor: { principal: "user", sessionId: "admin:staff_1" },
    taint: "UNTRUSTED",
    nonce: "n",
  } as unknown as IntentEnvelope;
}

function park(kind: string, intentHash: string, parkedAt: string): ParkedEnvelope {
  return {
    envelope: envelope(kind, intentHash),
    confirmationToken: `tok-${intentHash}`,
    userPrompt: "confirma?",
    parkedAt,
  } as ParkedEnvelope;
}

function sessionWithParks(parks: ParkedEnvelope[]): Session {
  return {
    id: "system:staff:staff_1",
    customerId: "staff:staff_1",
    channel: "system",
    startedAt: "2026-07-04T00:00:00.000Z",
    lastActivityAt: "2026-07-04T00:00:00.000Z",
    pendingConfirmations: parks,
    deferredEnvelopes: [],
    activeGoals: [],
    workingMemory: { summary: "", facts: [], updatedAt: "2026-07-04T00:00:00.000Z" },
  } as Session;
}

// `receivedAt` matches the parks' `parkedAt` below, so every park is FRESH under
// the FE-D13 confirm-TTL and these scope-gating assertions stay independent of it
// (a real inbound always carries receivedAt; matchToParked reads it for freshness).
const SIM: ChannelMessage = {
  text: "sim, confirma",
  receivedAt: "2026-07-04T12:00:00.000Z",
} as ChannelMessage;

const opsChannel = new OpsSystemChannel({
  gatewaySigningKey: "test-ops-signing-key-abcdefghijklmnop",
  gateway: "ibatexas-ops-test",
});

describe("scopeResumeChannel — resume gating (defense in depth)", () => {
  it("dashboard (empty exclusion) returns the SAME channel reference (identity)", () => {
    const same = scopeResumeChannel(opsChannel, excludedKindsForScope("dashboard"));
    expect(same).toBe(opsChannel);
  });

  it("WhatsApp: a dashboard-parked refund is INVISIBLE to 'sim' (returns null)", () => {
    const scoped = scopeResumeChannel(opsChannel, WA_EXCLUDED_OPS_KINDS);
    const session = sessionWithParks([park(OPS_FOREIGN_ADVERTISED_REFUND_KIND, "abc123def456", "2026-07-04T12:00:00.000Z")]);
    // Control: the UNSCOPED (dashboard) channel WOULD resume this refund on "sim".
    expect(opsChannel.matchToParked(SIM, session)).not.toBeNull();
    // The WhatsApp scope hides the out-of-scope park → no resume.
    expect(scoped.matchToParked(SIM, session)).toBeNull();
  });

  it("WhatsApp: 'sim' resumes an IN-SCOPE park even when a refund is also parked", () => {
    const scoped = scopeResumeChannel(opsChannel, WA_EXCLUDED_OPS_KINDS);
    // The refund parked LAST (most-recent), the note earlier. Without the gate the
    // most-recent (refund) would match; WITH the gate the refund is invisible and
    // the in-scope note resumes.
    const notePark = park(OPS_FOREIGN_ADVERTISED_KIND, "note000000aa", "2026-07-04T12:00:00.000Z");
    const refundPark = park(OPS_FOREIGN_ADVERTISED_REFUND_KIND, "refund0000bb", "2026-07-04T12:05:00.000Z");
    const session = sessionWithParks([notePark, refundPark]);
    const match = scoped.matchToParked(SIM, session);
    expect(match).not.toBeNull();
    expect(match!.parked.envelope.kind).toBe(OPS_FOREIGN_ADVERTISED_KIND);
    expect(match!.userResolution).toBe("confirm");
  });

  it("delegates perceive/render/attest to the wrapped driver verbatim", async () => {
    const inner: ChannelDriver = {
      kind: "system",
      perceive: vi.fn(async () => ({ text: "x" }) as ChannelMessage),
      render: vi.fn(async () => {}),
      attest: vi.fn(async () => ({ envelope: {}, signature: "s", keyId: "k", alg: "HMAC-SHA256" }) as never),
      matchToParked: vi.fn(() => null),
    };
    const scoped = scopeResumeChannel(inner, WA_EXCLUDED_OPS_KINDS);
    expect(scoped.kind).toBe("system");
    await scoped.perceive({});
    await scoped.render({} as never);
    await scoped.attest({} as never);
    expect(inner.perceive).toHaveBeenCalledTimes(1);
    expect(inner.render).toHaveBeenCalledTimes(1);
    expect(inner.attest).toHaveBeenCalledTimes(1);
  });

  it("delegates the ORIGINAL session (no copy) when nothing is filtered", () => {
    const inner: ChannelDriver = {
      kind: "system",
      perceive: vi.fn(),
      render: vi.fn(),
      attest: vi.fn(),
      matchToParked: vi.fn(() => null),
    } as unknown as ChannelDriver;
    const scoped = scopeResumeChannel(inner, WA_EXCLUDED_OPS_KINDS);
    // Only an in-scope park → the filter subtracts nothing → the SAME session is
    // handed to the underlying matcher (fast path).
    const session = sessionWithParks([park(OPS_FOREIGN_ADVERTISED_KIND, "note000000aa", "2026-07-04T12:00:00.000Z")]);
    scoped.matchToParked(SIM, session);
    expect((inner.matchToParked as ReturnType<typeof vi.fn>).mock.calls[0]![1]).toBe(session);
  });
});
