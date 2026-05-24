# `threat-model/` — IbateXas kernel-gated mutation threat model

## What's in this directory

A single document — `THREAT-MODEL.md` — that is the "first formal threat
model post-adjudicate migration," authored as W6-12 (the final wave
before the deeper audit + correctness-remediation arc). It is the
load-bearing security artefact for the kernel-gated mutation surface
(LLM responder, intent dispatcher, Pack policies, command-service
envelope path, audit pipeline, DEFER park/resume, admin two-step
confirm, LGPD anonymize flow, Stripe webhook).

## Classification

| File | Classification | One-line summary |
|---|---|---|
| `THREAT-MODEL.md` | Load-bearing constitutional (with stale rollout framing) | Asset inventory, STRIDE matrix, LGPD analysis, and residual-risks list are still authoritative. Some companion-doc links and gating-language references describe deleted machinery. |

## How to use this doc today

The substantive sections are load-bearing:
- **Asset inventory** (lines 22-35): still accurate; new assets should be added here.
- **Trust boundaries** (lines 37-69): boundaries 1, 2, 3 are still accurate. Boundary 4 (env → kernel-config) is partially stale — `IBX_KERNEL_ENFORCE` was deleted by the cutover.
- **STRIDE inventory** (Spoofing / Tampering / Repudiation / Information disclosure / DoS / Elevation of privilege): largely current. Vectors with "enforce-mode rollout MUST NOT happen until..." gating language describe a deleted phase; treat as "before production deploy" instead.
- **Attack vectors discovered in audit** (W4-applied mitigations): historical record of which W4 P0 fixes addressed which audit findings.
- **Residual risks** (the "we know but can't close today" list): still mostly valid. Items #1 (NATS auth — P0-12), #4 (Postgres `ON CONFLICT` — P0-14), #5 (audit redactor `auditHash`), and #6-8 should be cross-checked against current state.
- **Review process**: still applies — annual May review, triggered review on P0/new-Pack/auth-flow changes.

## Localized stale references to flag for future-fix

- **Companion-docs header**: links to `../superseded/SHADOW-ENFORCE-ROLLOUT.md` — that file was intentionally archived. The link still resolves (the file exists in `../superseded/`) but the doc is no longer a live runbook.
- **Asset `IBX_KERNEL_ENFORCE` (line 33)**: this env var was deleted by the cutover. The "tampering disables enforcement" risk no longer applies in this shape.
- **Trust boundary 4 (line 68)**: same — `IBX_KERNEL_ENFORCE` no longer gates kernel config.
- **STRIDE "enforce-mode rollout MUST NOT happen until..." gating references** throughout the matrix: read as "before production deploy" guidance.
- **NATS auth P0-12**: status is "DEFERRED — operator action" and references `remediation/NATS-AUTH-REQUIREMENTS.md`. The operator action is still required (see `../remediation/README.md` for the partially-superseded classification). Substance unchanged; gate-framing slightly stale.

## Current-state pointers

- **Constitutional rule:** `CLAUDE.md` rule #9 — "LLM Authority — IBX Intent-Gated Execution v3.0"
- **Always-on cutover commit:** `f3bea43` (deleted `IBX_KERNEL_ENFORCE`)
- **Closeout status:** [`../audit-2026-05-24/CLOSEOUT-STATUS.md`](../audit-2026-05-24/CLOSEOUT-STATUS.md)
- **NATS auth operator runbook (still actionable):** [`../remediation/NATS-AUTH-REQUIREMENTS.md`](../remediation/NATS-AUTH-REQUIREMENTS.md)
- **Trust-boundary design doc (companion):** [`../governance/03-trust-boundary-model.md`](../governance/03-trust-boundary-model.md)
- **Security red-team source:** [`../audit/05-security-red-team.md`](../audit/05-security-red-team.md)
