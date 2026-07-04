// BKL-093 — AUDIT_REDACT_SECRET boot posture gate. Production fails CLOSED when
// the redaction salt is empty/absent; dev keeps a WARN. Both branches pinned.

import { describe, it, expect, vi } from "vitest";
import { assertAuditRedactSecretPosture } from "../audit-redact-secret-posture.js";

const makeLog = () => ({ warn: vi.fn() });

describe("assertAuditRedactSecretPosture (BKL-093)", () => {
  it("THROWS in production when the secret is empty", () => {
    const log = makeLog();
    expect(() =>
      assertAuditRedactSecretPosture({ nodeEnv: "production", secret: "", log }),
    ).toThrow(/AUDIT_REDACT_SECRET must be set in production/);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("THROWS in production when the secret is whitespace-only", () => {
    expect(() =>
      assertAuditRedactSecretPosture({ nodeEnv: "production", secret: "   ", log: makeLog() }),
    ).toThrow(/AUDIT_REDACT_SECRET/);
  });

  it("THROWS in production when the secret is absent (undefined)", () => {
    expect(() =>
      assertAuditRedactSecretPosture({ nodeEnv: "production", secret: undefined, log: makeLog() }),
    ).toThrow(/AUDIT_REDACT_SECRET/);
  });

  it("WARNs (does NOT throw) in dev when the secret is empty", () => {
    const log = makeLog();
    expect(() =>
      assertAuditRedactSecretPosture({ nodeEnv: "development", secret: "", log }),
    ).not.toThrow();
    expect(log.warn).toHaveBeenCalledTimes(1);
    const [obj] = log.warn.mock.calls[0];
    expect(obj).toMatchObject({ event: "audit_redact_secret.empty" });
  });

  it("is a NO-OP (no throw, no warn) when the secret is set, in any env", () => {
    const log = makeLog();
    assertAuditRedactSecretPosture({ nodeEnv: "production", secret: "x".repeat(32), log });
    assertAuditRedactSecretPosture({ nodeEnv: "development", secret: "abc", log });
    assertAuditRedactSecretPosture({ nodeEnv: undefined, secret: "abc", log });
    expect(log.warn).not.toHaveBeenCalled();
  });
});
