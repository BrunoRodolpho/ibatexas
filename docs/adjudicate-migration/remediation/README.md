# `remediation/` — Wave 1-6 pre-cutover remediation (2026-05-23)

## What's in this directory

Four documents tracking the W1-W6 remediation work that followed the
2026-05-23 audit (see `../audit/`). Two are wave-state ledgers
(`REMEDIATION-COMPLETE.md`, `REMEDIATION-STATE.md`); one is a
W3-specific intent-kind gap tracker; one is an operator-action runbook
(`NATS-AUTH-REQUIREMENTS.md`) whose operational steps remain valid even
though the gating language it uses ("before flipping `IBX_KERNEL_ENFORCE`")
references a deleted framework.

The "shadow → enforce" framework these documents assume was deleted by
the IBX-IGE v3.0 cutover (`f3bea43`). Per `CLAUDE.md` rule #9, the
kernel is now always authoritative.

## Classification

| File | Classification | One-line summary |
|---|---|---|
| `REMEDIATION-STATE.md` | Historical preserved | W1-W6 wave plan + P0/P1/P2 ledger; superseded by W7-W9 work in `../correctness-remediation/` and by `../audit-2026-05-24/CLOSEOUT-STATUS.md`. |
| `REMEDIATION-COMPLETE.md` | Historical preserved | Final W6 closure report ("Cleared for Tier 1+2 shadow rollout"). The "shadow rollout" framing is from before the always-on cutover deleted that machinery. |
| `W3-INTENT-GAPS.md` | Historical preserved | W3 input-list for W5 `@ibatexas/pack-payments` migration. Intent kinds have since been reconciled with `../governance/01-intent-taxonomy.md`. |
| `NATS-AUTH-REQUIREMENTS.md` | Historical preserved (operator guidance still actionable) | P0-12 operator-action runbook. The NATS auth/TLS provisioning steps (`nsc` workflow, `.creds`/nkey/TLS env vars) remain valid for production hardening. The "before flipping `IBX_KERNEL_ENFORCE`" gating language is stale — the kernel is now always-on (`CLAUDE.md` rule #9), so the operator action is "before production deploy" rather than "before enforcement flip." |

## Notes on `NATS-AUTH-REQUIREMENTS.md`

This doc is the only one in the directory with content still likely to
be acted on. The env vars it describes (`NATS_URL`, `NATS_CREDS_PATH`,
`NATS_NKEY_SEED`, `NATS_TLS_CA`, `NATS_TLS_REQUIRED`) are still
consumed by `packages/nats-client/src/index.ts`. The `[nats][SECURITY]`
production-warning startup gate it references is still wired. Operators
deploying NATS to production should follow this runbook even though the
"flip enforce" surface no longer exists.

## Current-state pointers

- **Closeout status (authoritative as of 2026-05-24):** [`../audit-2026-05-24/CLOSEOUT-STATUS.md`](../audit-2026-05-24/CLOSEOUT-STATUS.md)
- **Constitutional rule:** `CLAUDE.md` rule #9 — "LLM Authority — IBX Intent-Gated Execution v3.0"
- **Always-on cutover commit:** `f3bea43` (deleted shadow/enforce framework these docs assume)
- **Continuation of remediation:** [`../correctness-remediation/`](../correctness-remediation/) (Waves 7-9)
- **NATS client code:** `packages/nats-client/src/index.ts` (still consumes the env vars in NATS-AUTH-REQUIREMENTS.md)
