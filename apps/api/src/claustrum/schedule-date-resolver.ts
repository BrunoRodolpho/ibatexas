// schedule-date-resolver.ts — the DETERMINISTIC NL → ISO-date resolver for the
// day-specific schedule chain (BKL-138 / SCN-002/003). Given the customer's raw
// request text, it resolves the QUERIED calendar day to a single `"YYYY-MM-DD"`
// ISO date in the restaurant timezone, or `null` when the text carries no
// deterministically-resolvable date anchor.
//
// WHY a SHARED pure resolver (not model-authored): the ISO date is the
// STORE_HOURS_FOR_DATE claim's `subject` AND the suffix of the investigator's
// date-keyed ledger reads (`schedule:store_hours:{date}` …). The claim planner and
// the investigator BOTH call THIS function over the SAME `perception.text`, so they
// resolve the IDENTICAL date and the kernel's evidence key matches the candidate
// subject by construction — never the 4B's unreliable date arithmetic (the model
// only CLASSIFIES the span; the date is derived here). A within-turn clock skew
// across midnight can at worst make the two calls disagree → the evidence key is
// then ABSENT → honest UNKNOWN degrade, NEVER a wrong-day answer (the honest floor).
//
// Resolution rules (precedence high→low):
//   1. "amanhã"        → today(tz) + 1 day.
//   2. "hoje"          → today(tz)              (today's hours are normally the
//                        STORE_HOURS type; supported here for robustness when the
//                        model still tags STORE_HOURS_FOR_DATE).
//   3. a named weekday → the NEAREST occurrence on-or-after today (offset 0..6:
//                        today when today already IS that weekday, else the next).
//   4. otherwise (a bare "feriado" with no date anchor, or nothing) → `null`
//                        (unresolvable pre-read → the caller honestly degrades /
//                        clarifies; "feriado" is NOT resolvable deterministically
//                        without reading the holiday calendar). When a relative /
//                        weekday anchor CO-OCCURS with "feriado" ("amanhã no
//                        feriado"), the anchor wins by the precedence above.
//
// PURE: the clock (`now`) + `tz` are injected; no IO, no RNG, no hidden Date.now.

/** The resolved calendar day the customer asked the schedule of. */
export interface ResolvedScheduleDate {
  /** The queried day as an ISO `"YYYY-MM-DD"` date in the restaurant timezone. */
  readonly isoDate: string;
}

/** pt-BR weekday markers → day-of-week (0=Sun … 6=Sat). Ordered for a stable scan;
 *  the EARLIEST occurrence in the text wins when several are present. */
const WEEKDAY_MARKERS: ReadonlyArray<{ readonly re: RegExp; readonly dow: number }> = [
  { re: /\bdomingo/, dow: 0 },
  { re: /\bsegunda(?:-feira|s)?/, dow: 1 },
  { re: /\bter[çc]a(?:-feira|s)?/, dow: 2 },
  { re: /\bquarta(?:-feira|s)?/, dow: 3 },
  { re: /\bquinta(?:-feira|s)?/, dow: 4 },
  { re: /\bsexta(?:-feira|s)?/, dow: 5 },
  { re: /\bs[áa]bado/, dow: 6 },
];

const AMANHA_RE = /\bamanh[ãa]/;
const HOJE_RE = /\bhoje\b/;

/**
 * Resolve the QUERIED schedule date from the request text (BKL-138). Deterministic
 * over `(text, tz, now)`. Returns the resolved ISO date, or `null` when the text
 * has no resolvable date anchor (the caller degrades honestly). Pure.
 */
export function resolveQueriedScheduleDate(
  text: string,
  tz: string,
  now: Date,
): ResolvedScheduleDate | null {
  const t = text.toLowerCase();
  const today = localDateParts(tz, now);

  // (1) amanhã — the relative day wins over a co-occurring weekday / "feriado".
  if (AMANHA_RE.test(t)) return { isoDate: addDays(today.isoDate, 1) };
  // (2) hoje.
  if (HOJE_RE.test(t)) return { isoDate: today.isoDate };

  // (3) the EARLIEST-occurring named weekday → its nearest on-or-after occurrence.
  let best: { readonly index: number; readonly dow: number } | undefined;
  for (const { re, dow } of WEEKDAY_MARKERS) {
    const m = re.exec(t);
    if (m !== null && (best === undefined || m.index < best.index)) {
      best = { index: m.index, dow };
    }
  }
  if (best !== undefined) {
    const offset = (best.dow - today.dayOfWeek + 7) % 7; // 0 when today IS that weekday.
    return { isoDate: addDays(today.isoDate, offset) };
  }

  // (4) no anchor (bare "feriado" / none) → unresolvable pre-read.
  return null;
}

/** Today's ISO date + day-of-week in `tz` for the injected `now` (en-CA yields
 *  `YYYY-MM-DD`; the short weekday maps to 0..6). Pure. Exported (BKL-152-edge)
 *  so the `renderCarriersForTurn` carrier callback can compare a resolved queried
 *  date against today WITHOUT re-deriving the tz-format (single source, no drift). */
export function localDateParts(tz: string, now: Date): { isoDate: string; dayOfWeek: number } {
  const isoDate = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(now);
  const dayStr = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(now);
  const dayMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  return { isoDate, dayOfWeek: dayMap[dayStr] ?? now.getUTCDay() };
}

/** Add `days` to a `"YYYY-MM-DD"` string, returning a new `"YYYY-MM-DD"` (noon UTC
 *  anchors it away from any DST/date-shift edge). Pure. */
function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().split("T")[0] as string;
}
