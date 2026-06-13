// WS-B: qa-control hard-gate. The /internal/qa/* harness driver spawns child
// processes, so its registration gate MUST be unreachable outside local dev.
// These cases pin the env axes that short-circuit BEFORE the ibx-binary check
// (production / disabled / short-token), and that an aligned env passes them.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { qaControlGate } from "../qa-control.js";

const TOKEN_16 = "qa-ctl-test-token"; // 17-char fixture, not a secret // gitleaks:allow

describe("qa-control hard gate (qaControlGate)", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it("REFUSES under production even with the flag + token set", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("IBX_QA_CONTROL_ENABLED", "true");
    vi.stubEnv("IBX_QA_CONTROL_TOKEN", TOKEN_16);
    const gate = qaControlGate();
    expect(gate.ok).toBe(false);
    expect(gate.reason).toBe("production");
  });

  it("REFUSES when the flag is off", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("IBX_QA_CONTROL_ENABLED", "false");
    vi.stubEnv("IBX_QA_CONTROL_TOKEN", TOKEN_16);
    const gate = qaControlGate();
    expect(gate.ok).toBe(false);
    expect(gate.reason).toBe("disabled");
  });

  it("REFUSES (fail-closed) when the token is missing or < 16 chars", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("IBX_QA_CONTROL_ENABLED", "true");
    vi.stubEnv("IBX_QA_CONTROL_TOKEN", "tooshort");
    const gate = qaControlGate();
    expect(gate.ok).toBe(false);
    expect(gate.reason).toBe("token");
  });

  it("passes the env axes when all three line up (reason is never an env reason)", () => {
    // Whether `ok` is true depends only on the ibx binary being built
    // (cli/dist) — which is environment-dependent — so we assert only that the
    // SECURITY env gates all passed: the reason can no longer be an env reason.
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("IBX_QA_CONTROL_ENABLED", "true");
    vi.stubEnv("IBX_QA_CONTROL_TOKEN", TOKEN_16);
    const gate = qaControlGate();
    expect(["production", "disabled", "token"]).not.toContain(gate.reason);
    // reason is either undefined (ok) or "no-ibx-bin".
    expect(gate.ok || gate.reason === "no-ibx-bin").toBe(true);
  });
});
