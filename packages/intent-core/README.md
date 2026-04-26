# @adjudicate/intent-core

Pure types + lattice algebra + code constants for IBX Intent-Gated Execution.

Zero runtime dependencies beyond `zod` (peer-optional for adopter schemas).
Everything below is data and small pure functions — no I/O, no XState, no LLM.

## What lives here

- `IntentEnvelope<K, P>` — the canonical mutation proposal
- `Decision` — the 6-valued kernel output (`EXECUTE | REFUSE | ESCALATE | REQUEST_CONFIRMATION | DEFER | REWRITE`)
- `Taint` lattice — `SYSTEM > TRUSTED > UNTRUSTED` with `mergeTaint` + `canPropose`
- `Refusal` — stratified (`SECURITY | BUSINESS_RULE | AUTH | STATE`)
- `AuditRecord` — the durable governance trail entry
- `BASIS_CODES` — vocabulary-controlled decision basis codes
- `buildEnvelope`, `buildAuditRecord`, `sha256Canonical`, `canonicalJson`

## Load-bearing invariants (verified by property tests)

- **Taint monotonicity** — `mergeTaint` never raises trust
- **Hash determinism** — same envelope produces the same `intentHash` regardless
  of payload key order
- **Schema version gate** — envelopes with unknown `version` are never executable
- **Basis vocabulary purity** — every `basis.code` is in `BASIS_CODES[category]`

## Getting started

```ts
import {
  basis,
  BASIS_CODES,
  buildEnvelope,
  decisionExecute,
} from "@adjudicate/intent-core";

const envelope = buildEnvelope({
  kind: "order.tool.propose",
  payload: { toolName: "add_item", input: { sku: "X", qty: 1 } },
  actor: { principal: "llm", sessionId: "s-1" },
  taint: "UNTRUSTED",
});

const decision = decisionExecute([
  basis("state", BASIS_CODES.state.TRANSITION_VALID),
]);
```

## Further reading

- [`docs/taint.md`](./docs/taint.md) — v1.0 payload-level model + v1.1 field-level migration path
- [`docs/basis-codes.md`](./docs/basis-codes.md) — vocabulary governance + module augmentation
- [`examples/decision-algebra.ts`](./examples/decision-algebra.ts) — all 6 Decision kinds with real payloads
