// T3-9 — autonomy ladder + Stage-0 soak gate.

import { describe, expect, it } from "vitest";
import { PIX_REMEDIATION_AGENT, AgentDefinitionSchema } from "@ibatexas/agents";
import {
  SOAK_MIN_DAYS,
  canPromoteToStage1,
  isAutoKind,
  nextStage,
  resolveExecutionMode,
} from "../claustrum/agent-autonomy.js";

const atStage = (stage: 0 | 1 | 2) =>
  AgentDefinitionSchema.parse({ ...PIX_REMEDIATION_AGENT, autonomyStage: stage });

describe("resolveExecutionMode — the ladder", () => {
  it("Stage 0 = shadow (sandbox swallows everything)", () => {
    expect(resolveExecutionMode(atStage(0))).toEqual({ mode: "shadow" });
  });

  it("Stage 1 = supervised: every declared kind is confirm-gated", () => {
    const mode = resolveExecutionMode(atStage(1));
    expect(mode.mode).toBe("supervised");
    if (mode.mode !== "supervised") throw new Error("unreachable");
    expect([...mode.confirmKinds].sort()).toEqual(
      ["payment.pix.regenerate", "pix.charge.refund"].sort(),
    );
  });

  it("Stage 2 = live: AUTO only for payment.pix.regenerate; refunds always confirm", () => {
    const mode = resolveExecutionMode(atStage(2));
    expect(mode.mode).toBe("live");
    if (mode.mode !== "live") throw new Error("unreachable");
    expect([...mode.autoKinds]).toEqual(["payment.pix.regenerate"]);
    expect([...mode.confirmKinds]).toEqual(["pix.charge.refund"]);
    // The allowlist gate is per-kind, not a blanket stage property.
    expect(isAutoKind(mode, "payment.pix.regenerate")).toBe(true);
    expect(isAutoKind(mode, "pix.charge.refund")).toBe(false);
  });
});

describe("canPromoteToStage1 — Stage-0 soak gate (D-017, calendar-gated)", () => {
  const activatedAt = "2026-06-12T00:00:00.000Z";
  const startMs = Date.parse(activatedAt);
  const day = 86_400_000;

  it("refuses before the 7-day soak even with runs + quiet drift", () => {
    const gate = canPromoteToStage1(
      atStage(0),
      { activatedAt, runCount: 50, driftQuiet: true },
      startMs + 6 * day, // 6 days < 7
    );
    expect(gate.ok).toBe(false);
    expect(gate.reasons.join(" ")).toMatch(/soak .* < required 7d/);
  });

  it("permits the flip once soak ≥ 7d with runs + quiet drift", () => {
    const gate = canPromoteToStage1(
      atStage(0),
      { activatedAt, runCount: 50, driftQuiet: true },
      startMs + (SOAK_MIN_DAYS + 0.1) * day,
    );
    expect(gate.ok, gate.reasons.join("; ")).toBe(true);
    expect(gate.soakDays).toBeGreaterThanOrEqual(SOAK_MIN_DAYS);
  });

  it("refuses when never activated, no runs, or drift not quiet", () => {
    expect(canPromoteToStage1(atStage(0), { activatedAt: null, runCount: 0, driftQuiet: true }, startMs).ok).toBe(false);
    const noRuns = canPromoteToStage1(
      atStage(0),
      { activatedAt, runCount: 0, driftQuiet: true },
      startMs + 8 * day,
    );
    expect(noRuns.ok).toBe(false);
    expect(noRuns.reasons.join(" ")).toMatch(/no journaled shadow runs/);
    const noisy = canPromoteToStage1(
      atStage(0),
      { activatedAt, runCount: 5, driftQuiet: false },
      startMs + 8 * day,
    );
    expect(noisy.ok).toBe(false);
    expect(noisy.reasons.join(" ")).toMatch(/drift signal not quiet/);
  });

  it("refuses to 'promote' an agent that is not at Stage 0", () => {
    const gate = canPromoteToStage1(
      atStage(1),
      { activatedAt, runCount: 50, driftQuiet: true },
      startMs + 8 * day,
    );
    expect(gate.ok).toBe(false);
    expect(gate.reasons.join(" ")).toMatch(/not 0/);
  });
});

describe("nextStage", () => {
  it("climbs 0→1→2 and saturates at 2", () => {
    expect(nextStage(0)).toBe(1);
    expect(nextStage(1)).toBe(2);
    expect(nextStage(2)).toBe(2);
  });
});
