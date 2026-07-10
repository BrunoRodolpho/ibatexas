/**
 * schedule-date-resolver.test.ts — BKL-138 (SCN-002/003). Pins the DETERMINISTIC
 * NL → ISO-date resolution the claim planner + investigator BOTH drive off (so the
 * candidate subject and the ledger key resolve to the IDENTICAL date). The clock is
 * FROZEN (an explicit `now: Date`), so a named-weekday / "amanhã" question resolves
 * to a fixed calendar date. Pure — no fake timers needed.
 *
 * Reference: `now` is FRIDAY 2026-07-10 12:00 in São Paulo (2026-07-10T15:00:00Z).
 * Nearby dates: 07-11 = Sat, 07-12 = Sun, 07-13 = Mon.
 */
import { describe, expect, it } from "vitest";
import { resolveQueriedScheduleDate } from "../schedule-date-resolver.js";

const TZ = "America/Sao_Paulo";
/** Friday 2026-07-10, 12:00 in São Paulo (UTC-3). */
const FRI_NOON = new Date("2026-07-10T15:00:00Z");

describe("resolveQueriedScheduleDate — relative anchors", () => {
  it("'amanhã' → today+1 in the restaurant tz", () => {
    expect(resolveQueriedScheduleDate("vocês abrem amanhã?", TZ, FRI_NOON)).toEqual({
      isoDate: "2026-07-11",
    });
  });

  it("'hoje' → today in the restaurant tz", () => {
    expect(resolveQueriedScheduleDate("qual o horário de hoje?", TZ, FRI_NOON)).toEqual({
      isoDate: "2026-07-10",
    });
  });
});

describe("resolveQueriedScheduleDate — named weekdays (nearest on-or-after today)", () => {
  it("'domingo' → the next Sunday (offset 2 from Friday)", () => {
    expect(resolveQueriedScheduleDate("qual o horário de domingo?", TZ, FRI_NOON)).toEqual({
      isoDate: "2026-07-12",
    });
  });

  it("'segunda' → the next Monday", () => {
    expect(resolveQueriedScheduleDate("abrem na segunda?", TZ, FRI_NOON)).toEqual({
      isoDate: "2026-07-13",
    });
  });

  it("'sábado' → the next Saturday", () => {
    expect(resolveQueriedScheduleDate("que horas abre sábado?", TZ, FRI_NOON)).toEqual({
      isoDate: "2026-07-11",
    });
  });

  it("a weekday that IS today resolves to TODAY (offset 0, not +7)", () => {
    // now is a Friday → "sexta" is today.
    expect(resolveQueriedScheduleDate("horário de sexta?", TZ, FRI_NOON)).toEqual({
      isoDate: "2026-07-10",
    });
  });

  it("is accent-insensitive (terça/terca, sábado/sabado)", () => {
    expect(resolveQueriedScheduleDate("horário de terça?", TZ, FRI_NOON)?.isoDate).toBe(
      "2026-07-14",
    );
    expect(resolveQueriedScheduleDate("horario de terca?", TZ, FRI_NOON)?.isoDate).toBe(
      "2026-07-14",
    );
    expect(resolveQueriedScheduleDate("abre sabado?", TZ, FRI_NOON)?.isoDate).toBe(
      "2026-07-11",
    );
  });
});

describe("resolveQueriedScheduleDate — precedence + unresolvable", () => {
  it("'amanhã no feriado' → amanhã wins (the relative anchor beats a bare feriado)", () => {
    expect(
      resolveQueriedScheduleDate("vocês abrem amanhã no feriado?", TZ, FRI_NOON),
    ).toEqual({ isoDate: "2026-07-11" });
  });

  it("a bare 'feriado' with NO date anchor → null (unresolvable pre-read; honest degrade)", () => {
    expect(resolveQueriedScheduleDate("vocês abrem no feriado?", TZ, FRI_NOON)).toBeNull();
  });

  it("no date anchor at all → null", () => {
    expect(resolveQueriedScheduleDate("qual o cardápio?", TZ, FRI_NOON)).toBeNull();
    expect(resolveQueriedScheduleDate("oi, tudo bem?", TZ, FRI_NOON)).toBeNull();
  });
});

describe("resolveQueriedScheduleDate — timezone edges (tz-relative, not UTC)", () => {
  it("resolves 'today'/'amanhã' in the RESTAURANT tz across the UTC midnight boundary", () => {
    // 2026-07-11T02:00:00Z is already SATURDAY in UTC but still FRIDAY 23:00 in São
    // Paulo — the resolver must anchor on the LOCAL Friday.
    const lateFri = new Date("2026-07-11T02:00:00Z");
    expect(resolveQueriedScheduleDate("horário de hoje?", TZ, lateFri)).toEqual({
      isoDate: "2026-07-10",
    });
    expect(resolveQueriedScheduleDate("abrem amanhã?", TZ, lateFri)).toEqual({
      isoDate: "2026-07-11",
    });
  });
});
