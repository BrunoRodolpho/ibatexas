# Claim type: PAYMENT_STATUS@1

> GENERATED from the ClaimDefinition source by `claimdef-compiler`. Do not hand-edit.

- **kind**: `read_claim`
- **min source integrity**: `first_party_verified`
- **triad-scoped**: yes
- **required evidence**: `payment_status`
- **falsifiers**: `payment_refund`, `payment_chargeback`
- **value binding (C6)**: `payment_status` path `status`
- **render (validated)**: `O status do seu pagamento é: ` + **{status}** + `.`
- **decomposition**: span `PAYMENT_STATUS_Q` → requires `PAYMENT_STATUS`
- **per-resource key**: yes — the keys above are UNSUFFIXED BASES. `selectCandidateClaim` → `parameterizeKeysBySubject` suffixes every evidence, falsifier and value-binding key with `:{subject}` at select time, matching the investigator's per-resource ledger entries.
