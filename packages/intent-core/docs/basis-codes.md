# BASIS_CODES — vocabulary governance

`DecisionBasis` is vocabulary-controlled by construction. Every basis emitted at
runtime must carry a `category` from the closed `BasisCategory` union and a
`code` drawn from the per-category `BASIS_CODES` constant. This prevents
semantic drift (`"scope_ok"` vs `"scope_sufficient"` vs `"scope-valid"`) across
audit records.

## Built-in categories

| category | purpose |
|---|---|
| `state` | State-machine transition legality |
| `auth` | Caller identity and scope |
| `taint` | Provenance trust check |
| `ledger` | Replay and resource-version checks |
| `schema` | Envelope version and payload shape |
| `business` | Domain rule (satisfied / violated / capped) |
| `validation` | Pre-commit content checks (forbidden phrases, normalization) |

## Using `basis()`

Always prefer the `basis()` helper over raw object literals. It gives you
compile-time enforcement that the `code` belongs to the chosen `category`.

```ts
import { basis, BASIS_CODES } from "@ibx/intent-core";

// Compile-safe — code is narrowed to the category's known values.
const b = basis("auth", BASIS_CODES.auth.SCOPE_SUFFICIENT);

// Compile error — BASIS_CODES.state.TRANSITION_VALID is not an auth code.
const bad = basis("auth", BASIS_CODES.state.TRANSITION_VALID);
```

## Extending the vocabulary — module augmentation

Adopters with domain-specific decision bases extend the types via TypeScript
module augmentation, not free-form strings. Create a `basis-codes-ext.ts` in
your adopter package:

```ts
// In @my-domain/intent-codes
import "@ibx/intent-core";

declare module "@ibx/intent-core" {
  interface BasisCodesMap {
    business: BasisCodesMap["business"] & {
      INVENTORY_RESERVED: "inventory_reserved";
      LOYALTY_APPLIED:    "loyalty_applied";
    };
  }
}
```

Then, at a single site in the adopter, freeze the codes:

```ts
export const BUSINESS_CODES_EXT = {
  INVENTORY_RESERVED: "inventory_reserved",
  LOYALTY_APPLIED:    "loyalty_applied",
} as const;
```

This keeps the runtime source-of-truth for vocabulary single-sourced per
category even after augmentation.

## What NOT to do

- **Do not** emit `basis.code` as a dynamically-constructed string. The
  "basis vocabulary purity" invariant test fails loudly if a runtime code does
  not belong to `BASIS_CODES[category]`.
- **Do not** add a new `category` via augmentation. The `BasisCategory` union
  is closed in `@ibx/intent-core`; extending it would break exhaustive matching
  in the kernel and in audit sinks.
- **Do not** place business codes under `validation` or vice versa. Category
  meaning is part of the audit contract.
