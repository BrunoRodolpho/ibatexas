# Claim type: MENU_ITEM_PRICE@1

> GENERATED from the ClaimDefinition source by `claimdef-compiler`. Do not hand-edit.

- **kind**: `read_claim`
- **min source integrity**: `structured`
- **triad-scoped**: no
- **required evidence**: `menu:item_price`
- **falsifiers**: `menu:item_unpublished`
- **value binding (C6)**: `menu:item_price` path `priceText`
- **render (validated)**: **{priceText}** + `.`
- **decomposition**: span `MENU_ITEM_PRICE_Q` → requires `MENU_ITEM_PRICE`
- **per-resource key**: yes — the keys above are UNSUFFIXED BASES. `selectCandidateClaim` → `parameterizeKeysBySubject` suffixes every evidence, falsifier and value-binding key with `:{subject}` at select time, matching the investigator's per-resource ledger entries.
