# WhatsApp `lastCustomerMessageAt` state-builder — design prerequisite

**Status:** 🚧 GATED on G5 design-session scheduling. Default recommendation: DEFER until after H2 lands.

---

## Objective

Produce a design doc for a `lastCustomerMessageAt` state-builder that unblocks ~7 deferred subscriber / job sites where WhatsApp-related envelopes are gated on knowing when the customer last interacted.

## Why this is gated

- The state-builder design will depend on the final wrapper-meta shape (settled by H2).
- The state-builder's audit-record obligations depend on the final `auditSink` injection pattern (also H2).
- Stacking the design before H2 risks rework.

## Sites unblocked once the state-builder ships

(Locate via `grep -rn "lastCustomerMessageAt\|TODO.*state-builder" packages/ apps/`.)
Anticipated sites per memory:
- `notification.send` flow (currently bypasses governance because the state input is absent)
- `handoff-subscriber`
- `cart-tier-escalation` (re-engagement messaging tier)
- 4+ additional subscriber/job sites cited in the earlier overnight summary

## Design-session deliverable (when scheduled)

A markdown design doc at `docs/architecture/design/whatsapp-state-builder.md` covering:
- The state-builder's read interface (what queries it serves)
- The state-builder's write surface (which events feed it)
- TTL / decay semantics for "recent customer interaction" lookups
- Audit-record obligations
- Test fixtures + conformance approach
- Rollout sequencing (does it block any of the 7 sites individually?)

Estimated design session: ~2-3h focused work. Implementation: ~1-2d after.

## Ready-to-spawn sub-agent prompt (DESIGN-ONLY — DO NOT IMPLEMENT)

> You are the WhatsApp state-builder design agent. Per `docs/adjudicate-migration/audit-2026-05-24/tasks/whatsapp-state-builder-design.md`. **DESIGN ONLY — produce a markdown design doc at `docs/architecture/design/whatsapp-state-builder.md`. Do NOT write production code; do NOT spawn an implementation sub-agent.** First: enumerate the 7+ deferred sites via grep; for each, document what state the site needs from the builder. Then: propose two design alternatives (e.g. Redis-backed projection vs. Postgres-backed materialized view), document trade-offs, and recommend one. Final section: explicit open questions for the user. Stop and report; the user gates implementation. Wall-clock budget: 2-3h.

## Risk classification

- **Blast radius:** zero (design phase)
- **Reversibility:** trivial
- **Replay impact:** the implementation impacts replay coverage for 7+ sites; design must call this out
