// _date-defaults.ts — shared admin-route date defaults for the read-only reporting
// endpoints (caixa / analytics-reports). Kept in one place so an omitted `date` /
// range always defaults in the restaurant's BUSINESS timezone — the SAME zone the
// domain reporting services resolve their day/range boundary in — never the
// server's local day (which near UTC midnight reports the wrong business day).

/** Today's YYYY-MM-DD in RESTAURANT_TIMEZONE (en-CA yields YYYY-MM-DD). */
export function todayInRestaurantTz(): string {
  const tz = process.env.RESTAURANT_TIMEZONE ?? "America/Sao_Paulo";
  return new Date().toLocaleDateString("en-CA", { timeZone: tz });
}

/** A YYYY-MM-DD shifted from `dateStr` by `days` (UTC arithmetic; rollover-safe). */
export function shiftYmd(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
