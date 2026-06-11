/**
 * F3 drift-evaluate job — the core eval fn maps DriftAlert[] → Prometheus series.
 *
 * Exercises evaluateDriftMetrics() directly (no BullMQ/Redis), mirroring the
 * defer-timeout-sweeper test style. evaluateDrift() is mocked so we control the
 * alerts; the job updates gauges/counter on a fresh prom-client Registry.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { Registry } from "prom-client";
import type { DriftAlert } from "@adjudicate/drift";

let alerts: ReadonlyArray<DriftAlert> = [];
let throwOnEval = false;

vi.mock("../../observability/drift-detector.js", () => ({
  evaluateDrift: () => {
    if (throwOnEval) throw new Error("detector boom");
    return alerts;
  },
}));

const { evaluateDriftMetrics, registerDriftMetrics } = await import(
  "../drift-evaluate.js"
);

function alert(partial: Partial<DriftAlert>): DriftAlert {
  return {
    dimension: "decision.kind",
    signal: "distribution_shift",
    magnitude: 0.8,
    threshold: 0.35,
    baselineCount: 500,
    recentCount: 500,
    ...partial,
  } as DriftAlert;
}

async function gaugeValue(
  reg: Registry,
  name: string,
  labels: Record<string, string>,
): Promise<number | undefined> {
  const json = await reg.getMetricsAsJSON();
  const metric = json.find((m) => m.name === name);
  const v = metric?.values.find((row) =>
    Object.entries(labels).every(([k, val]) => row.labels[k] === val),
  );
  return v?.value;
}

beforeEach(() => {
  alerts = [];
  throwOnEval = false;
});

describe("evaluateDriftMetrics", () => {
  it("maps an alert onto magnitude + alerts_total + active (category defaults to __all__)", async () => {
    const reg = new Registry();
    alerts = [alert({ dimension: "decision.kind", signal: "distribution_shift", magnitude: 0.8 })];
    const n = evaluateDriftMetrics(reg);
    expect(n).toBe(1);
    expect(
      await gaugeValue(reg, "ibx_behavioral_drift_magnitude", {
        dimension: "decision.kind",
        signal: "distribution_shift",
        category: "__all__",
      }),
    ).toBe(0.8);
    expect(
      await gaugeValue(reg, "ibx_behavioral_drift_alerts_total", {
        dimension: "decision.kind",
        signal: "distribution_shift",
      }),
    ).toBe(1);
    expect(
      await gaugeValue(reg, "ibx_behavioral_drift_active", {
        dimension: "decision.kind",
      }),
    ).toBe(1);
  });

  it("uses the implicated category label when present", async () => {
    const reg = new Registry();
    alerts = [alert({ dimension: "intent.kind", signal: "new_category", magnitude: 1, category: "payment.refund" })];
    evaluateDriftMetrics(reg);
    expect(
      await gaugeValue(reg, "ibx_behavioral_drift_magnitude", {
        dimension: "intent.kind",
        signal: "new_category",
        category: "payment.refund",
      }),
    ).toBe(1);
  });

  it("no alerts → all active gauges 0 and last_eval set", async () => {
    const reg = new Registry();
    alerts = [];
    expect(evaluateDriftMetrics(reg)).toBe(0);
    for (const dimension of ["decision.kind", "intent.kind", "basis"]) {
      expect(
        await gaugeValue(reg, "ibx_behavioral_drift_active", { dimension }),
      ).toBe(0);
    }
    const ts = await gaugeValue(reg, "ibx_behavioral_drift_last_eval_timestamp_seconds", {});
    expect(ts).toBeGreaterThan(0);
  });

  it("fails OPEN when the detector throws (returns 0, does not throw)", async () => {
    const reg = new Registry();
    throwOnEval = true;
    expect(() => evaluateDriftMetrics(reg)).not.toThrow();
    expect(evaluateDriftMetrics(reg)).toBe(0);
  });

  it("registerDriftMetrics is idempotent on a registry (no duplicate-name throw)", () => {
    const reg = new Registry();
    const a = registerDriftMetrics(reg);
    const b = registerDriftMetrics(reg);
    expect(b.magnitude).toBe(a.magnitude);
    expect(b.alertsTotal).toBe(a.alertsTotal);
  });

  it("does not collide with the kernel replay-drift metric name", async () => {
    const reg = new Registry();
    evaluateDriftMetrics(reg);
    const names = (await reg.getMetricsAsJSON()).map((m) => m.name);
    expect(names).not.toContain("kernel_replay_drift_total");
    expect(names).toContain("ibx_behavioral_drift_magnitude");
  });
});
