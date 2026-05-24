# Stage 5 — `@adjudicate/pack-payments-pix` Intent Kinds (Risk: Critical)

> **TL;DR** — rollout playbook for the three Pack-canonical PIX intent kinds (`pix.charge.create`, `pix.charge.confirm`, `pix.charge.refund`). The Pack ships from the platform repo: [BrunoRodolpho/adjudicate](https://github.com/BrunoRodolpho/adjudicate/tree/main/packages/pack-payments-pix). IbateXas consumes it via cross-repo workspace include (see ADR #13 Phase 2 follow-up); when npm publication lands, swap to registry deps. IbateXas's existing `order.confirm`-via-`createPixPendingDeferGuard` adapter path was migrated under [ADR #13](../../architecture/decisions.md#13-pix-pack-extraction--adjudicatepack-payments-pix) and is already covered by Stage 4. This runbook covers the *direct-Pack-intent* path, which IbateXas adopts when an upstream actor (typically the Stripe webhook signing adapter) starts emitting `pix.charge.confirm` envelopes natively rather than going through `order.confirm`.

## Scope

| Intent kind | Pack default Decision | Notes |
|---|---|---|
| `pix.charge.create` | EXECUTE (after taint, validation, rate-limit, REWRITE-clamp) | LLM-proposable; UNTRUSTED OK |
| `pix.charge.confirm` | DEFER on pending → EXECUTE on settled (or REFUSE-already-captured / ESCALATE-failed) | TRUSTED only — webhook-emitted |
| `pix.charge.refund` | EXECUTE (or REQUEST_CONFIRMATION ≥ R$500, REFUSE on overspend / pre-capture) | TRUSTED only — staff or webhook |

The Pack's PolicyBundle covers all six kernel Decision outcomes; coverage is exercised in the platform-side tests at [`@adjudicate/pack-payments-pix/tests/`](https://github.com/BrunoRodolpho/adjudicate/tree/main/packages/pack-payments-pix/tests) (`six-outcomes.test.ts` for the canonical-intent path, `adopter-guard.test.ts` for the factory-composition path, `defer-round-trip.test.ts` for the integration with `@adjudicate/runtime`'s `resumeDeferredIntent`). Total: 28 passing tests as of pack v0.2.0-experimental.

## Relationship to Stage 4

Stage 4 enforces `order.confirm` with the Pack's *DEFER guard factory* composed into `orderPolicyBundle`. This is the IbateXas-style indirect adoption.

Stage 5 is for the future moment a webhook adapter is rewritten to publish the Pack's canonical `pix.charge.confirm` envelope directly. Until then, Stage 5 stays in plan; do not enable shadow until pre-flight is complete.

## Pre-flight checklist

- [ ] **Stage 4 enforced ≥14d** with zero `DECISION_KIND` divergences for `order.confirm` (the indirect-Pack path must be stable before flipping the direct-Pack path on)
- [ ] **Pack version pinned** in `packages/llm-provider/package.json` and `apps/api/package.json`. During the cross-repo workspace include period, ensure the platform repo is checked out at a known SHA before the rollout window. Once npm publication lands, pin to `^0.x.y-experimental` from the registry and drop the `pnpm-workspace.yaml` cross-repo include.
- [ ] **Pack tests green on the deployed SHA:** `pnpm --filter @adjudicate/pack-payments-pix test` shows 28 passing tests
- [ ] **DEFER round-trip integration test green:** `defer-round-trip.test.ts` passes against the actual Redis instance the on-call sees
- [ ] **PSP webhook adapter** updated to:
  - Verify provider signature
  - Build `IntentEnvelope<"pix.charge.confirm", PixChargeConfirmPayload>` with `taint: "TRUSTED"`
  - Call `adjudicate(envelope, state, pixPaymentsPack.policyBundle)` directly (in addition to the legacy `payment.status_changed` NATS publish, which Stage 4 still depends on)
- [ ] **Audit trail diff:** confirm Postgres `intent_audit` rows for `pix.charge.confirm` carry the Pack's `metadata.name = "@adjudicate/pack-payments-pix"` tag (proxy: `intent_kind LIKE 'pix.charge.%'` rows present and balanced against Stripe webhook deliveries)
- [ ] **Replay harness clean:** `npx ibx kernel replay --intent-kind pix.charge.create --since 7d` reports zero new divergences
- [ ] **Two-person on-call** for the 14-day shadow window
- [ ] **Customer-comms** templates already approved (Stage 4 covers the wording; no new copy needed for Stage 5)

## Shadow flip

```bash
# Enable Pack-canonical intent kinds in shadow mode
IBX_KERNEL_SHADOW=order.confirm,order.cancel,order.amend,payment.regenerate_pix,payment.set_pix_details,pix.charge.create,pix.charge.confirm,pix.charge.refund
IBX_LEDGER_ENABLED=true
IBX_LEDGER_ENFORCE=false
IBX_LEDGER_FAIL_OPEN=true
ibx svc restart api
```

If `IBX_KERNEL_SHADOW=*` is in effect, the new intent kinds are already shadowed once the webhook adapter starts emitting them.

**Smoke test (30 min):**

1. **PIX charge create** — start a checkout, observe a `pix.charge.create` envelope adjudicated with EXECUTE (or REWRITE if `expiresInSeconds` was out of policy).
2. **PIX charge confirm via DEFER** — wait for the QR scan; verify webhook arrives, builds a `pix.charge.confirm` envelope, kernel returns DEFER on `payment.confirmed`, parked. Then verify the *same* webhook (re-delivered for at-least-once) is suppressed via the SET-NX ledger key (`defer:resumed:<hash>`).
3. **PIX charge confirm direct** — second webhook delivery for the same charge after settlement should now produce REFUSE (`pix.charge.already_captured`) rather than DEFER, and the audit record should carry the `state.terminal_state` basis.
4. **PIX charge refund — small** — issue a R$25.00 refund, observe EXECUTE.
5. **PIX charge refund — high-value** — issue a R$500.00+ refund, observe REQUEST_CONFIRMATION; re-emit with operator confirmation, observe EXECUTE.
6. **Refund overspend** — attempt to refund more than `amountCentavos - refundedAmountCentavos`, observe REFUSE (`pix.charge.refund_exceeds_capture`).

## Observation window — 14 days

Watch:

| Metric | Threshold |
|---|---|
| `kernel_decision_total{kind="pix.charge.confirm",decision="DEFER"}` | non-zero, balanced against EXECUTE count within 30s of webhook delivery |
| `kernel_decision_total{kind="pix.charge.confirm",decision="REFUSE"}` | replays only — should equal duplicate-webhook count from PSP |
| `kernel_refusal_total{basis="pix.charge.already_captured"}` | matches PSP at-least-once retry rate |
| `kernel_decision_total{kind="pix.charge.refund",decision="REQUEST_CONFIRMATION"}` | matches refund volume ≥ R$500 |
| `kernel_defer_resume_duration_seconds` | p99 < 5s for `pix.charge.confirm` |
| `ledger_hit_ratio{kind="pix.charge.confirm"}` | matches PSP duplicate delivery rate |
| `kernel_shadow_divergence_total` | 0 across all `pix.charge.*` |

Daily check: replay last 24h via `ibx kernel replay --intent-kind 'pix.charge.*' --since 24h` and confirm zero divergences against the live Pack.

Any divergence is a **rollback trigger**: revert to `IBX_KERNEL_SHADOW` minus the `pix.charge.*` kinds (Stage 4 indirect path remains enforced; only the direct Pack adoption rolls back).

## Enforce flip

After 14 contiguous days of zero divergence:

```bash
IBX_KERNEL_ENFORCE=order.confirm,order.cancel,order.amend,payment.regenerate_pix,payment.set_pix_details,pix.charge.create,pix.charge.confirm,pix.charge.refund
ibx svc restart api
```

The kernel is now authoritative for both the indirect (`order.confirm`) and direct (`pix.charge.*`) PIX adjudication paths. The PSP webhook adapter can stop publishing the legacy `payment.status_changed` NATS event in a follow-up release once the indirect path's audit records have aged out of the active replay window (typically 30 days).

## Rollback

| Symptom | Action |
|---|---|
| Single `pix.charge.confirm` REFUSE that should have EXECUTE'd | Pull intent envelope + state from `intent_audit`. If divergence is a Pack policy bug, file a `@adjudicate/pack-payments-pix` issue and roll back enforce for `pix.charge.confirm` only. |
| Refund `REQUEST_CONFIRMATION` storm | Threshold misconfigured. Either lower `PIX_REFUND_CONFIRMATION_THRESHOLD_CENTAVOS` in a future Pack version or compose a stricter pre-bundle guard in IbateXas. Do not silently rollback Stage 5 — the prompt is fail-safe behavior. |
| `defer-resolver` stops resuming | Stripe webhook integration regression OR PSP outage. Check `payment.status_changed` NATS subject lag. The Pack's resume path is unchanged from Stage 4. |
| Postgres audit lag > 30s | Postgres write-amp. Add a partition or scale storage. Don't disable the sink — that breaks the kernel's audit invariant. |

## Post-stage report

After 14 days enforced clean:

- File `docs/ops/postmortems/stage-5-pix-charge-pack-rollout.md` with:
  - Total intent volume per kind
  - REFUSE/REWRITE rates and root causes
  - Any ESCALATE events and their resolution
  - Pack version migration path (cross-repo workspace include → pinned npm `^0.x.y-experimental`)
- File a Pack-side issue for any friction noted during the rollout (the Pack API will continue to evolve through Phase 3 of the platform roadmap; your friction is the data).
