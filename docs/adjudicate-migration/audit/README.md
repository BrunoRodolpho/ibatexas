# `audit/` — pre-cutover audit pass (2026-05-23)

## What's in this directory

Eight specialised audit reports plus a synthesis keystone, produced on
2026-05-23 against the pre-cutover branch `feat/consume-adjudicate-from-platform-repo`
@ `0e1fb62`. The reports surveyed the overnight-run output against the
"every mutation flows through `adjudicate()`" claim and produced 22 confirmed
bypasses (7 P0, 12 P1, 3 P2) plus structural concerns on replay determinism,
DEFER park/resume, security/red-team posture, fail-open inventory, taxonomy
drift, and test-coverage gaps. The audit triggered Waves 1-9 of the
correctness-remediation work and ultimately the IBX-IGE v3.0 always-on
cutover (`f3bea43`).

All findings here have been worked through. The current "what remains"
ledger is [`../audit-2026-05-24/CLOSEOUT-STATUS.md`](../audit-2026-05-24/CLOSEOUT-STATUS.md).
This directory is preserved as the institutional record of how the
cutover-readiness assessment was conducted.

## Classification

| File | Classification | One-line summary |
|---|---|---|
| `AUDIT-SYNTHESIS.md` | Historical preserved | Master findings keystone (22 bypasses, 5 P0s, "DO NOT flip IBX_KERNEL_ENFORCE" verdict). The env-var gate it references was deleted in the cutover. |
| `01-bypass-hunter.md` | Historical preserved | Adversarial review of every mutation path. P0 findings drove Waves 1-3. |
| `02-replay-determinism.md` | Historical preserved | Replay-byte-determinism audit; informed the redactor-hash decision and nonce policy. |
| `03-deferred-workflow.md` | Historical preserved | DEFER park/resume lifecycle audit; drove Wave 4 hardening. |
| `04-pack-conformance.md` | Historical preserved | Per-pack scorecard against the v0 contract; informed taxonomy alignment. |
| `05-security-red-team.md` | Historical preserved | Adversarial review (LGPD-anonymize, NATS auth, admin two-person rule). |
| `06-reliability-fail-open.md` | Historical preserved | 27-site fail-open inventory; led to fail-closed audit-sink + ledger work. |
| `07-intent-kind-drift.md` | Historical preserved | Taxonomy vs Pack vs caller-side naming drift; informed governance/01 + KNOWN_INTENT_KINDS. |
| `08-test-coverage-gaps.md` | Historical preserved | Cross-layer composition gaps; drove Wave-6 integration suite scope. |
| `REDACTION-HASH-DECISION.md` | Historical preserved | P0-15 ADR-style note documenting why redactor recomputes `auditHash` (Option A). |

## Current-state pointers

- **Closeout status (authoritative as of 2026-05-24):** [`../audit-2026-05-24/CLOSEOUT-STATUS.md`](../audit-2026-05-24/CLOSEOUT-STATUS.md)
- **Constitutional rule:** `CLAUDE.md` rule #9 — "LLM Authority — IBX Intent-Gated Execution v3.0"
- **Always-on cutover commit:** `f3bea43` (deleted the shadow/enforce/kill-switch machinery these audits assumed)
- **Refreshed audit pass (post-cutover):** [`../audit-2026-05-23/SYNTHESIS.md`](../audit-2026-05-23/SYNTHESIS.md) (fresh 2026-05-23 audit run; itself superseded by `audit-2026-05-24/` for outstanding-items tracking)
