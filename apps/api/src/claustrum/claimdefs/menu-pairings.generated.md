# Claim type: MENU_PAIRINGS@1

> GENERATED from the ClaimDefinition source by `claimdef-compiler`. Do not hand-edit.

- **kind**: `read_claim`
- **min source integrity**: `structured`
- **triad-scoped**: no
- **required evidence**: `menu:pairings`
- **falsifiers**: `menu:pairings_changed`
- **value binding (C6)**: `menu:pairings` path `suggestionsText`
- **render (validated)**: **{suggestionsText}** + `. Quer que eu adicione algum ao pedido?`
- **decomposition**: span `PAIRING_Q` → requires `MENU_PAIRINGS`, `MENU_SUBSTITUTIONS`
