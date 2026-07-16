// ops-schedule-resolution — the pure SCN-127 NL→ISO date normalizer.
//
// Frozen-clock, timezone-correct: every case injects a fixed `now` so the
// resolution is deterministic, and one case proves the business day is computed
// in RESTAURANT_TIMEZONE (not UTC) at a day boundary.

import { describe, expect, it } from "vitest";
import {
  isValidIsoDate,
  localDateStr,
  resolveOverrideDate,
} from "../ops-schedule-resolution.js";

const SP = "America/Sao_Paulo";
// 2026-07-04 is a Saturday in São Paulo. Noon UTC = 09:00 SP, same calendar day.
const SAT_NOON = new Date("2026-07-04T12:00:00.000Z");

describe("resolveOverrideDate — relative words", () => {
  it('"hoje" → today', () => {
    expect(resolveOverrideDate("hoje", SP, SAT_NOON)).toBe("2026-07-04");
  });
  it('"amanhã" (accented) → today + 1', () => {
    expect(resolveOverrideDate("amanhã", SP, SAT_NOON)).toBe("2026-07-05");
  });
  it('"amanha" (unaccented) → today + 1', () => {
    expect(resolveOverrideDate("amanha", SP, SAT_NOON)).toBe("2026-07-05");
  });
  it('"depois de amanhã" → today + 2', () => {
    expect(resolveOverrideDate("depois de amanhã", SP, SAT_NOON)).toBe("2026-07-06");
  });
  it("trims + is case-insensitive", () => {
    expect(resolveOverrideDate("  AMANHÃ  ", SP, SAT_NOON)).toBe("2026-07-05");
  });
});

describe("resolveOverrideDate — weekday names", () => {
  // Saturday 2026-07-04 as the reference.
  it("a same-day weekday (sábado) → today (offset 0, inclusive)", () => {
    expect(resolveOverrideDate("sábado", SP, SAT_NOON)).toBe("2026-07-04");
  });
  it("the next domingo → tomorrow", () => {
    expect(resolveOverrideDate("domingo", SP, SAT_NOON)).toBe("2026-07-05");
  });
  it('"sexta-feira" (with -feira suffix) → the upcoming Friday', () => {
    expect(resolveOverrideDate("sexta-feira", SP, SAT_NOON)).toBe("2026-07-10");
  });
  it('"sexta" (bare) resolves identically to "sexta-feira"', () => {
    expect(resolveOverrideDate("sexta", SP, SAT_NOON)).toBe("2026-07-10");
  });
  it("terça → the upcoming Tuesday", () => {
    expect(resolveOverrideDate("terça", SP, SAT_NOON)).toBe("2026-07-07");
  });
});

describe("resolveOverrideDate — explicit ISO dates", () => {
  it("a real YYYY-MM-DD passes through verbatim (past-ness is the guard's job)", () => {
    expect(resolveOverrideDate("2026-07-20", SP, SAT_NOON)).toBe("2026-07-20");
    expect(resolveOverrideDate("2026-01-01", SP, SAT_NOON)).toBe("2026-01-01");
  });
  it("an impossible calendar date → null", () => {
    expect(resolveOverrideDate("2026-13-40", SP, SAT_NOON)).toBeNull();
    expect(resolveOverrideDate("2026-02-30", SP, SAT_NOON)).toBeNull();
  });
});

describe("resolveOverrideDate — unresolvable input", () => {
  it.each(["", "   ", "qualquer dia", "próxima semana", "sextou", "07/20/2026", 42, null, undefined])(
    "%s → null",
    (raw) => {
      expect(resolveOverrideDate(raw as unknown, SP, SAT_NOON)).toBeNull();
    },
  );
});

describe("resolveOverrideDate — timezone correctness", () => {
  it("computes today in RESTAURANT_TIMEZONE, not UTC, at a day boundary", () => {
    // 2026-07-05 02:00 UTC is still 2026-07-04 23:00 in São Paulo (UTC-3).
    const lateNight = new Date("2026-07-05T02:00:00.000Z");
    expect(localDateStr(lateNight, SP)).toBe("2026-07-04");
    // So "amanhã" is 2026-07-05, NOT 2026-07-06 (which a naive UTC read would give).
    expect(resolveOverrideDate("amanhã", SP, lateNight)).toBe("2026-07-05");
  });
});

describe("isValidIsoDate", () => {
  it("accepts real dates and rejects malformed / impossible ones", () => {
    expect(isValidIsoDate("2026-07-04")).toBe(true);
    expect(isValidIsoDate("2026-02-29")).toBe(false); // 2026 is not a leap year
    expect(isValidIsoDate("2028-02-29")).toBe(true); // 2028 is
    expect(isValidIsoDate("amanhã")).toBe(false);
    expect(isValidIsoDate("2026-7-4")).toBe(false);
  });
});
