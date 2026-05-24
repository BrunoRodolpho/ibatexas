# Wave 7 — Consolidated Decisions Log

**Date:** 2026-05-23
**Branch:** `feat/correctness-w7-close-w6-findings`
**Scope:** the three discretionary decisions made during Wave 7 closure where an agent chose between two well-defined paths.

This document is the canonical entry point for Wave 7 decision rationale. The per-agent fragments are preserved as the original drafted artefacts and remain referenced from this document — they were not deleted:

- `docs/adjudicate-migration/correctness-remediation/W7-DECISIONS-admin.md` — drafted by W7-Govern-Admin, full rationale for W7-D1 (P2 admin deferral)
- `docs/adjudicate-migration/correctness-remediation/W7-DECISIONS-ops.md` — drafted by W7-Ops, full rationale for W7-D2 (O3 two-person rule) and W7-D3 (O4 OWNER role) plus mechanical notes on O1/O2/O5

Read the per-agent docs for the full evidence chain (file-line citations, blast-radius tables, alternative workload estimates). This consolidated doc is the structured index and quick-reference for future readers and Wave 8 planners.

---

## Index

| ID | Title | Status | Owner | Reverse triggers |
|---|---|---|---|---|
| W7-D1 | P2 admin scheduler/tables/zones — deferral via `DEFERRED_ADMIN_LOW_RISK` allowlist | Decided 2026-05-23 | W7-Govern-Admin | See §W7-D1 follow-up triggers |
| W7-D2 | O3 CLI vs admin HTTP two-person-rule reconciliation — keep CLI as solo-emergency surface | Decided 2026-05-23 | W7-Ops | See §W7-D2 follow-up triggers |
| W7-D3 | O4 MANAGER vs OWNER role for kill-switch — align route to strategy doc | Decided 2026-05-23 | W7-Ops | See §W7-D3 follow-up triggers |

---

## W7-D1 — Defer P2 admin scheduler/tables/delivery-zone via `DEFERRED_ADMIN_LOW_RISK` allowlist

**Owner:** W7-Govern-Admin
**Full per-agent rationale:** [W7-DECISIONS-admin.md](./W7-DECISIONS-admin.md)
**Implementing commit:** `dbf077e` — `chore(governance,correctness-w7-P2): defer admin scheduler/tables/zones via DEFERRED_ADMIN_LOW_RISK allowlist`

### Context

The W7 orchestrator brief identified 6 admin sites (from W6 §"10 — New bypasses discovered" rows 6–11) that mutate state via bare service methods despite their underlying services lacking `*FromEnvelope` adjudicated paths. When W7-Govern-Admin ran the actual grep against `apps/api/src/routes/admin/{schedule,tables,delivery-zones}.ts`, **10 bare-mutator sites** surfaced — the W6 inventory had undercounted by 4 (holiday add, holiday remove, override delete, delivery-zone delete). All 10 share the same operator-only `requireManagerRole`-gated risk profile.

### Options considered

- **Path (a)** — Build the full envelope flow: 10 new intent kinds in a new `pack-admin-config`, policy bundles for each, `*FromEnvelope` methods on each service, route-wiring per RULE F (single commit). Estimated 4-6h.
- **Path (b)** — Explicit deferral via `DEFERRED_ADMIN_LOW_RISK` allowlist enforced by the bypass-detection test, with per-entry rationale comments. Estimated ~30 min.

### Chosen path: (b) — deferral

### Rationale

The chosen-path-(b) decision rested on three converging factors:

1. **Policy-blast radius is LOW.** All 10 sites are `requireManagerRole`-gated and not exposed to the LLM (not in `packages/tools/src/`, not advertised by the capability planner, no chat-tool path). The LLM-forgery vector the kernel was designed to close does not exist for these sites. The only caller axis is "authenticated manager-role staff."
2. **Audit-trail requirement is covered by existing surfaces.** Fastify request logs attribute every admin mutation by manager-staff ID + route + body. Manager-role assignment is itself an audited event. Delivery-zone routes already enforce idempotency via Redis NX dedup keys. The marginal forensic gain from intent-audit ledger entries is small; the divergence-detection axis (shadow vs enforce) has no signal because there's no LLM-vs-deterministic dual path on operator-only routes.
3. **Cost-vs-correctness trade-off favours (b).** Path (a) needs a new pack whose policy is "manager role + Zod-valid payload" — both already enforced at the route layer. Duplicating into pack policy adds maintenance burden without correctness gain. Path (b) is a declarative "we deliberately do NOT govern these 10 sites; here is why" contract enforced by the bypass-detection test.

The implementation lands a `DEFERRED_ADMIN_LOW_RISK` allowlist that scans the 3 admin route files for the 10 specific bare-call shapes and fails the build if (a) any NEW bare-call shape appears outside the allowlist, or (b) an allowlist entry is removed without the corresponding call shape also being removed.

### What this decision accepts

- The 10 admin mutation sites do not flow through `adjudicate()` and do not contribute to the intent-audit ledger.
- The shadow-vs-enforce divergence telemetry has no signal on these sites.
- A compromised manager-role staff member can mutate schedule/tables/delivery-zones without an envelope-hashed audit record. The Fastify request log + manager-role grant ledger still attribute the attacker; the gap is kind-level audit categorization, not attribution.

The trade-off is bounded by the staff-only access constraint and the small surface (10 admin endpoints, low call frequency).

### Follow-up triggers (when to promote to path (a))

Promote to path (a) the moment ANY of the following occurs:

1. A `packages/tools/src/*` tool is added that calls `createScheduleService` / `createTableService` / `createDeliveryZoneService` — the LLM gains a mutating surface; envelope flow becomes load-bearing.
2. A customer-facing route (`apps/api/src/routes/me/*`, `apps/api/src/routes/cart.ts`, etc.) calls any of the three services' mutating methods — UNTRUSTED principals reach the surface.
3. LGPD scope expands and any service starts persisting PII — audit-redactor path becomes load-bearing.
4. Operator audit requirements tighten beyond Fastify request logs (e.g., regulator subpoena needs intent-hash replay) — intent-audit ledger becomes the legal anchor.
5. Bypass-detection scan is extended to grep `apps/api/src/routes/admin/*.ts` for any bare `svc.X()` call — at that point the allowlist becomes the documented carve-out rather than a hidden exception (some downstream review may decide the carve-out is worth the cost).

Each trigger should be picked up by the W8/W9 governance review and converted to path (a) work if true.

---

## W7-D2 — O3 keep CLI kill-switch as solo-emergency surface; HTTP route remains the two-person surface

**Owner:** W7-Ops
**Full per-agent rationale:** [W7-DECISIONS-ops.md](./W7-DECISIONS-ops.md) §O3
**Implementing commit:** `5cfbede` — `fix(cli,correctness-w7-O3): reconcile two-person rule — CLI emergency-bypass posture with TTY/flag guardrail`

### Context

Wave 6 operational-drill Drill 1 verdict PARTIAL. The `ibx kernel kill-switch enable` CLI writes the Redis flag directly via `createKillSwitchStore`, bypassing the two-person rule that the admin HTTP endpoint (`/api/admin/kernel/kill-switch`) enforces. A 3am responder using only the CLI engages the kill switch single-handedly. The runbook ambiguously presents both surfaces as equivalent, so an operator reading the docs cannot tell which surface enforces what.

### Options considered

- **Path (a)** — Harden the CLI to require the admin endpoint: CLI becomes a step-1 issuer that prints a receipt for a second operator to confirm via the HTTP endpoint. The CLI becomes a thin wrapper over the two-person flow.
- **Path (b)** — Document the two surfaces as having different threat models: CLI = solo-on-call emergency; HTTP = scheduled flips with two-person required. Add TTY guardrail + explicit confirmation flag + audit breadcrumbs on the CLI side.

### Chosen path: (b)

### Rationale

Path (a) would re-create the failure mode the CLI exists to break out of. The whole point of a CLI surface that talks to Redis directly is to give one trusted operator a last-resort lever at 3am when the secondary phone is unanswered. If we collapse the CLI into the HTTP two-person flow, we have not "added security" — we have removed the lever and pushed the failure mode forward.

The CLI now requires either:
- An interactive TTY with a pt-BR confirmation prompt that explicitly names the "solo-operator emergency bypass" semantics, OR
- The `--yes-i-am-solo-on-call` flag (CI/non-interactive contexts). Without either, the CLI refuses — so a script that pipes `yes` cannot accidentally engage.

Every CLI engagement emits a Sentry breadcrumb + structured audit log entry with `bypass: "two_person_rule"`, `surface: "cli"`, `operator: <IBX_OPERATOR or user@host>`. This is the durable trail an incident review reads. The runbooks (`migration/05-kill-switch-strategy.md` and the SHADOW-ENFORCE-ROLLOUT.md cross-reference) explicitly state:

> CLI → solo on-call, emergencies; bypass is intentional.
> HTTP → scheduled flips, normal operations; two-person required.

### What this decision accepts

- A compromised CLI-bastion credential CAN engage the kill switch single-handedly.

Mitigations:
- The kill switch is a REFUSE-everything switch, not an EXECUTE switch — engagement causes loss of availability, not data exfiltration or mutation.
- Sentry breadcrumb + audit record give ~4-hour incident detection.
- Bastion access is OWNER-only via SSH key + MFA (`docs/setup/deployment.md`).

### Follow-up triggers (when to reverse)

1. The kill switch evolves from REFUSE-everything to per-intent-class EXECUTE selection (e.g., "force-cancel everything except refunds") — the blast radius changes character and the solo-bypass posture must be re-evaluated.
2. Bastion access pattern changes (e.g., a shared service account replaces per-engineer SSH keys) — the OWNER-only mitigation weakens.
3. Sentry breadcrumb coverage drops below the 4-hour incident-detection threshold — the durable-trail mitigation weakens.

---

## W7-D3 — O4 align kill-switch route to OWNER per the strategy doc

**Owner:** W7-Ops
**Full per-agent rationale:** [W7-DECISIONS-ops.md](./W7-DECISIONS-ops.md) §O4
**Implementing commit:** `508b979` (bundled with P5 + P6 + stripe-webhook updates — see §"Audit-trail caveat" in W7-SYNTHESIS.md)

### Context

The strategy doc `migration/05-kill-switch-strategy.md` §"Authorisation matrix" requires OWNER for global kill-switch toggles ("MANAGER cannot trigger"). The route at `apps/api/src/routes/admin/kernel.ts:172` was using `requireManagerRole`. The earlier W3 D2 commit (`93c7a42`) self-acknowledged the mismatch in a code comment claiming "MANAGER is permitted in this implementation so non-OWNER admins can drill the runbook in staging."

The W6 red-team and the W6 operational-drill both flagged this drift as a real threat-model inconsistency that should not be resolved by an inline code comment.

### Options considered

- **Path (a)** — Change the strategy doc to permit MANAGER, ratifying the route code as canonical.
- **Path (b)** — Change the route to `requireOwnerRole`, aligning code to the strategy doc.

### Chosen path: (b) — OWNER

### Rationale

1. **The strategy doc is the canonical threat-model statement.** Calling it "guidance" understates the role of a doc that defines the security boundary. Deviation requires a written rationale; the W3 D2 inline comment was a code-level comment, not a strategy decision. Drills can run with an OWNER-typed staff JWT, and the CLI surface (per W7-D2 above) is the operator-initiated drill path anyway — no need for the HTTP route to relax its threshold.
2. **The kill switch is a global REFUSE-everything switch.** Allowing MANAGER expands the blast radius of a single compromised MANAGER account to "deny all customer-facing mutations." The customer-impact ceiling is too high to delegate to a non-OWNER role.
3. **Internal consistency.** Per-intent and per-pack switches (M7+ scope) are explicitly OWNER-only in the same strategy doc table. Inconsistency between global and the narrower scopes is a worse threat model than OWNER-everywhere uniformity.

### Implementation

The route at `apps/api/src/routes/admin/kernel.ts:183,290` is changed to `requireOwnerRole`. The test fixtures at `apps/api/src/routes/admin/__tests__/kernel-kill-switch.test.ts` are updated to use OWNER-typed staff records. A new 403 assertion is added so a future regression from OWNER → MANAGER fails the build (10 tests pass).

### What this decision accepts

- MANAGER-role staff cannot drill the kill switch via the HTTP route in any environment. Drill is done via the CLI (per W7-D2) or by promoting the drilling staff to OWNER for the drill window.

### Follow-up triggers (when to revisit)

1. The kill switch threat model changes such that MANAGER becomes the canonical operator role (would require a corresponding strategy doc rewrite).
2. The strategy doc itself is rewritten — at which point the role gate should be re-derived from the new doc rather than carrying the OWNER assumption forward.
3. A multi-tenant scenario emerges where per-tenant kill switches need a per-tenant role gate (the current decision is single-tenant).

---

## Appendix — Other mechanical W7 closures (no discretionary decision)

For completeness, the following W7 closures had a single sensible path and required no decision rationale beyond the implementing commit:

- **G1 — whitespace customerId trim.** Added `.trim().length === 0` to empty-string guards + canonicalisation at `anonymize-otp-gate.ts`. Commit `b9575bc`. Evidence: `w7-evidence/G1-after.txt`.
- **G2 — template-literal regex widening.** Widened `['"]` to `` ['"`] `` in `FORBIDDEN_MEDUSA_MULTILINE`. Commit `497e7c7` (msg says P6 due to index race). Evidence: `w7-evidence/G2-after.txt`.
- **G3 — hoist `actorPrincipal` in NX-park adapter.** Defensive hoist from `actor.principal` → top-level. Commit `e1e1e10`. Evidence: `w7-evidence/G3-after.txt`. Verifier surfaced NEW-W7-V3 because the hoist only covers `actorPrincipal`, not `version/nonce/taint` — see W7-SYNTHESIS §"NEW findings."
- **G4 — `kernel_audit_sink_spill_size` canonical metric.** Renamed across sink/dashboard/alert; programmatic allowlist. Commit `d922671`. Evidence: `w7-evidence/G4-after.txt`.
- **P1 — reservation tool layer.** 3 of 4 sites use `*FromEnvelope`; `join-waitlist` documented-blocked on missing service-side method (sub-finding for packages/domain owner). Commit `8cc3fb3`. Evidence: `w7-evidence/P1-after.txt`.
- **P3 — customer onboarding upserts.** `auth.ts:430` + `whatsapp/session.ts:177` wrap via `createFromEnvelope` with system-actor envelope. 3 commits in the log are labeled P3 due to index race (`1efa47a`, `4924228`, `b5ab090`) — actual P3 work is in some subset; per the verifier's forensic table the second and third are mislabeled. Evidence: `w7-evidence/P3-after.txt`.
- **P4 — `prisma.orderNote.create` x4.** All 4 sites route through `order.note.add` intent. Commit `77cef72`. Evidence: `w7-evidence/P4-after.txt`.
- **P5 — `stripeAdjudicated` wrapper + 6 cart migrations.** Wrapper at `packages/tools/src/stripe/adjudicated.ts`. 6 cart sites migrated. `getStripe()` factory retained per D8 parallel-surface convention. Commit `508b979` (bundled with O4 + P6 + stripe-webhook updates). Evidence: `w7-evidence/P5-after.txt`. Verifier flagged residual: bare `stripe.paymentIntents.update()` in `stripe-webhook.ts:308` (NEW-W7-V2) — outside P5 scope.
- **P6 — `fetchAdmin` order.service.** 6 sites in `order.service.ts` route through `medusaAdjudicated` when `adminAdjudicated` is injected; stripe-webhook wires the injection. Commit `508b979` (bundled with O4 + P5). Evidence: `w7-evidence/P6-after.txt`. Verifier surfaced NEW-W7-V1 (P0) — 3 cart-tool callers do NOT inject `adminAdjudicated` and hit the silent fallback.
- **O1 — `ibx kernel defer resume <sessionId>` CLI.** Calls `resolveDeferredSession` directly with a synthesised `payment.status_changed` event; 5 unit tests; runbook reference. Commit `bda5973`. Evidence: `w7-evidence/O1-evidence.txt`.
- **O2 — `pnpm migrate` phantom command.** Replaced the dead-end message in `runReplay()` off-state TODO with an executable `for f in ../adjudicate/packages/audit-postgres/migrations/*.sql; do psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f"; done` recipe. Commit `b5ab090` (msg says P3 due to index race). Evidence: `w7-evidence/O2-evidence.txt`. **Note:** path (b) was chosen — see W7-DECISIONS-ops.md §O2 for the brief rationale (we did NOT add a runner script because no migration runner exists in the codebase; adding one was out of scope, and adding a `migrate` script that points to a non-existent implementation would re-create the phantom on a new surface).
- **O5 — runbook Redis-key references.** `ibatexas:foo` literals → `<APP_ENV>:foo` + `rk()` helper citation. Docs-only commit per RULE G. Commit `9fbd335`. Evidence: `w7-evidence/O5-evidence.txt`.

---

End of W7 consolidated decisions log.
