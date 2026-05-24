# W7-DECISIONS — Admin scheduler / tables / delivery-zone governance (P2)

Owner: W7-Govern-Admin
Branch: `feat/correctness-w7-close-w6-findings`
Scope: admin route call sites whose underlying services have **no**
`*FromEnvelope` adjudicated path.

The W7 orchestrator brief identified **6 sites** (the P0/P1 write
mutations explicitly called out by W6 §"10 — New bypasses discovered"
rows 6–11). The actual bare-mutator surface in those 3 admin route
files is **10 sites** — when the W7-P2 grep gate ran for the first time
it surfaced 4 additional bare calls (holiday add/remove, override
delete, delivery-zone delete) that the W6 doc under-counted. All 4 share
the same operator-only, low-blast risk profile as the 6 P0/P1 sites and
are therefore handled by the same allowlist with site-by-site
rationale comments.

| #  | File:line                                                                                | Bare call                       | W6 classification |
|----|------------------------------------------------------------------------------------------|---------------------------------|--------------------|
| 1  | `apps/api/src/routes/admin/schedule.ts:89`                                               | `svc.upsertDay`                 | P1 (W6 row 10)     |
| 2  | `apps/api/src/routes/admin/schedule.ts:109`                                              | `svc.addHoliday`                | not in W6          |
| 3  | `apps/api/src/routes/admin/schedule.ts:128`                                              | `svc.removeHoliday`             | not in W6          |
| 4  | `apps/api/src/routes/admin/schedule.ts:171`                                              | `svc.upsertOverride`            | P1 (W6 row 11)     |
| 5  | `apps/api/src/routes/admin/schedule.ts:191`                                              | `svc.removeOverride`            | not in W6          |
| 6  | `apps/api/src/routes/admin/tables.ts:55`                                                 | `tableSvc.upsert`               | P0 (W6 row 6)      |
| 7  | `apps/api/src/routes/admin/tables.ts:92`                                                 | `tableSvc.generateTimeSlots`    | P0 (W6 row 7)      |
| 8  | `apps/api/src/routes/admin/delivery-zones.ts:75`                                         | `deliveryZoneSvc.create`        | P0 (W6 row 8)      |
| 9  | `apps/api/src/routes/admin/delivery-zones.ts:115`                                        | `deliveryZoneSvc.update`        | P0 (W6 row 9)      |
| 10 | `apps/api/src/routes/admin/delivery-zones.ts:140`                                        | `deliveryZoneSvc.remove`        | not in W6          |

Wave 6 governance-coverage findings:
`docs/adjudicate-migration/correctness-remediation/wave6-governance-coverage.md`
§"10 — New bypasses discovered" rows 6–11.

---

## Chosen path

**Path (b) — Explicit deferral via `DEFERRED_ADMIN_LOW_RISK` allowlist.**

These six bare-service-call sites are landed in an allowlist whose existence
is enforced by the bypass-detection test, with a paired comment naming the
deferral rationale and the follow-up trigger conditions.

The allowlist is implemented in
`apps/api/src/__tests__/bypass-detection/bypass-detection.test.ts`,
mirroring the `DEFERRED_MEDUSA_MIGRATIONS` pattern (currently empty in
steady state — see lines ~406 in that file before this commit). A new
test surface scans `apps/api/src/routes/admin/{schedule,tables,delivery-zones}.ts`
for the listed bare service calls and fails the build IF the call shape
re-appears under a file NOT in the allowlist OR if a call shape that
WAS allowlisted is removed (a follow-up integration would lift the entry).

---

## Why path (b) over path (a)

The decision criteria called out by the orchestrator were policy-blast
radius, audit-trail requirement, and rollout cost.

### 1. Policy-blast radius — LOW

All 6 mutations are **operator-only**, gated by `requireManagerRole`
(staff JWT, post-OTP):

- `apps/api/src/routes/admin/schedule.ts` — every mutation route runs
  `preHandler: requireManagerRole`.
- `apps/api/src/routes/admin/tables.ts` — `POST /api/admin/tables`
  and `POST /api/admin/timeslots` run `preHandler: requireManagerRole`.
- `apps/api/src/routes/admin/delivery-zones.ts` — all CRUD routes run
  `preHandler: [requireManagerRole]`.

The LLM is NEVER a caller of any of these routes:

- They are not exposed through `apps/api/src/whatsapp/*`.
- They are not in `packages/tools/src/*`.
- The capability planner (`packages/llm-provider/src/capability-planner.ts`)
  does not advertise any `schedule.*` / `table.*` / `deliveryZone.*` tools.

Concretely, the LLM-forgery vector the kernel was designed to close
(an LLM emitting a tool call that mutates state) **does not exist** for
these sites. The only way to invoke them is to authenticate as a
manager-role staff member and POST/PUT/DELETE from the admin console
(or a curl with the staff JWT).

The downstream behavior is real but bounded:

| Site                          | Blast radius                                                                          |
|-------------------------------|----------------------------------------------------------------------------------------|
| Schedule weekly hours         | A manager who flips open/closed for a day misses-or-accepts an order window           |
| Schedule overrides            | Per-date override flips open/closed for a single day                                    |
| Table create/update           | Capacity / location label on a single table row                                         |
| TimeSlot generation           | Bulk-creates reservation slots for a date range (`createMany`, idempotent skipDups)     |
| Delivery zone create          | Adds a CEP-prefix → fee mapping (the route ALREADY rejects duplicate CEP prefixes)      |
| Delivery zone update          | Mutates an existing zone (the route ALREADY rejects CEP collisions with other zones)    |

None of these flows touch:

- Financial state (no charge/refund/dispute writes).
- LGPD-scope PII (no customer data, no allergen flags, no PIX details).
- Allergen safety (CLAUDE.md rule #1 applies to product/customer data, not zones).
- Order projection state.
- Customer reservations (reservation rows are governed by the reservation pack).

The "borderline" framing from the orchestrator prompt is fair, but the
borderline-ness collapses once you constrain the caller axis to "staff who
already authenticated via OTP and was granted the manager role." Those
operators are a small, named population with audit trails outside the
intent layer (HTTP request logs, manager-role grant ledger). The marginal
gain from a policy-bundle adjudication on these six sites is small.

### 2. Audit-trail requirement — covered by existing surfaces

The path (a) win would be an intent-audit record per mutation. We already
have the following non-intent audit surfaces for these sites:

- Fastify request logs (request ID, manager-staff ID, route, body) on every
  admin mutation — already wired via the API's global request-id plugin.
- Manager-role assignment is itself an audited event (`Staff` table mutations).
- Schedule, table, and delivery-zone state is queryable via the public
  `GET` routes — the "what did the operator change" diff is computable
  post-hoc from a backup snapshot or audit log replay.
- For delivery-zones, the route layer enforces idempotency via Redis
  dedup keys (`dz:create:dedup:*`, `dz:update:dedup:*`, `dz:delete:dedup:*`)
  with 300s NX TTL — this catches the most-likely operator-side error
  (double-click submit).

The intent-audit ledger is designed for adversarial / untrusted callers
(LLM + customer) where the audit is BOTH a forensic record AND a
divergence-detection signal (kernel-shadow vs kernel-enforce). For
operator-only routes, the divergence-detection axis adds no signal
(there's no LLM-vs-deterministic dual path to compare), and the forensic
axis is met by the request log.

### 3. Rollout cost — ~3-6h for path (a) vs ~30 min for path (b)

Path (a) workload (estimated):

- 10 new intent kinds in `pack-customer-onboarding` (or a new pack):
  `admin.schedule.weekly.upsert`, `admin.schedule.holiday.add`,
  `admin.schedule.holiday.remove`, `admin.schedule.override.upsert`,
  `admin.schedule.override.remove`, `admin.table.upsert`,
  `admin.table.timeslots.generate`, `admin.deliveryZone.create`,
  `admin.deliveryZone.update`, `admin.deliveryZone.remove`. The pack
  name fits poorly — `pack-customer-onboarding` is a customer-domain
  pack; these kinds are operational/admin. A separate `pack-admin-config`
  pack would be more honest, but creating a single-purpose pack for 10
  kinds with trivial policy (auth-only, no taint differentiation) is a
  code smell.
- Policy bundle for each kind. The actual policy is "manager role and
  payload schema valid" — both of those are already enforced by the
  route layer (`requireManagerRole` + Zod). Duplicating into a pack
  policy adds maintenance burden without correctness gain.
- `*FromEnvelope` method on each of 3 services. The body would be a
  thin wrapper around the existing imperative method (the pack policy
  returns EXECUTE for staff principal; the wrapper calls the existing
  method).
- Update `KNOWN_INTENT_KINDS` set + `intent-kinds.test.ts` fixture.
- Wire each of 6 routes to build an envelope and call the FromEnvelope
  method.
- Tests for at least 2 representative routes (per the W7 prompt).

Realistic estimate: 4-6h of careful work with the same architectural
template the reservation/customer packs used.

Path (b) workload:

- Create the `DEFERRED_ADMIN_LOW_RISK` allowlist in the bypass-detection
  test (~50 LoC).
- Add a scan that detects the bare service calls and respects the allowlist.
- Document the 10 sites with rationale (one comment per entry).
- One commit.

The cost-vs-correctness trade-off for these specific sites favors path (b).

### 4. The W7-RULE-F angle

The prompt called out RULE F explicitly: path (a) means intent-kinds +
envelope methods + route-wiring MUST land in the same commit. The reverse
risk (which RULE F was designed to block) is shipping the policy
infrastructure without the routes wired, then losing the orphan code in a
later refactor. The DEFERRED_ADMIN_LOW_RISK pattern sidesteps that risk
entirely by NOT shipping orphan policy — the allowlist is a declarative
contract that says "we deliberately do NOT govern these 10 sites with the
envelope flow; here is why."

The follow-up condition (when this allowlist should empty) is:

> "If any of these 3 services (`schedule`, `table`, `deliveryZone`) grows
> a customer-facing or LLM-reachable caller (e.g., a chat tool that
> creates a delivery zone, or a webhook that mutates the weekly schedule),
> the corresponding kinds MUST be added to the intent taxonomy and the
> bare-service-call MUST be routed through `*FromEnvelope`."

The bypass-detection test holds the line if a future change reintroduces
a bare service call from a DIFFERENT route file (the allowlist is
file-scoped to the 3 known admin routes).

---

## Follow-up triggers (when to revisit path (a))

This deferral is NOT a permanent decision. Promote to path (a) the moment
ANY of the following occurs:

1. A `packages/tools/src/*` tool is added that calls
   `createScheduleService` / `createTableService` / `createDeliveryZoneService`.
   The LLM gains a mutating surface to these services — the trade-off
   inverts and the envelope flow becomes load-bearing.
2. A customer-facing route (`apps/api/src/routes/me/*`,
   `apps/api/src/routes/cart.ts`, etc.) calls any of the three services'
   mutating methods. UNTRUSTED principals reach the surface — the
   envelope flow becomes load-bearing.
3. LGPD scope expands and any of these services starts persisting PII
   (e.g., a customer-bound delivery preference under
   `deliveryZoneSvc.update`). The audit-redactor path becomes load-bearing.
4. Operator audit requirements tighten and the request-log surface is
   no longer sufficient (e.g., regulator subpoena needs intent-hash-
   replay). The intent-audit ledger becomes the legal anchor.
5. The bypass-detection test is extended to grep
   `apps/api/src/routes/admin/*.ts` for bare `svc.X()` calls — at that
   point the allowlist is the documented carve-out, not a hidden
   exception.

Each of these triggers should be picked up by the W8/W9 governance
review and converted to path (a) work if true.

---

## What this commit changes

1. `apps/api/src/__tests__/bypass-detection/bypass-detection.test.ts`:
   - Adds the `DEFERRED_ADMIN_LOW_RISK` allowlist (10 entries — one per
     bare service-call site, file + line + rationale).
   - Adds a new test surface that scans
     `apps/api/src/routes/admin/{schedule,tables,delivery-zones}.ts` for
     the 10 bare service-call shapes and asserts:
     - Each call must match an entry in `DEFERRED_ADMIN_LOW_RISK`.
     - Any NEW bare-call shape (outside the allowlist) fails the build.
     - Removing an entry without removing the call shape also fails
       (sentinel against accidental allowlist loss).
2. `docs/adjudicate-migration/correctness-remediation/W7-DECISIONS-admin.md`:
   - This document.
3. `docs/adjudicate-migration/correctness-remediation/w7-evidence/P2-{before,after}.txt`:
   - Before/after snapshots required by the W7-Verifier.

NO changes to:
- The 3 admin route files themselves (their existing behavior is
  unchanged).
- The 3 services (no new methods, no new exports).
- The packs (no new intent kinds, no new policies).
- The route tests (existing tests pass; the new test lives in the
  bypass-detection suite).

---

## Risk acceptance

This decision accepts:

- The 10 admin mutation sites do not flow through `adjudicate()` and
  therefore do not contribute to the intent-audit ledger.
- The kernel-shadow / kernel-enforce divergence telemetry has no signal
  on these sites.
- If a manager-role staff member is compromised, the attacker can mutate
  schedule, tables, and delivery zones without an envelope-hashed audit
  record. (The Fastify request log + manager-role grant ledger still
  attribute the attacker; the gap is the kind-level audit categorization,
  not the attribution.)

The trade-off is bounded by the staff-only access constraint and the
small surface (10 admin endpoints, low call frequency).

If a W7-Verifier audit disagrees with this risk acceptance, the
follow-up work (path (a)) is well-scoped: see §"Path (a) workload"
above.
