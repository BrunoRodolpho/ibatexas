# @adjudicate/core

The framework's load-bearing primitives — types, lattice algebra, the
deterministic kernel, and the LLM-side capability/tool surface, all in one
package with subpath-export-based separation.

## Imports

```ts
// Headline surface — types you'll use everywhere
import {
  buildEnvelope,
  type IntentEnvelope,
  type Decision,
  type Refusal,
  type AuditRecord,
} from "@adjudicate/core";

// Kernel — the deterministic adjudicator + policy contracts
import {
  adjudicate,
  type PolicyBundle,
  type Guard,
  allOf,
  firstMatch,
} from "@adjudicate/core/kernel";

// LLM-side — what the model can see and how the prompt is rendered
import {
  type CapabilityPlanner,
  type ToolClassification,
  filterReadOnly,
} from "@adjudicate/core/llm";
```

## What lives here

**Top-level (`@adjudicate/core`)**
- `IntentEnvelope<K, P>` — the canonical mutation proposal with versioned
  schema, content-addressed `intentHash`, taint provenance.
- `Decision` — the 6-valued kernel output:
  `EXECUTE | REFUSE | ESCALATE | REQUEST_CONFIRMATION | DEFER | REWRITE`.
- `Refusal` — stratified user-facing message
  (`SECURITY | BUSINESS_RULE | AUTH | STATE`).
- `AuditRecord` — durable governance trail entry.
- `BASIS_CODES` — vocabulary-controlled decision basis codes.
- `Taint` lattice — `SYSTEM > TRUSTED > UNTRUSTED` with `mergeTaint` /
  `canPropose` / field-level `TaintedValue<T>`.
- `buildEnvelope`, `buildAuditRecord`, `sha256Canonical`, `canonicalJson`.

**`@adjudicate/core/kernel`**
- `adjudicate(envelope, state, policy) → Decision` — pure deterministic.
- `PolicyBundle<K, P, S>`, `Guard<K, P, S>`, combinators (`allOf`,
  `firstMatch`, `constant`).
- Shadow-mode infrastructure (`adjudicateWithShadow`, divergence
  classification) for staged rollout from a legacy decision path.
- `MetricsSink` contract + recorders for ledger / decisions / refusals /
  sink failures.
- Per-intent enforcement config (`IBX_KERNEL_SHADOW`, `IBX_KERNEL_ENFORCE`)
  for the 4-stage runbook.

**`@adjudicate/core/llm`**
- `CapabilityPlanner<S, C>` — security-sensitive surface that decides
  which tools the LLM may see this turn. The planner makes the
  capability decision; the renderer is cosmetic.
- `PromptRenderer<S, C>` — consumes a `Plan` and produces text + tool
  schemas + max-tokens. No capability decisions.
- `ToolClassification` + `filterReadOnly` — type-level READ vs MUTATING
  separation that structurally hides mutating tools from the LLM.

## Load-bearing invariants

Verified by property tests in [`tests/kernel/invariants/`](./tests/kernel/invariants/):

- **Taint monotonicity** — `mergeTaint` never raises trust.
- **Hash determinism** — same envelope produces the same `intentHash`
  regardless of payload key order.
- **Schema version gate** — envelopes with unknown `version` are never
  executable (refused with a structured `SECURITY` refusal).
- **Basis vocabulary purity** — every `basis.code` is in
  `BASIS_CODES[category]`. No free-form strings.
- **UNTRUSTED never executes when policy demands TRUSTED+** — the kernel
  contract that makes the rest of the framework safe.

## REWRITE scope — bounded by design

`REWRITE { rewritten, reason, basis }` is the kernel's way of saying
"the proposed envelope was unsafe as-is but I substituted a safe
equivalent." It is **restricted** to three categories — never business
transformation:

| Allowed | Forbidden |
|---|---|
| **Sanitization** — redact UNTRUSTED content from a TRUSTED-required field | "user asked for card, default to PIX" |
| **Normalization** — unicode NFC, whitespace collapse, homoglyph mapping | "quantity 5 is unusual, make it 1" |
| **Safe mechanical capping** — `quantity > catalog_max → clamp` | anything the user could not anticipate |

Anything that changes the user's intended outcome must be `REFUSE` or
`REQUEST_CONFIRMATION`.

## Further reading

- [`docs/taint.md`](./docs/taint.md) — payload-level + field-level taint
- [`docs/basis-codes.md`](./docs/basis-codes.md) — vocabulary governance + module augmentation
- [`examples/decision-algebra.ts`](./examples/decision-algebra.ts) — all 6 Decision kinds with real payloads
