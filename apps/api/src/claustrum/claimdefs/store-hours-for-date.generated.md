# Claim type: STORE_HOURS_FOR_DATE@1

> GENERATED from the ClaimDefinition source by `claimdef-compiler`. Do not hand-edit.

- **kind**: `read_claim`
- **min source integrity**: `trusted_service`
- **triad-scoped**: no
- **required evidence**: `schedule:store_hours`
- **falsifiers**: `schedule:schedule_override`, `schedule:holiday`
- **value binding (C6)**: `schedule:store_hours` path `hoursText`
- **render (validated)**: `Nesse dia, nosso horário de funcionamento é: ` + **{hoursText}** + `.`
- **decomposition**: span `STORE_HOURS_FOR_DATE_Q` → requires `STORE_HOURS_FOR_DATE`
- **per-resource key**: yes — the keys above are UNSUFFIXED BASES. `selectCandidateClaim` → `parameterizeKeysBySubject` suffixes every evidence, falsifier and value-binding key with `:{subject}` at select time, matching the investigator's per-resource ledger entries.
