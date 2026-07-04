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
 * in middleware/staff-auth.ts); this matrix restates that same reachability.
 *
 * WHERE THE GUARD OVER THIS MATRIX ACTUALLY RUNS (no overstatement): the
 * `createStaffRoleGuard` that consumes this matrix is prepended to the composed
 * bundles and therefore fires ONLY when an `admin:` envelope is adjudicated
 * through the composed-router seam (`composePolicyRouter`/`policyForKind`). That
 * seam is reached by the conductor and the agent-approvals gateway (neither of
 * which carries an `admin:` session today) and by any FUTURE agent-reachable /
 * ops-actor surface (WS6 / NEW-032) — the case this matrix exists for. Today's
 * admin HTTP routes do NOT use the composed router: they adjudicate these seven
 * kinds against the RAW pack bundles via the domain command services, so on that
 * path the role gate is the preHandler chain above, not this matrix. Threading
 * the kernel-level backstop into the HTTP command-service path is BKL-074.
 *
 * It NEVER tightens below current route reachability — every entry is the UNION
 * of the gates over the routes that can build that kind with an `admin:`
 * (staff-plane) envelope.
 *
 * ── Code-truth derivation ────────────────────────────────────────────────────
 * `resolveActorRole` (Part B) threads the authenticated role onto
 * `IntentActor.role` for the SEVEN HTTP-route staff-plane kinds. For each, the
 * allowed role set = UNION of the preHandler gates of every admin route that
 * builds it:
 *   - requireStaff (JWT, any staff role)      ⇒ {OWNER, MANAGER, ATTENDANT}
 *   - requireManager / requireManagerRole     ⇒ {OWNER, MANAGER}
 *   - requireOwnerRole / inline OWNER check   ⇒ {OWNER}
 * When routes building the same kind sit behind DIFFERENT gates, the row is
 * their union (matches current reachability — a defense-in-depth mirror must not
 * block anything the route layer allows). Per-row `code-truth` comments cite the
 * exact routes + preHandlers below.
 *
 * The EIGHTH..TENTH kinds are the @ibatexas/pack-ops verbs the ops conductor
 * adjudicates through the composed router (the exact seam this matrix exists
 * for): `product.availability.set` (NEW-032 slice C1) and the two BKL-088
 * RESOLUTION verbs `ops.alert.resolve.staff` / `incident.ticket.close.staff`.
 * No admin HTTP route builds these kinds directly; each band is derived the
 * same way — the UNION of the gates over the routes that govern the same
 * operation manually (all three are `requireManagerRole` ⇒ {OWNER,MANAGER}).
 * They are admitted here (not deferred) precisely because the composed-router
 * seam is where this matrix is live.
 *
 * ── Deliberately EXCLUDED ────────────────────────────────────────────────────
 * The SYSTEM-only `incident.ticket.open` / `incident.ticket.close` and
 * `ops.alert.open` / `ops.alert.resolve` domain kinds, plus every subscriber /
 * job / webhook kind, ride `buildSystemEnvelope` with `sessionId =
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

  // code-truth (NEW-032 slice C1 — the ops-plane governed availability verb):
  //   PATCH /api/admin/products/:id               products.ts     requireManagerRole ⇒ {OWNER,MANAGER}
  // `product.availability.set` is the @ibatexas/pack-ops verb the future ops
  // conductor will adjudicate; its role band mirrors the admin products PATCH
  // route's requireManagerRole preHandler (products.ts:112) — the same gate
  // that governs a manual availability toggle today. ATTENDANT is excluded
  // (no requireStaff-reachable products route builds this kind).
  "product.availability.set": ["OWNER", "MANAGER"],

  // code-truth (BKL-088 — the ops-plane governed alert-resolution verb):
  //   POST /api/admin/ops-alerts/:id/resolve      admin/ops-alerts.ts requireManagerRole ⇒ {OWNER,MANAGER}
  // `ops.alert.resolve.staff` is the @ibatexas/pack-ops verb the ops conductor
  // adjudicates for "resolve o alerta X"; its role band mirrors the admin
  // ops-alerts resolve route's requireManagerRole preHandler (ops-alerts.ts:79)
  // — the same gate that governs a manual STAFF alert-resolve today. ATTENDANT
  // is excluded (the resolve route is manager-gated). Its EXECUTOR then drives
  // the SYSTEM-only `ops.alert.resolve` domain write (buildSystemEnvelope), which
  // is DELIBERATELY off this matrix (a role-free `system:` envelope, D10).
  "ops.alert.resolve.staff": ["OWNER", "MANAGER"],

  // code-truth (BKL-088 — the ops-plane governed incident-close verb):
  //   POST /api/admin/incidents/:id/resolve       admin/incidents.ts requireManagerRole ⇒ {OWNER,MANAGER}
  // `incident.ticket.close.staff` is the @ibatexas/pack-ops verb the ops
  // conductor adjudicates for "fecha o incidente Y"; its role band mirrors the
  // admin incidents resolve route's requireManagerRole preHandler
  // (incidents.ts:200). Its EXECUTOR then drives the SYSTEM-only
  // `incident.ticket.close` domain write (buildSystemEnvelope), off this matrix.
  "incident.ticket.close.staff": ["OWNER", "MANAGER"],
} as const satisfies Record<string, readonly StaffActorRole[]>;

/** The exact staff-plane verb surface (the ten kinds keyed above). */
export type StaffPlaneKind = keyof typeof STAFF_KIND_ALLOWED_ROLES;

/**
 * The authoritative staff-plane verb surface — EXACTLY the ten kinds. The
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
 * Current contents (derived): OWNER + MANAGER may propose all ten; ATTENDANT
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
