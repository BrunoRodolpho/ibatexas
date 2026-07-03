/**
 * Staff-plane per-role capability matrix (WS7 / BKL-069 Part C) — the adopter's
 * OWNER/MANAGER/ATTENDANT × intent-kind authorization surface, consumed by the
 * AUTH-phase `createStaffRoleGuard` (staff-role-guard.ts) and composed into
 * every pack via `IBATEXAS_ADOPTER_AUTH_GUARDS`.
 *
 * ── What this is (and is not) ────────────────────────────────────────────────
 * This matrix is kernel DEFENSE-IN-DEPTH that MIRRORS the HTTP route layer. The
 * PRIMARY enforcement of staff authorization is the Fastify preHandler chain
 * (`requireStaff` / `requireManager` / `requireManagerRole` / `requireOwnerRole`
 * in middleware/staff-auth.ts); this matrix restates that same reachability so a
 * staff-plane envelope routed through the kernel is gated by role even if it
 * reaches the kernel by a path other than the HTTP route (e.g. a future
 * agent-reachable ops surface). It NEVER tightens below current route
 * reachability — every entry is the UNION of the gates over the routes that can
 * build that kind with an `admin:` (staff-plane) envelope.
 *
 * ── Code-truth derivation ────────────────────────────────────────────────────
 * `resolveActorRole` (Part B) threads the authenticated role onto
 * `IntentActor.role` for EXACTLY SEVEN staff-plane kinds. For each, the allowed
 * role set = UNION of the preHandler gates of every admin route that builds it:
 *   - requireStaff (JWT, any staff role)      ⇒ {OWNER, MANAGER, ATTENDANT}
 *   - requireManager / requireManagerRole     ⇒ {OWNER, MANAGER}
 *   - requireOwnerRole / inline OWNER check   ⇒ {OWNER}
 * When routes building the same kind sit behind DIFFERENT gates, the row is
 * their union (matches current reachability — a defense-in-depth mirror must not
 * block anything the route layer allows). Per-row `code-truth` comments cite the
 * exact routes + preHandlers below.
 *
 * ── Deliberately EXCLUDED ────────────────────────────────────────────────────
 * `incident.ticket.open` / `incident.ticket.close` and every subscriber / job /
 * webhook kind ride `buildSystemEnvelope` with `sessionId =
 * "${sourceSubject}:${eventId}"` (principal `"system"`, never `admin:`, always
 * role-free by contract). They are NOT staff-plane verbs and must not appear
 * here; the guard's `admin:` engagement predicate keeps it inert for them.
 */

import type { StaffActorRole } from "../routes/admin/_shared-actions.js";

/**
 * CODE-TRUTH source table: each staff-plane intent kind → the UNION of the
 * route-layer role gates that can build it with an `admin:` envelope today.
 * This is the single source of truth; {@link STAFF_ROLE_CAPABILITY_MATRIX} is
 * derived from it by inversion so the two can never drift.
 */
export const STAFF_KIND_ALLOWED_ROLES = {
  // code-truth (UNION of gates):
  //   PATCH /api/admin/orders/:id                 orders.ts       requireManagerRole ⇒ {OWNER,MANAGER}
  //   POST  /api/admin/orders/:id/force-cancel[/confirm]
  //                                               order-actions.ts requireManager    ⇒ {OWNER,MANAGER}
  //   POST  /api/admin/orders/:id/advance         order-actions.ts requireStaff      ⇒ {OWNER,MANAGER,ATTENDANT}
  "order.status.transition": ["OWNER", "MANAGER", "ATTENDANT"],

  // code-truth (UNION of gates):
  //   POST  /api/admin/orders/:id/force-cancel/confirm (cancelActivePaymentBestEffort)
  //                                               order-actions.ts requireManager    ⇒ {OWNER,MANAGER}
  //   POST  /api/admin/orders/:id/waive[/confirm] order-actions.ts requireStaff + inline OWNER ⇒ {OWNER}
  //   POST  /api/admin/orders/:id/payment/confirm-cash
  //                                               payments.ts     requireStaff      ⇒ {OWNER,MANAGER,ATTENDANT}
  //   PATCH /api/admin/orders/:id/payment/status [+ /confirm]
  //                                               payments.ts     requireStaff + inline OWNER ⇒ {OWNER}
  "payment.status.transition": ["OWNER", "MANAGER", "ATTENDANT"],

  // code-truth (UNION of gates):
  //   POST  /api/admin/orders/:id/payment/refund[/confirm]
  //                                               payments.ts     requireManagerRole ⇒ {OWNER,MANAGER}
  "payment.refund.issue": ["OWNER", "MANAGER"],

  // code-truth (UNION of gates):
  //   POST  /api/admin/orders/:id/staff-notes     order-actions.ts requireStaff      ⇒ {OWNER,MANAGER,ATTENDANT}
  //   POST  /api/admin/orders/:id/notes           payments.ts     requireStaff      ⇒ {OWNER,MANAGER,ATTENDANT}
  "order.note.add": ["OWNER", "MANAGER", "ATTENDANT"],

  // code-truth:
  //   POST  /api/admin/reservations/:id/checkin   reservations.ts requireManagerRole ⇒ {OWNER,MANAGER}
  "reservation.checkin": ["OWNER", "MANAGER"],

  // code-truth:
  //   POST  /api/admin/reservations/:id/complete  reservations.ts requireManagerRole ⇒ {OWNER,MANAGER}
  "reservation.complete": ["OWNER", "MANAGER"],

  // code-truth:
  //   POST  /api/admin/reservations/:id/cancel    reservations.ts requireManagerRole ⇒ {OWNER,MANAGER}
  "reservation.cancel": ["OWNER", "MANAGER"],
} as const satisfies Record<string, readonly StaffActorRole[]>;

/** The exact staff-plane verb surface (the seven kinds keyed above). */
export type StaffPlaneKind = keyof typeof STAFF_KIND_ALLOWED_ROLES;

/**
 * The authoritative staff-plane verb surface — EXACTLY the seven kinds. The
 * guard fails closed for any `admin:` envelope whose kind is outside this set
 * (de-vacuum: the matrix IS the staff-plane verb surface).
 */
export const STAFF_PLANE_KINDS: ReadonlySet<string> = new Set(
  Object.keys(STAFF_KIND_ALLOWED_ROLES),
);

/** The closed set of known staff roles; any other `actor.role` fails closed. */
export const STAFF_ROLES: readonly StaffActorRole[] = [
  "OWNER",
  "MANAGER",
  "ATTENDANT",
];

/**
 * Per-role capability matrix (role → the staff-plane kinds that role may
 * propose), inverted from {@link STAFF_KIND_ALLOWED_ROLES}. This is the artifact
 * `createStaffRoleGuard` consumes: a staff-plane envelope is authorized iff its
 * `actor.role` is a known role AND the kind is in that role's set.
 *
 * Current contents (derived): OWNER + MANAGER may propose all seven; ATTENDANT
 * may propose only the three requireStaff-reachable kinds
 * (order.status.transition, payment.status.transition, order.note.add).
 */
export const STAFF_ROLE_CAPABILITY_MATRIX: Record<
  StaffActorRole,
  ReadonlySet<string>
> = (() => {
  const acc: Record<StaffActorRole, Set<string>> = {
    OWNER: new Set<string>(),
    MANAGER: new Set<string>(),
    ATTENDANT: new Set<string>(),
  };
  for (const [kind, roles] of Object.entries(STAFF_KIND_ALLOWED_ROLES)) {
    for (const role of roles) acc[role].add(kind);
  }
  return acc;
})();
