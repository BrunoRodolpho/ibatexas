# Claim type: MENU_ITEM_CONTENTS@1

> GENERATED from the ClaimDefinition source by `claimdef-compiler`. Do not hand-edit.

- **kind**: `read_claim`
- **min source integrity**: `structured`
- **triad-scoped**: no
- **required evidence**: `menu:item_contents`
- **falsifiers**: `menu:item_unpublished`
- **value binding (C6)**: `menu:item_contents` path `contentsText`
- **render (validated)**: **{contentsText}** + `.`
- **decomposition**: span `MENU_ITEM_CONTENTS_Q` → requires `MENU_ITEM_CONTENTS`
- **per-resource key**: yes — the keys above are UNSUFFIXED BASES. `selectCandidateClaim` → `parameterizeKeysBySubject` suffixes every evidence, falsifier and value-binding key with `:{subject}` at select time, matching the investigator's per-resource ledger entries.
