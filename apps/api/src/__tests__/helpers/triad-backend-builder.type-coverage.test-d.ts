// TRIAD BACKEND BUILDER — BUILD-TIME contract test (R5-S3).
//
// Proves the builder's REASON TO EXIST: a mis-shaped read double is a COMPILE
// error. The load-bearing case is R2-S7's exact incident — a chargeback double
// spelled `hasChargeback` where the investigator reads `v.disputed`. Inside a
// `vi.mock` factory that spelling was invisible (the factory's return is loosely
// typed, so neither excess- nor missing-property checking applied); `undefined` is
// falsy, so the arm behaved identically to a correct `disputed: false` and only a
// purpose-built demote case could tell them apart. Through the builder it does not
// compile.
//
// MECHANISM (the `egress-brand.type-coverage.test-d.ts` precedent): this file is
// type-checked by the package `tsc` pass (tsconfig `include: ["src"]`, exercised by
// the `lint` / `build` tasks) but is NOT executed by Vitest — its default glob
// matches `*.test.ts` / `*.spec.ts`, never `*.test-d.ts`. Each `@ts-expect-error`
// asserts that the mis-shape FAILS to compile; if anyone loosened the override
// typing back (e.g. widened `TriadReadBackendOverrides` to `Record<string, unknown>`
// or dropped the `Partial<TriadReadBackend>` annotation), the directive would become
// UNUSED and tsc would error "Unused '@ts-expect-error' directive" — turning the
// regression red. Every negative is paired with the POSITIVE it differs from, so
// each fails for the RIGHT reason (the field spelling / shape, not arity or a typo
// in the test itself).

import {
  buildTriadReadBackend,
  type TriadReadBackendOverrides,
} from "./triad-backend-builder.js";

// Never invoked — this file exists purely so tsc evaluates the assertions.
export function __triadBackendBuilderTypeCoverage(): void {
  // ── THE R2-S7 COUNTERFACTUAL ────────────────────────────────────────────────
  // POSITIVE: the published `PaymentChargebackRead { orderId, disputed, status }`
  // — the spelling the investigator actually reads — compiles.
  buildTriadReadBackend({
    readPaymentChargeback: async (orderId) => ({
      orderId,
      disputed: false,
      status: "",
    }),
  });

  // NEGATIVE: R2-S7's exact mis-shape. `hasChargeback` is not a field of
  // `PaymentChargebackRead`, and the required `disputed` is absent. THIS IS THE
  // SLICE'S PROOF — the shape that shipped green inside a hand-written factory.
  buildTriadReadBackend({
    // @ts-expect-error — `hasChargeback` is not on PaymentChargebackRead; the
    // required `disputed` is missing. The R2-S7 incident, now a compile failure.
    readPaymentChargeback: async (orderId) => ({
      orderId,
      hasChargeback: false,
      status: "",
    }),
  });

  // ── FIELD-SPELLING NEGATIVES ON THE OTHER READ-RESULT TYPES ─────────────────
  // POSITIVE: `StoreHoursRead { hoursText }`.
  buildTriadReadBackend({
    readStoreHours: async () => ({ hoursText: "11h–15h / 18h–23h" }),
  });
  buildTriadReadBackend({
    // @ts-expect-error — the field is `hoursText`, never `hours`.
    readStoreHours: async () => ({ hours: "11h–15h / 18h–23h" }),
  });

  // POSITIVE: `PaymentRefundRead { orderId, refunded, refundedAmountCentavos, status }`.
  buildTriadReadBackend({
    readPaymentRefund: async (orderId) => ({
      orderId,
      refunded: false,
      refundedAmountCentavos: 0,
      status: "",
    }),
  });
  buildTriadReadBackend({
    // @ts-expect-error — `refundedAmountCentavos` is required (Hard Rule 2: integer
    // centavos), and `wasRefunded` is not a field of PaymentRefundRead.
    readPaymentRefund: async (orderId) => ({
      orderId,
      wasRefunded: false,
      status: "",
    }),
  });

  // POSITIVE: `HolidayRead` IS `HolidayEntry { id, date, label, allDay, startTime,
  // endTime }` — NOT an ad-hoc `{ name, isoDate }`. The falsifier reads are recorded
  // present-vs-absent, so a mis-shaped holiday is behaviourally inert TODAY and was
  // therefore undetectable by any runtime assertion — exactly the R2-S7 class.
  buildTriadReadBackend({
    readHoliday: async () => ({
      id: "hol-today",
      date: "2026-12-25",
      label: "Natal",
      allDay: true,
      startTime: null,
      endTime: null,
    }),
  });
  buildTriadReadBackend({
    // @ts-expect-error — `name`/`isoDate` are not HolidayEntry fields; `id`, `date`,
    // `label`, `allDay`, `startTime`, `endTime` are required.
    readHoliday: async () => ({ name: "feriado de hoje", isoDate: "today" }),
  });

  // POSITIVE: `ScheduleOverrideRead` IS `ScheduleOverrideEntry { id, date, isOpen,
  // blocks, note }`. Note the POLARITY: the real field is `isOpen`, so a double
  // meaning "closed that day" must say `isOpen: false` — an `isClosed: true`
  // spelling reads as `isOpen === undefined` (falsy ⇒ closed) only by coincidence.
  buildTriadReadBackend({
    readScheduleOverrideForDate: async (isoDate) => ({
      id: "ovr-1",
      date: isoDate,
      isOpen: false,
      blocks: [],
      note: "manutenção",
    }),
  });
  buildTriadReadBackend({
    // @ts-expect-error — `isoDate`/`isClosed`/`reason` are not ScheduleOverrideEntry
    // fields; `id`, `date`, `isOpen`, `blocks`, `note` are required.
    readScheduleOverrideForDate: async (isoDate) => ({
      isoDate,
      isClosed: true,
      reason: "manutenção",
    }),
  });

  // POSITIVE: `ScheduleSignal { isClosed, mealPeriod }` with `mealPeriod` a closed
  // union.
  buildTriadReadBackend({
    readSchedule: async () => ({ isClosed: false, mealPeriod: "dinner" }),
  });
  buildTriadReadBackend({
    // @ts-expect-error — "supper" is not in the `"lunch" | "dinner" | "closed"` union.
    readSchedule: async () => ({ isClosed: false, mealPeriod: "supper" }),
  });

  // ── METHOD-NAME NEGATIVE ────────────────────────────────────────────────────
  // A mis-spelled METHOD silently becomes a no-op override in a hand-written
  // factory: the real name keeps its default, so the suite stubs nothing and the
  // author's intent is lost without a signal.
  buildTriadReadBackend({
    // @ts-expect-error — the method is `readPaymentChargeback`; no such key exists
    // on TriadReadBackend.
    readPaymentChargback: async () => null,
  });

  // ── RETURN-TYPE NEGATIVE ────────────────────────────────────────────────────
  // `readOrderHistory` returns `HistoryRead` (NOT nullable — a DB failure REJECTS,
  // Inv 7), so a `null` return is a contract violation the builder now rejects.
  buildTriadReadBackend({
    readOrderHistory: async () => ({ historySummaryText: "", hasHistory: false }),
  });
  buildTriadReadBackend({
    // @ts-expect-error — readOrderHistory is non-nullable (fail-closed by REJECTING,
    // never by returning null).
    readOrderHistory: async () => null,
  });

  // ── THE OVERRIDES TYPE ITSELF ───────────────────────────────────────────────
  // Pins that `TriadReadBackendOverrides` stays a `Partial` of the REAL interface:
  // an empty literal is legal (every read defaults to its `notUsed` thrower)…
  const empty: TriadReadBackendOverrides = {};
  buildTriadReadBackend(empty);
  // …while an unknown key is not.
  const bogus: TriadReadBackendOverrides = {
    // @ts-expect-error — not a TriadReadBackend method.
    readSomethingElse: async () => null,
  };
  void bogus;
}
