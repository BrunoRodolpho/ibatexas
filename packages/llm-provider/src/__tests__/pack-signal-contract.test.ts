/**
 * Cross-repo wire-signal contract — pins the value
 * `@adjudicate/pack-payments-pix` exports against what
 * `apps/api/src/subscribers/defer-resolver.ts` expects to find on the
 * NATS `payment.status_changed` subject.
 *
 * If a future Pack version renames the signal (the v1.0 plan in
 * `@adjudicate/pack-payments-pix`'s ADR-002), this test trips on the
 * dependency upgrade — forcing whoever bumps the Pack to also rename
 * the production NATS subject in `apps/api` (or to keep the old name
 * via the factory's `signal:` override). Defense in depth against
 * silent drift.
 */

import { describe, expect, it } from "vitest";
import { PIX_CONFIRMATION_SIGNAL } from "@adjudicate/pack-payments-pix";

describe("Pack signal contract — pins the wire value the apps publish", () => {
  it("PIX_CONFIRMATION_SIGNAL matches the production NATS subject", () => {
    expect(PIX_CONFIRMATION_SIGNAL).toBe("payment.confirmed");
  });
});
