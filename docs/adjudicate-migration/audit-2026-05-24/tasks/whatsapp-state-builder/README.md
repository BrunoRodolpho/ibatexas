# WhatsApp `lastCustomerMessageAt` state-builder — task DAG

**Wave:** post-design-doc decomposition
**Synthesizer:** orchestration kernel
**Design source:** [`docs/architecture/design/whatsapp-state-builder.md`](../../../../architecture/design/whatsapp-state-builder.md)
**Brief:** [`whatsapp-state-builder-design.md`](../whatsapp-state-builder-design.md)

---

## TL;DR

The WhatsApp `lastCustomerMessageAt` state-builder design landed at `0470f6d` recommending **Alternative B** (Postgres-backed materialized view via `Customer.lastCustomerMessageAt` column). The design surfaced **8 open questions** for stakeholder pick. Implementation is gated on those picks.

Decomposed into **14 atomic, parallel-safe tasks** across **3 waves**:

- **Wave 1 (foundation, 3 tasks):** Schema migration (WS-1) + state-builder helper (WS-3), running parallel; CDC writer (WS-2) sequenced after WS-1.
- **Wave 2 (9 site migrations, parallel-safe across sites; 3 share a hot file):** WS-4..12 in parallel where possible; WS-4/6/7 share `cart-intelligence.ts` and need coordination.
- **Wave 3 (closeout, 2 tasks):** Backfill posture (WS-13) and conformance test (WS-14), both independent and parallel.

**Total atomization:** 14 tasks (under the 15-task hard stop).

**No internal contradictions** in the design vs. the recommended alternative — Alternative B is internally consistent with all 8 open questions' recommended defaults.

**No bottlenecks** that force sequential execution within Wave 2 except the 3-site `cart-intelligence.ts` collision (WS-4, WS-6, WS-7) — addressed via documented merge sequencing.

---

## The 8 open questions (verbatim from design doc §"Open questions for stakeholder")

| # | Question | Recommended default | Status | Blocks which WS-N |
|---|---|---|---|---|
| 1 | **Join axis: `phoneHash` or `customerId`?** | `customerId` (matches alt B) | PENDING | WS-1, WS-2, WS-3, WS-4..12 (essentially all) |
| 2 | **Backfill or no?** | "Acceptable to skip; elevated REFUSE during ramp-up" | PENDING | WS-13 (load-bearing — task implementation IS the answer) |
| 3 | **Does `whatsapp-webhook.ts` agent reply migrate too?** | Defer | PENDING | WS-14 (only — affects the conformance allowlist) |
| 4 | **`proactive-engagement` and `reservation-reminder` → template-only?** | Yes | PENDING | WS-8, WS-11 (template-send routing) |
| 5 | **`handoff-subscriber` rate-limit projection (`perCustomerHandoffCount`) — split out?** | Yes — sister design | PENDING | WS-3 (stub allowed), WS-5 (rate-limit not enforced) |
| 6 | **Per-staff `lastCustomerMessageAt`?** | "Always customer; never staff" | PENDING | WS-3, WS-5 (handoff site relies on this clarification) |
| 7 | **Audit-sink coverage for the column UPDATE itself: implicit vs. explicit?** | Implicit | PENDING | WS-2 (writer behaviour depends on this) |
| 8 | **Future channel extension — generalize column shape now?** | "Keep specific; generalize later" | PENDING | WS-1 (schema shape) |

**Q1, Q2, Q4, Q5, Q6, Q7 each have at least one task that materially depends on the pick.** Q3 only narrows the conformance allowlist (WS-14). Q8 narrows the schema shape (WS-1) but the recommended default ("keep specific") is the simplest path.

**Closing all 8 questions with the recommended defaults unlocks the full DAG with no design rework.**

---

## Task DAG

```
                    Wave 1 (foundation)
                    
            ┌──────────────────────────┐
            │  WS-1                    │     ┌──────────────────────────┐
            │  Schema migration        │ ────│  WS-3                    │
            │  Customer column add     │     │  buildWhatsAppState()    │
            └──────────────────────────┘     │  helper module           │
                          │                  └──────────────────────────┘
                          │                              │
                          ▼                              │
            ┌──────────────────────────┐                 │
            │  WS-2                    │                 │
            │  CDC writer in archiver  │                 │
            └──────────────────────────┘                 │
                          │                              │
                          └──────────┬───────────────────┘
                                     │
                                     ▼
        ─────────────────────────  Wave 2 (9 sites, parallel where possible) ─────────────────────────
        
        ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐
        │  WS-4   │ │  WS-5   │ │  WS-6   │ │  WS-7   │ │  WS-8   │ │  WS-9   │ │  WS-10  │ │  WS-11  │ │  WS-12  │
        │ notif.  │ │ handoff │ │ tiers   │ │ review  │ │ proact. │ │ hesitat │ │ pix-exp │ │ reservn │ │ recovery│
        │ .send   │ │         │ │ (CIT)   │ │ (CIT)   │ │ engage  │ │ -nudge  │ │ monitor │ │ remind  │ │ msgs    │
        │ (CIT)   │ │         │ │         │ │         │ │ (tmpl)  │ │         │ │         │ │ (tmpl)  │ │         │
        └─────────┘ └─────────┘ └─────────┘ └─────────┘ └─────────┘ └─────────┘ └─────────┘ └─────────┘ └─────────┘
              │           │           │           │           │           │           │           │           │
              │     ┌─────┘           │           │           │           │           │           │           │
              │     │                 │           │           │           │           │           │           │
              │     │   (WS-4/6/7 share cart-intelligence.ts — sequence WS-4 → WS-6 → WS-7 in PRs)             │
              │     │                                                                                          │
              │     │                  ╔══════════════════════════════════════════════════════════════════════╝
              │     │                  ║   WS-12 depends on WS-4 (audits notification.send-inherited gating)
              │     │                  ║
              ▼     ▼                  ▼
        ───────────────────────────  Wave 3 (closeout) ───────────────────────────
        
        ┌──────────────────────────┐         ┌──────────────────────────┐
        │  WS-13                   │         │  WS-14                   │
        │  Backfill OR ramp-up doc │         │  Conformance test (T8)   │
        │  (only depends on WS-1,2)│         │  (depends on ALL WS-4..12)│
        └──────────────────────────┘         └──────────────────────────┘
```

**Legend:** CIT = `cart-intelligence.ts`. Template-routing sites (WS-8, WS-11) have a soft dependency on Twilio Content Template registration (out-of-DAG ops task) — code lands behind feature flag.

---

## Recommended dispatch sequencing

### Wave 1 — Foundation (parallel; ~1 day wall-clock)

Dispatch in parallel as a single batch:

| Task | Estimated complexity | Sub-agent prompt section |
|---|---|---|
| **WS-1** Schema migration | XS (~30 min) | [ws-1-schema-migration.md](./ws-1-schema-migration.md) §"Ready-to-spawn sub-agent prompt" |
| **WS-3** State-builder helper | S (~3-5h) | [ws-3-state-builder-helper.md](./ws-3-state-builder-helper.md) §"Ready-to-spawn sub-agent prompt" |

Once WS-1 lands, immediately dispatch:

| Task | Estimated complexity | Notes |
|---|---|---|
| **WS-2** CDC writer in conversation-archiver | S (~2-4h) | Strictly after WS-1 (compile-time dep). |

**Gate:** All 3 must land before Wave 2 starts.

### Wave 2 — 9 site migrations (parallel where possible; ~2-3 days wall-clock)

After Wave 1 lands, dispatch the 9 site migrations.

**Recommended dispatch ordering** (per the design's Phase-2 ordering by blast radius):

1. **WS-9** (hesitation-nudge) — first; lowest risk.
2. **WS-10** (pix-expiry-monitor) — second; always-inside-window.
3. **WS-7** (review.prompt) — third.
4. **WS-4** (notification.send) — fourth; biggest fan-in (cart-recovery, dispute alerts).
5. **WS-6** (cart.abandoned tier escalation) — fifth; depends on WS-4's handler.
6. **WS-11** (reservation-reminder) — sixth; template-send required.
7. **WS-8** (proactive-engagement) — seventh; template-send required, dormant customers.
8. **WS-12** (cart-recovery-messages) — eighth; depends on WS-4.
9. **WS-5** (handoff-subscriber) — ninth; lowest-frequency.

**Parallelism within Wave 2:**
- WS-9, WS-10, WS-11, WS-8, WS-5 are independent of each other — can be dispatched in parallel.
- WS-4, WS-6, WS-7 share `cart-intelligence.ts` — sequence sequentially OR coordinate on a single PR.
- WS-12 depends on WS-4 — dispatch after WS-4 merges.

**Recommended batches:**
- Batch 2a (parallel): WS-9, WS-10, WS-5.
- Batch 2b (sequential to handle file overlap): WS-4 → WS-6 → WS-7.
- Batch 2c (after WS-4 merges): WS-8, WS-11, WS-12 in parallel.

### Wave 3 — Closeout (parallel; ~0.5 day wall-clock)

After all Wave 2 sites are merged:

| Task | Estimated complexity | Notes |
|---|---|---|
| **WS-13** Backfill or ramp-up doc | M (backfill) or XS (deferral) | Depends only on WS-1, WS-2. |
| **WS-14** Conformance test | S (~3-5h) | Depends on ALL Wave 2 sites — must land last. |

**Total wall-clock estimate:** ~4-5 days end-to-end for a single sub-agent dispatching in sequence; ~2-3 days with parallel dispatch.

---

## Merge-conflict heatmap

| Task | Risk | Conflicts with |
|---|---|---|
| WS-1 | LOW | None (new column + new migration file). Watch for in-flight schema changes from other branches. |
| WS-2 | MEDIUM | Other CDC-touching tasks; H3 wave-a in-process anonymize (different fields, mechanical merge). |
| WS-3 | LOW | New module; no edits except `lib/metrics.ts` (trivial). |
| **WS-4** | **HIGH** | **WS-6, WS-7 (shared file `cart-intelligence.ts`); H3 wave-a.** |
| WS-5 | LOW | None. |
| **WS-6** | **HIGH** | **WS-4, WS-7 (shared file).** |
| **WS-7** | **HIGH** | **WS-4, WS-6 (shared file).** |
| WS-8 | LOW | Pack capabilities edits if `whatsapp.template.send` kind needs adding. |
| WS-9 | LOW | None. |
| WS-10 | LOW | None. |
| WS-11 | LOW | Reservation feature branches (if any). |
| WS-12 | LOW | None. |
| WS-13 | LOW | New CLI file or new runbook doc. |
| WS-14 | LOW | New test file. |

**Summary:** 3 HIGH (WS-4/6/7 — all share `cart-intelligence.ts`), 1 MEDIUM (WS-2 — touches a hot subscriber), 10 LOW.

**Mitigation for HIGH:** WS-4/6/7 sequence on the same PR-chain or in a single coordination branch with squash-merge.

---

## Cross-references

- [Design doc](../../../../architecture/design/whatsapp-state-builder.md) — the source of truth for Alternative B + the 8 open questions.
- [Original brief](../whatsapp-state-builder-design.md) — the task that produced the design doc.
- [Kernel-operations runbook](../../../../ops/runbooks/kernel-operations.md) — ops context for "every decision is audited" + always-on posture.
- [`buildSystemEnvelope()` reference](../../../../../apps/api/src/subscribers/__shared__/system-actor-envelope.ts) — the sibling helper the state-builder will live next to.
- [H3 SYNTHESIS](../h3-investigation/SYNTHESIS.md) — the template followed for this README's shape.

---

## Synthesis observations

Across the design's 14 task atomization:

- **Convergence:** Alternative B's recommendation is internally consistent. Every recommended default for the 8 open questions points toward the same DAG shape; no question's "alternative pick" forces a different decomposition (Q1 alt → reshape schema + writer; Q2 alt → add WS-13 backfill code; Q4 alt → drop template-send routing in WS-8/11; Q8 alt → reshape WS-1 column).
- **Bottlenecks:** No tight dependency chains. The deepest path is WS-1 → WS-2 → (any Wave 2 site) → WS-14 — a 4-step path with plenty of parallelism at each level except the last.
- **High-coupling file (`cart-intelligence.ts`):** Three sites overlap. Mitigation is explicit in this doc and in WS-4/6/7 individually.
- **Out-of-DAG ops dependency:** Twilio Content Template registration (for WS-8, WS-11) is not within this DAG. Mitigated by feature flags.
- **No hard stops triggered:** The design has no internal contradictions; the task count is 14 (under 15); every task is parallel-safe within the documented sequencing rules.

---

## Recommended next action

**Surface the 8 open questions to the stakeholder** with the recommended defaults pre-filled. Once picked (likely a single batch of "accept all defaults" or a small handful of overrides), the orchestrator dispatches Wave 1 in parallel and queues Wave 2.

If the stakeholder picks "no backfill" (Q2 default) and "no agent-reply migration" (Q3 default), the DAG runs to completion in ~4-5 days with no rework.
