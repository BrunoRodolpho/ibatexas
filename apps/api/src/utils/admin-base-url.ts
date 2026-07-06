// The admin app's public base URL + the BKL-105 approval deep-link builder.
//
// `ADMIN_BASE_URL` is the STANDALONE public URL of the admin panel (apps/admin,
// port 3002 in dev) — deliberately distinct from WEB_URL / APP_BASE_URL /
// NEXT_PUBLIC_APP_URL, which all point at the CUSTOMER web app (:3000). It is
// used to turn a parked managed-agent approval token into a one-tap staff link
// to the exact approval (BKL-105 route: /admin/aprovacoes/[token]).
//
// Posture (matches victoriaLogsUrl(): undefined-safe, dev-defaulted):
//   - set            → the configured URL (trimmed).
//   - unset + dev    → http://localhost:3002 (the admin app's dev port; see
//                      packages/cli/src/services.ts).
//   - unset + prod   → undefined → the deep-link is OMITTED from the notification.
// We degrade rather than fail-fast because the handoff notification is a
// best-effort side channel (every other leg — STAFF_NOTIFICATION_PHONE, the
// WhatsApp sender, the send itself — degrades gracefully too). Omitting the link
// keeps the staff alert flowing; emitting a localhost link in prod would be a
// dead/misleading link, which is strictly worse than no link. (WEB_URL fail-fasts
// at its use sites because it gates CORS/security, a different risk class.)

/** The configured admin base URL, dev-defaulted; undefined only when unset in production. */
export function adminBaseUrl(): string | undefined {
  const configured = process.env.ADMIN_BASE_URL?.trim();
  if (configured) return configured;
  if (process.env.NODE_ENV === "production") return undefined;
  return "http://localhost:3002";
}

/**
 * Build the BKL-105 approval deep-link (`/admin/aprovacoes/:token`) for a parked
 * managed-agent approval token, or undefined when no admin base URL is available
 * (prod + unset) so the caller can omit the link. The token is already carried in
 * the notification payload, so wrapping it in a URL adds no new exposure — the
 * GET + resolve routes are token- and manager-gated regardless.
 */
export function approvalDeepLink(approvalToken: string): string | undefined {
  const base = adminBaseUrl();
  if (!base) return undefined;
  return `${base.replace(/\/$/, "")}/admin/aprovacoes/${encodeURIComponent(approvalToken)}`;
}
