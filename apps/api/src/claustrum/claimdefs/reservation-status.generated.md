# Claim type: RESERVATION_STATUS@1

> GENERATED from the ClaimDefinition source by `claimdef-compiler`. Do not hand-edit.

- **kind**: `read_claim`
- **min source integrity**: `structured`
- **triad-scoped**: yes
- **required evidence**: `reservation_status`
- **falsifiers**: `reservation_cancelled`
- **value binding (C6)**: `reservation_status` path `statusLine`
- **render (validated)**: `O status da sua reserva é: ` + **{statusLine}** + `.`
- **decomposition**: span `RESERVATION_STATUS_Q` → requires `RESERVATION_STATUS`
- **per-resource key**: yes — the keys above are UNSUFFIXED BASES. `selectCandidateClaim` → `parameterizeKeysBySubject` suffixes every evidence, falsifier and value-binding key with `:{subject}` at select time, matching the investigator's per-resource ledger entries.
