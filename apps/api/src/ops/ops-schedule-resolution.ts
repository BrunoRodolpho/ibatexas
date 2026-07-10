// ops-schedule-resolution.ts — deterministic NL→ISO date normalization for the
// SCN-127 schedule-override verb.
//
// The ops persona puts the owner's day reference VERBATIM in `payload.date`
// ("amanhã", "sexta", or an explicit "2026-07-25"); the ops resolver normalizes
// it to a CONCRETE ISO calendar date in RESTAURANT_TIMEZONE and stamps it into the
// payload BEFORE adjudication — so the kernel adjudicates a concrete date, never a
// relative word (a word this module cannot resolve is left untouched and the pack
// validator REFUSEs it, fail-closed). Pure: no IO and no ambient clock (the caller
// injects `now`), so it is frozen-clock testable and timezone-correct via
// `Intl.DateTimeFormat` (the SAME idiom the customer-facing schedule reads use).

/** The pt-BR weekday lexicon → dayOfWeek (0=Sunday … 6=Saturday). Accent- and
 *  "-feira"-insensitive matching is applied by {@link normalize} before lookup. */
const WEEKDAY_TO_DOW: ReadonlyMap<string, number> = new Map([
  ["domingo", 0],
  ["segunda", 1],
  ["terca", 2],
  ["quarta", 3],
  ["quinta", 4],
  ["sexta", 5],
  ["sabado", 6],
]);

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Well-formed AND real `YYYY-MM-DD` calendar date (rejects "2026-13-40"). */
export function isValidIsoDate(s: string): boolean {
  if (!ISO_DATE_RE.test(s)) return false;
  const d = new Date(`${s}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Today's business-day date as `YYYY-MM-DD` in `tz` (en-CA yields YYYY-MM-DD). */
export function localDateStr(now: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(now);
}

/** Today's dayOfWeek (0=Sun … 6=Sat) in `tz`. */
function localDow(now: Date, tz: string): number {
  const short = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
  }).format(now);
  const map: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  return map[short] ?? now.getUTCDay();
}

/** Add `days` to a `YYYY-MM-DD` string, returning a new `YYYY-MM-DD` (noon-UTC to
 *  avoid a DST/date-shift at the boundary — the SAME trick schedule-helpers uses). */
function addDaysIso(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Strip diacritics + lowercase + collapse whitespace, and drop a trailing
 *  "-feira"/" feira" so "Sexta-feira" and "sexta" both match the lexicon. */
function normalize(raw: string): string {
  return raw
    .trim()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[-\s]*feira$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Resolve an owner's day reference to a CONCRETE `YYYY-MM-DD` in `tz`, or `null`
 * when it is not a reference this v1 understands (the caller leaves the payload
 * untouched ⇒ the pack validator REFUSEs — fail-closed, never a guessed date).
 *
 * Grammar (deterministic):
 *   - an explicit, real `YYYY-MM-DD`            → returned verbatim;
 *   - "hoje"                                    → today;
 *   - "amanhã" / "amanha"                       → today + 1;
 *   - "depois de amanhã"                        → today + 2;
 *   - a pt-BR weekday ("sexta", "sexta-feira")  → the NEAREST such day in
 *                                                 [today, today+6] (today itself
 *                                                 when today already matches).
 *
 * Every branch yields a date `>= today`, so a resolved value always satisfies the
 * pack's today-or-future guard; only an explicit PAST `YYYY-MM-DD` (which is
 * returned verbatim) can be past, and the guard REFUSEs it.
 */
export function resolveOverrideDate(
  raw: unknown,
  tz: string,
  now: Date,
): string | null {
  if (typeof raw !== "string") return null;
  const n = normalize(raw);
  if (n.length === 0) return null;

  // Explicit ISO date — return verbatim (validity/past-ness are the pack's job).
  if (ISO_DATE_RE.test(n)) return isValidIsoDate(n) ? n : null;

  const today = localDateStr(now, tz);
  if (n === "hoje") return today;
  if (n === "depois de amanha") return addDaysIso(today, 2);
  if (n === "amanha") return addDaysIso(today, 1);

  const targetDow = WEEKDAY_TO_DOW.get(n);
  if (targetDow !== undefined) {
    const offset = (targetDow - localDow(now, tz) + 7) % 7;
    return addDaysIso(today, offset);
  }

  return null;
}
