# Claim type: DELIVERY_COVERAGE@1

> GENERATED from the ClaimDefinition source by `claimdef-compiler`. Do not hand-edit.

- **kind**: `read_claim`
- **min source integrity**: `structured`
- **triad-scoped**: no
- **required evidence**: `delivery:coverage`
- **falsifiers**: `delivery:zones_changed`
- **value binding (C6)**: `delivery:coverage` path `coverageText`
- **render (validated)**: **{coverageText}** + `. Confirmo certinho pelo endereço no checkout.`
- **decomposition**: span `DELIVERY_COVERAGE_Q` → requires `DELIVERY_COVERAGE`, `DELIVERY_NO_COVERAGE`
