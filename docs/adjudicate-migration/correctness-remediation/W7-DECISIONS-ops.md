> ⚠️ **SUPERSEDED on 2026-05-24.** W7 per-agent rationale for operational findings O1-O5 (2026-05-23). The `ibx kernel kill-switch` CLI subcommands and the kill-switch admin endpoint were deleted by the IBX-IGE v3.0 cutover (`f3bea43`) since the always-on kernel has no kill switch. For current operator surface, see `docs/ops/runbooks/kernel-operations.md`. Content preserved unchanged below as historical record.

---

# W7-DECISIONS — Operational findings (O1–O5)

Owner: W7-Ops
Branch: `feat/correctness-w7-close-w6-findings`
Scope: 5 operational findings raised by the W6 operational-drill audit
(`correctness-remediation/wave6-operational-drill.md` §"Final scorecard"
rows 1, 4, 5; plus W6-RED-TEAM cross-checks on role mismatch + key
namespacing).

Each finding lands in a single atomic commit per the W7 brief. This
document records the discretionary calls (O3, O4) and the reasoning;
O1, O2, O5 are mechanical fixes whose evidence lives next to them in
`w7-evidence/O{1,2,3,4,5}-evidence.txt`.

---

## O1 — `ibx kernel defer resume <sessionId>` CLI

**Finding:** Wave-6 Drill 5 verdict FAIL. No CLI exists to recover a
stuck-deferred session — operators must `SCAN` Redis, parse the parked
envelope JSON, and manually publish a NATS `payment.status_changed`
event. The Tier-1 readiness gap blocks PIX migration enforce.

**Resolution:** mechanical — see the O1 commit. The CLI calls
`resolveDeferredSession` directly with a synthesised `payment.status_changed`
event so the existing two-phase resume + audit path runs unchanged.

The framework's `verifyParkedEnvelopeHash` is already verified-true for
v0.5+ parked blobs (the only shape the responder writes today). W7-Gates
G3 will harden the hash-fail audit path; the CLI does not depend on that
work because tampered blobs already DLQ on the resolver side.

Evidence: `w7-evidence/O1-evidence.txt` (real run against Docker Redis).

---

## O2 — `pnpm migrate` phantom command

**Finding:** Wave-6 Drills 4 + 6 verdict PARTIAL. The replay CLI's
off-state TODO says "Rodar `pnpm migrate` em @adjudicate/audit-postgres"
(`packages/cli/src/commands/kernel.ts:239`), but `@adjudicate/audit-postgres`
has no `migrate` script — only raw SQL files under
`packages/audit-postgres/migrations/*.sql` in the platform repo. A 3am
operator hits a dead end.

**Chosen path:** (b) — replace the message with the actual operator
command path. We do NOT add a `migrate` script to root package.json
because the migration runner does not exist anywhere in the codebase
(`grep -rn "runMigrations\|applyMigrations" packages/audit-postgres/src/`
returns only doc references to SQL filenames). Writing a runner from
scratch is out of scope; a script that points to a non-existent
implementation would re-create the phantom on a new surface.

The corrected message names the SQL directory (`packages/audit-postgres/
migrations/`), the order ("001-…sql first; later numbered files are
additive"), and the recommended invocation (`psql $DATABASE_URL -f
<file>` per file). This is what the operator actually has to type.

Evidence: `w7-evidence/O2-evidence.txt`.

---

## O3 — CLI vs admin endpoint two-person rule reconciliation

**Finding:** Wave-6 Drill 1 verdict PARTIAL. The `ibx kernel kill-switch
enable` CLI writes the Redis flag directly via `createKillSwitchStore`,
bypassing the two-person rule the admin HTTP endpoint enforces. A 3am
responder using only the CLI engages the kill switch single-handedly.

**Chosen path:** (b) — document the CLI as an OPS-EMERGENCY surface
with explicit risk acceptance; the admin HTTP endpoint remains the
two-person surface for scheduled flips. The CLI gains:

  1. A pt-BR confirmation prompt naming the "solo-operator emergency
     bypass" semantics. Pass `--yes-i-am-solo-on-call` to bypass the
     prompt (CI/non-interactive contexts). Without the flag, the CLI
     refuses if stdin is not a TTY — so a script that pipes `yes` cannot
     accidentally engage.

  2. Sentry breadcrumb + structured audit log entry on every CLI
     engagement that explicitly tags `bypass: "two_person_rule"`,
     `surface: "cli"`, `operator: <IBX_OPERATOR or user@host>`. This is
     the durable trail an incident review reads.

  3. A runbook line in `migration/05-kill-switch-strategy.md` (and the
     SHADOW-ENFORCE-ROLLOUT.md cross-reference) explicitly stating the
     two surfaces have different threat models:
       - CLI → solo on-call, emergencies; bypass is intentional.
       - HTTP → scheduled flips, normal operations; two-person required.

**Why (b) over (a):** path (a) (CLI becomes a step-1 issuer that prints a
receipt for a second operator to confirm) would re-create the failure
mode the CLI exists to break out of — a solo on-call at 3am with the
secondary phone unanswered cannot engage the kill switch. The whole
point of the CLI surface is to give one trusted operator a last-resort
lever; collapsing it into the HTTP two-person flow removes the lever.

The risk acceptance is: a compromised CLI-bastion credential CAN engage
the kill switch single-handedly. Mitigations: (i) the kill switch is a
REFUSE-everything switch, not an EXECUTE switch — engagement causes loss
of availability, not data; (ii) Sentry breadcrumb + audit record give
4-hour incident detection; (iii) bastion access is OWNER-only via SSH
key + MFA (`docs/setup/deployment.md`).

Implementation: see the O3 commit (`packages/cli/src/commands/kernel.ts`
`runKillSwitchEnable` + new flag + runbook line).

Evidence: `w7-evidence/O3-evidence.txt`.

---

## O4 — MANAGER vs OWNER role mismatch

**Finding:** Wave-6 Drill 1 verdict PARTIAL. The strategy doc
`migration/05-kill-switch-strategy.md` §"Authorisation matrix" requires
OWNER for global kill-switch toggles ("MANAGER cannot trigger");
`apps/api/src/routes/admin/kernel.ts:172` uses `requireManagerRole`. The
W3 D2 commit (`93c7a42`) self-acknowledged the mismatch in a comment:
"MANAGER is permitted in this implementation so non-OWNER admins can
drill the runbook in staging".

**Chosen role:** OWNER — align the route to the strategy doc.

**Why OWNER over MANAGER:**

  1. The strategy doc is the canonical threat-model statement. Calling
     it "guidance" understates the role of a doc that defines the
     security boundary; deviation requires a written rationale, not a
     code comment. The W3 D2 rationale ("drill in staging") is not load-
     bearing: drills can run with an OWNER-typed staff JWT, and the CLI
     surface (W7-O3 above) handles operator-initiated drills anyway.

  2. The kill switch is a global REFUSE-everything switch. Allowing
     MANAGER expands the blast radius of a single compromised MANAGER
     account to "deny all customer-facing mutations". The customer-impact
     ceiling is too high to delegate to a non-OWNER role.

  3. Per-intent and per-pack switches (M7+ scope) are explicitly OWNER-
     only in the same strategy doc table. Inconsistency between global
     and the narrower scopes is a worse threat model than OWNER-
     everywhere uniformity.

The route is changed to `requireOwnerRole`; the test fixtures at
`apps/api/src/routes/admin/__tests__/kernel-kill-switch.test.ts` are
updated to use OWNER-typed staff records, and a new 403 assertion is
added so a future regression from OWNER → MANAGER fails the build.

Evidence: `w7-evidence/O4-evidence.txt`.

---

## O5 — Runbook key references

**Finding:** Wave-6 Drill 1 (PARTIAL) + W6-RED-TEAM analysis. Runbooks
show `ibatexas:foo` literal Redis keys; the live keys go through `rk()`
(`packages/tools/src/redis/key.ts`) which prepends `<APP_ENV>:`. An
operator copy-pasting `redis-cli SCAN 0 MATCH "ibatexas:..."` gets zero
matches.

**Resolution:** mechanical doc fix — replace `ibatexas:` literals with
`<APP_ENV>:` placeholders + cite the `rk()` helper inline.

Affected files (final scope): `governance/07-rollback-recovery.md`,
`runbooks/SHADOW-ENFORCE-ROLLOUT.md`. `migration/05-kill-switch-strategy.md`
already uses the helper-named pattern. `investigation/06-runtime-config-
governance.md` is out of W7-Ops scope per the file allowlist (and the
ref there describes the ledger key shape descriptively, not as a copy-
paste command).

Per RULE G, isolated as a pure-doc commit.

Evidence: `w7-evidence/O5-evidence.txt`.
