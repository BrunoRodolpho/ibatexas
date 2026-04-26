# @adjudicate/intent-kernel

The pure deterministic `adjudicate()` function + policy combinators.

## `adjudicate(envelope, state, policy) → Decision`

Runs guards in strict category order — `state → auth → taint → business` —
short-circuits on the first non-null Decision, collects `DecisionBasis[]` from
passing guards, falls back to `policy.default`.

**No LLM calls inside.** Same inputs always produce the same output — the
replay harness in `@adjudicate/intent-audit` depends on this.

## `REWRITE` scope — bounded by design

`REWRITE { rewritten, reason, basis }` is the kernel's way of saying "the
proposed envelope was unsafe as-is but I substituted a safe equivalent."
It is **restricted** to three categories — never business transformation:

| Allowed | Forbidden |
|---|---|
| **Sanitization** — redact UNTRUSTED content from a field requiring TRUSTED | "user asked for card, we default to PIX" |
| **Normalization** — unicode NFC, whitespace collapse, homoglyph mapping | "quantity 5 is unusual, let's make it 1" |
| **Safe mechanical capping** — `quantity > catalog_max → clamp`, emitting `BASIS_CODES.business.QUANTITY_CAPPED` | anything the user could not have anticipated |

Anything that changes the user's intended outcome must be `REFUSE` or
`REQUEST_CONFIRMATION`. Enforced by the invariant property test
"REWRITE stays in scope" in `@adjudicate/intent-core/tests/invariants/`.

## `PolicyBundle`

```ts
interface PolicyBundle<K, P, S> {
  stateGuards: Guard[];
  authGuards: Guard[];
  taint: TaintPolicy;
  business: Guard[];
  default: "REFUSE" | "EXECUTE";
}
```

Guards return `Decision | null`. `null` means "no opinion; continue." The
first non-null wins. **Default to `"REFUSE"`** — fail-safe, refusal-by-design.

## Combinators

```ts
import { allOf, firstMatch, constant } from "@adjudicate/intent-kernel";

const guard = allOf(requireAuth, requireCart, requireSlotsFilled);
const always = constant(decisionRefuse(refuse("STATE", "x", "y"), []));
```

## Extending `BASIS_CODES`

Adopters with domain-specific decision bases extend via TypeScript module
augmentation — never free-form strings. See
[`@adjudicate/intent-core/docs/basis-codes.md`](../intent-core/docs/basis-codes.md).
