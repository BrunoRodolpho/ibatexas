# Claim type: STORE_OPEN_NOW@1

> GENERATED from the ClaimDefinition source by `claimdef-compiler`. Do not hand-edit.

- **kind**: `read_claim`
- **min source integrity**: `trusted_service`
- **triad-scoped**: yes
- **required evidence**: `schedule:store_open_now`
- **falsifiers**: `schedule:schedule_override`
- **value binding (C6)**: `schedule:store_open_now` path `mealPeriod`
- **render (validated)**: `No momento, o período de funcionamento é: ` + **{mealPeriod}** + `.`
- **decomposition**: span `STORE_OPEN_NOW_Q` → requires `STORE_OPEN_NOW`
