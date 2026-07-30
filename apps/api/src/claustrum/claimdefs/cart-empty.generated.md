# Claim type: CART_EMPTY@1

> GENERATED from the ClaimDefinition source by `claimdef-compiler`. Do not hand-edit.

- **kind**: `read_claim`
- **min source integrity**: `structured`
- **triad-scoped**: yes
- **required evidence**: `cart_empty`
- **falsifiers**: `cart_item_added`
- **value binding (C6)**: `cart_empty` path `emptinessText`
- **render (validated)**: `Seu carrinho está ` + **{emptinessText}** + ` no momento — quer dar uma olhada no cardápio?`
- **decomposition**: _(no decomposition)_
- **per-resource key**: yes — the keys above are UNSUFFIXED BASES. `selectCandidateClaim` → `parameterizeKeysBySubject` suffixes every evidence, falsifier and value-binding key with `:{subject}` at select time, matching the investigator's per-resource ledger entries.
