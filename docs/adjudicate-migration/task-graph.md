> ⚠️ **SUPERSEDED on 2026-05-24.** This is the pre-cutover M0-M6 task ledger. Both the milestones it tracks (M0-M6) and the post-M6 W1-W9 correctness-remediation waves have all landed. The IBX-IGE v3.0 always-on cutover (`f3bea43`) made the staged-rollout framework these tasks supported obsolete. For current outstanding work, see [`audit-2026-05-24/CLOSEOUT-STATUS.md`](./audit-2026-05-24/CLOSEOUT-STATUS.md). For historical record of which tasks landed in which commit, the content below is preserved unchanged.

---

# Task Completion Graph

Per-task ID completion record. Updated as each task lands.

| ID | Branch | Commit | Tests | Notes |
|---|---|---|---|---|
| 01 | feat/adjudicate-m0-task01-kernel-bootstrap | e1ee89b → 351d15a (merge) | clean | bootstrap plugin, env vars |
| 02 | feat/adjudicate-m0-task02-on-tool-intent | b205886 → 7dacb72 (merge) | 100 pass, 2 pre-existing fail | intent dispatcher, 17 tests |
| 03 | feat/adjudicate-m0-task03-defer-resolver | 453bb13 → 295d12e (merge) | 659 pass | resume + sweeper, 17 tests |
| 04 | feat/adjudicate-m0-task04-set-pix-details | d6dbd08 → e7f43af (merge) | 6 pass | reclassify READ_ONLY |
| 05 | feat/adjudicate-m0-task05-metrics-sink | 9b7a5fd → 28c94c1 (merge) | 671 pass | PostHog/Sentry/Prometheus |
| 08 | feat/adjudicate-m2-task08-pack-orders | 9f4ff29 → 9d4a4ad (merge) | 72 pass | lighthouse Pack, 33-fixture corpus |
