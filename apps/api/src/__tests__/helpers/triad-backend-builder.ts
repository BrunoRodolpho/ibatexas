// triad-backend-builder.ts — the ONE typed test double for the first-party
// {@link TriadReadBackend} (R5-S3; the F-11 typed builder). Every claims e2e suite
// that needs to stub the INVESTIGATE stage's reads builds its double here instead of
// hand-writing an 18-method object literal inside its own `vi.mock` factory.
//
// ── WHY THIS EXISTS (the R2-S7 incident) ──────────────────────────────────────
// A `vi.mock` factory's return value is LOOSELY TYPED: the factory is declared to
// return `unknown`/`any`, so neither excess-property nor missing-property checking
// reaches the object literal inside it. R2-S7's hand-written double supplied
// `hasChargeback: false` where the investigator reads `v.disputed`
// (ibatexas-investigator.ts, against the published `PaymentChargebackRead`).
// `undefined` is falsy, so the mis-spelled arm behaved EXACTLY like a correctly
// spelled `disputed: false` — every positive case stayed green, `tsc` stayed green,
// and only a purpose-built demote case could tell the two spellings apart. That is
// the class where a double proves a port was CALLED but never that its output is
// USABLE.
//
// The close: overrides are typed against the REAL read-result types, so a
// mis-spelled field, a wrong shape, or a mis-spelled METHOD name is a COMPILE error.
// Measured on the exact R2-S7 shape, tsc reports:
//
//   error TS2322: Type '(orderId: string) => Promise<{ orderId: string;
//   hasChargeback: boolean; status: string; }>' is not assignable to type
//   '(orderId: string, customerId: string) => Promise<PaymentChargebackRead | null>'.
//     Property 'disputed' is missing in type '{ orderId: string; hasChargeback:
//     boolean; status: string; }' but required in type 'PaymentChargebackRead'.
//
// — the missing REQUIRED field is named outright, which is a sharper diagnosis than
// the bare excess-property complaint (TS2353) a same-arity mis-spelling produces.
// The negative space is pinned by `triad-backend-builder.type-coverage.test-d.ts`,
// which reintroduces R2-S7's exact mis-shape THROUGH this builder under
// `@ts-expect-error` — if the typing ever loosened back, that directive would go
// unused and tsc would go red.
//
// ── THE `notUsed` DISCIPLINE, NOW THE DEFAULT ─────────────────────────────────
// The hand-written doubles named every read a suite must NOT reach with a
// `notUsed(name)` thrower, so an unexpected read failed LOUDLY rather than
// silently returning a fabricated value. That discipline is preserved verbatim —
// including the message text — except it is now the DEFAULT for every method the
// caller does not override, instead of a line the author had to remember to write.
// A suite therefore declares only the reads it actually exercises, and any read it
// did not declare throws `turn-reads.<name> must not run in this suite`.
//
// ── IMPORT PURITY (load-bearing — this module is imported INSIDE a vi.mock factory) ──
// `../../claustrum/turn-reads.js` pulls REAL infrastructure at module scope
// (`@ibatexas/domain` query services, `@ibatexas/tools` Redis/Medusa clients). This
// file therefore imports from it with `import type` ONLY, which the compiler ERASES
// — the emitted module has ZERO runtime imports and drags nothing into the hoisted
// mock scope. Do NOT add a value import here (the repo does not set
// `verbatimModuleSyntax`, so a `import { x }` used only as a type would still be
// erased — but an actually-used value import would re-enter the module the factory
// is in the middle of mocking). Callers reach it with a dynamic
// `await import("./helpers/triad-backend-builder.js")` inside the factory body,
// alongside `importOriginal()`, because a `vi.mock` factory is hoisted above the
// file's static imports and cannot close over them.

import type {
  TriadReadBackend,
} from "../../claustrum/turn-reads.js";

/**
 * The reads a suite declares. Typed as `Partial<TriadReadBackend>`, which buys three
 * separate compile-time guarantees at the call site:
 *
 *  1. a mis-spelled METHOD name is an excess property (TS2353);
 *  2. a mis-shaped RETURN value is a missing/excess property on the real read-result
 *     type (TS2739 / TS2353) — the R2-S7 close;
 *  3. handler PARAMETERS are contextually typed, so `async (orderId) => …` infers
 *     `string` with no annotation.
 *
 * It is also self-maintaining: a 19th method added to `TriadReadBackend` makes
 * {@link buildTriadReadBackend}'s defaults object red (missing property), so the
 * census can never silently fall behind the interface.
 */
export type TriadReadBackendOverrides = Partial<TriadReadBackend>;

/**
 * A read this suite declared must never run. Throws with the message the
 * hand-written doubles used verbatim, so an unexpected read is a LOUD failure
 * naming the method — never a silent fabricated value.
 */
const notUsed =
  (name: string) =>
  async (): Promise<never> => {
    throw new Error(`turn-reads.${name} must not run in this suite`);
  };

/**
 * The full 18-method census of {@link TriadReadBackend}, every entry defaulting to
 * its `notUsed` thrower. Annotated (not merely `satisfies`) so a method REMOVED from
 * the interface is an excess property here and a method ADDED is a missing one —
 * either way this file goes red before any suite does.
 */
const NOT_USED_DEFAULTS: TriadReadBackend = {
  // Schedule / hours — public first-party config reads (no owner).
  readSchedule: notUsed("readSchedule"),
  readScheduleOverride: notUsed("readScheduleOverride"),
  readStoreHours: notUsed("readStoreHours"),
  readHoliday: notUsed("readHoliday"),
  readHoursForDate: notUsed("readHoursForDate"),
  readHolidayForDate: notUsed("readHolidayForDate"),
  readScheduleOverrideForDate: notUsed("readScheduleOverrideForDate"),
  // Owner-scoped resource reads (`null` = not owned / absent → fail-closed error).
  readOrderFulfillment: notUsed("readOrderFulfillment"),
  readPaymentStatus: notUsed("readPaymentStatus"),
  readReservation: notUsed("readReservation"),
  // BKL-006 owner-scoped PAYMENT_STATUS falsifier reads.
  readPaymentRefund: notUsed("readPaymentRefund"),
  readPaymentChargeback: notUsed("readPaymentChargeback"),
  // Session-scoped cart + owner-scoped list reads.
  readCartContents: notUsed("readCartContents"),
  readOrderHistory: notUsed("readOrderHistory"),
  readPaymentHistory: notUsed("readPaymentHistory"),
  // Owner-scoped enumerations / counts (the §O#15 companion signals).
  listActiveOrderIds: notUsed("listActiveOrderIds"),
  listActiveReservationIds: notUsed("listActiveReservationIds"),
  countActivePayments: notUsed("countActivePayments"),
};

/** The method names of {@link TriadReadBackend}, derived from the defaults census —
 *  exported for the builder's own coverage test (never for production use). */
export const TRIAD_READ_METHOD_NAMES: ReadonlyArray<keyof TriadReadBackend> =
  Object.keys(NOT_USED_DEFAULTS) as Array<keyof TriadReadBackend>;

/**
 * Build a {@link TriadReadBackend} double: the declared reads, plus a `notUsed`
 * thrower for every read the suite did not declare.
 *
 * Returns a FRESH object per call, so a factory's `createDomainTriadReadBackend: ()
 * => buildTriadReadBackend({…})` keeps production's per-turn-instance shape. The
 * override handlers are ordinary closures — a suite threading per-drive state through
 * a `vi.hoisted` box reads that box inside its handler exactly as before.
 *
 * @example
 * vi.mock("../claustrum/turn-reads.js", async (importOriginal) => {
 *   const actual = await importOriginal<typeof import("../claustrum/turn-reads.js")>();
 *   const { buildTriadReadBackend } = await import("./helpers/triad-backend-builder.js");
 *   return {
 *     ...actual,
 *     createDomainTriadReadBackend: () =>
 *       buildTriadReadBackend({
 *         readSchedule: async () => ({ isClosed: false, mealPeriod: "dinner" }),
 *         listActiveOrderIds: async () => [...st.orderIds],
 *       }),
 *   };
 * });
 */
export function buildTriadReadBackend(
  overrides: TriadReadBackendOverrides = {},
): TriadReadBackend {
  return { ...NOT_USED_DEFAULTS, ...overrides };
}
