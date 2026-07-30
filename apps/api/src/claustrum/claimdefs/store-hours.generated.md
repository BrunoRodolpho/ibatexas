# Claim type: STORE_HOURS@1

> GENERATED from the ClaimDefinition source by `claimdef-compiler`. Do not hand-edit.

- **kind**: `read_claim`
- **min source integrity**: `trusted_service`
- **triad-scoped**: no
- **required evidence**: `schedule:store_hours`
- **falsifiers**: `schedule:schedule_override`, `schedule:holiday`
- **value binding (C6)**: `schedule:store_hours` path `hoursText`
- **render (validated)**: `Hoje nosso horário de funcionamento é: ` + **{hoursText}** + `.`
- **decomposition**: _(no decomposition)_
