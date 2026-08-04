# Claim type: MENU_DIETARY@1

> GENERATED from the ClaimDefinition source by `claimdef-compiler`. Do not hand-edit.

- **kind**: `read_claim`
- **min source integrity**: `structured`
- **triad-scoped**: no
- **required evidence**: `menu:dietary`
- **falsifiers**: `menu:item_unpublished`
- **value binding (C6)**: `menu:dietary` path `dietaryText`
- **render (validated)**: **{dietaryText}**
- **decomposition**: span `MENU_DIETARY_Q` → requires `MENU_DIETARY`
- **per-resource key**: yes — the keys above are UNSUFFIXED BASES. `selectCandidateClaim` → `parameterizeKeysBySubject` suffixes every evidence, falsifier and value-binding key with `:{subject}` at select time, matching the investigator's per-resource ledger entries.
