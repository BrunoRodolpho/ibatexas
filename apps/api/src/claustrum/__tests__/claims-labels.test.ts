/**
 * claims-labels — the EXHAUSTIVE-COVERAGE guard (Plan 1 Track-A / FIX F3).
 *
 * CONTRACT pinned here: for every Trustworthiness-Triad read slot, the pt-BR
 * DISPLAY map (CLAIM_ENUM_DISPLAY_PT_BR) must carry an ACCENTED pt-BR string for
 * EVERY enum member the INVESTIGATE-stage read can emit — so no status the read
 * produces ever reaches the customer in raw English (Hard Rule #4). The member
 * domains are pulled from their AUTHORITATIVE sources (not re-typed here), so this
 * test FAILS the moment a new enum member is added upstream without a translation:
 *
 *   - PAYMENT_STATUS.status               → @ibatexas/types `PaymentStatus`
 *   - ORDER_FULFILLMENT_STAGE.fulfillmentStatus
 *                                         → @ibatexas/types `OrderFulfillmentStatus`
 *   - STORE_OPEN_NOW.mealPeriod           → ScheduleSignal["mealPeriod"] union
 *                                           (compile-time exhaustiveness, below)
 *
 * It also pins the SAFE fallback (an unmapped value degrades to the raw string)
 * and the C6 GUARD: localization is DISPLAY-only — it never returns the raw English
 * enum for a member that the customer-facing renderer would emit, and it never
 * mutates the bound value (this module only maps strings; the bound value lives in
 * the claim and is asserted untouched by the renderer tests).
 */

import { describe, expect, it } from "vitest";
import { OrderFulfillmentStatus } from "@ibatexas/types";
import { PaymentStatus } from "@ibatexas/types";
import type { ScheduleSignal } from "@ibatexas/tools";
import {
  CLAIM_ENUM_DISPLAY_PT_BR,
  localizeClaimEnum,
} from "../claims-labels.js";

// ── Authoritative enum domains the INVESTIGATE reads can emit ──────────────────

const PAYMENT_STATUS_MEMBERS: readonly string[] = Object.values(PaymentStatus);
const FULFILLMENT_MEMBERS: readonly string[] = Object.values(
  OrderFulfillmentStatus,
);

// mealPeriod has no runtime const (it is a string-literal union on ScheduleSignal),
// so we list it AND prove the list is exhaustive over the union at COMPILE time:
// if a member is ever added to the union this assignment stops type-checking.
const MEAL_PERIOD_MEMBERS = ["lunch", "dinner", "closed"] as const;
type _MealPeriodExhaustive =
  ScheduleSignal["mealPeriod"] extends (typeof MEAL_PERIOD_MEMBERS)[number]
    ? true
    : never;
const _mealPeriodExhaustive: _MealPeriodExhaustive = true;
void _mealPeriodExhaustive;

// `(claimType, field)` slot ↔ its full member domain.
const SLOT_DOMAINS: ReadonlyArray<{
  readonly claimType: string;
  readonly field: string;
  readonly members: readonly string[];
}> = [
  { claimType: "PAYMENT_STATUS", field: "status", members: PAYMENT_STATUS_MEMBERS },
  {
    claimType: "ORDER_FULFILLMENT_STAGE",
    field: "fulfillmentStatus",
    members: FULFILLMENT_MEMBERS,
  },
  {
    claimType: "STORE_OPEN_NOW",
    field: "mealPeriod",
    members: [...MEAL_PERIOD_MEMBERS],
  },
];

// A member is "translated" only if its pt-BR display differs from the raw English
// enum AND carries no underscores (raw enum members are snake_case) — i.e. it is a
// real pt-BR phrase, not the raw value leaking through the safe fallback.
function isTranslated(raw: string, display: string): boolean {
  return display !== raw && !display.includes("_") && display.trim().length > 0;
}

describe("claims-labels — exhaustive pt-BR enum coverage (FIX F3)", () => {
  for (const { claimType, field, members } of SLOT_DOMAINS) {
    describe(`${claimType}.${field}`, () => {
      it("has a non-empty member domain to cover", () => {
        expect(members.length).toBeGreaterThan(0);
      });

      for (const member of members) {
        it(`maps "${member}" to an accented pt-BR display`, () => {
          const display = localizeClaimEnum(claimType, field, member);
          // FAILS if any emittable enum member lacks a real pt-BR translation
          // (the safe fallback would return the raw English member unchanged).
          expect(
            isTranslated(member, display),
            `enum member "${member}" of ${claimType}.${field} has no pt-BR mapping ` +
              `(got "${display}")`,
          ).toBe(true);
        });
      }
    });
  }

  it("the map keys exactly cover the Triad slots (no orphan/missing slots)", () => {
    const mapKeys = Object.keys(CLAIM_ENUM_DISPLAY_PT_BR).sort();
    const slotKeys = SLOT_DOMAINS.map((s) => `${s.claimType}.${s.field}`).sort();
    expect(mapKeys).toEqual(slotKeys);
  });

  it("every mapped display string is accented/phrase pt-BR, not a raw enum echo", () => {
    for (const [, members] of Object.entries(CLAIM_ENUM_DISPLAY_PT_BR)) {
      for (const [raw, display] of Object.entries(members)) {
        expect(isTranslated(raw, display), `${raw} → ${display}`).toBe(true);
      }
    }
  });
});

describe("claims-labels — SAFE fallback (degrade, never crash/fabricate)", () => {
  it("returns the raw value for an unmapped (claimType, field) slot", () => {
    expect(localizeClaimEnum("UNKNOWN_CLAIM", "status", "paid")).toBe("paid");
  });

  it("returns the raw value for an unmapped member of a known slot", () => {
    expect(localizeClaimEnum("PAYMENT_STATUS", "status", "brand_new_status")).toBe(
      "brand_new_status",
    );
  });

  it("is pure: same inputs ⟹ same output", () => {
    const a = localizeClaimEnum("PAYMENT_STATUS", "status", "paid");
    const b = localizeClaimEnum("PAYMENT_STATUS", "status", "paid");
    expect(a).toBe(b);
    expect(a).toBe("pago");
  });
});
