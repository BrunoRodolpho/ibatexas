# Claim type: CART_CONTENTS@1

> GENERATED from the ClaimDefinition source by `claimdef-compiler`. Do not hand-edit.

- **kind**: `read_claim`
- **min source integrity**: `structured`
- **triad-scoped**: yes
- **required evidence**: `cart_contents`
- **falsifiers**: `cart_cleared`
- **value binding (C6)**: `cart_contents` path `itemsSummaryText`
- **render (validated)**: `No seu carrinho: ` + **{itemsSummaryText}** + `.`
- **decomposition**: span `CART_CONTENTS_Q` → requires `CART_CONTENTS`, `CART_EMPTY`
- **per-resource key**: yes — the keys above are UNSUFFIXED BASES. `selectCandidateClaim` → `parameterizeKeysBySubject` suffixes every evidence, falsifier and value-binding key with `:{subject}` at select time, matching the investigator's per-resource ledger entries.
