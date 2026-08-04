# Claim type: PAYMENT_HISTORY@1

> GENERATED from the ClaimDefinition source by `claimdef-compiler`. Do not hand-edit.

- **kind**: `read_claim`
- **min source integrity**: `structured`
- **triad-scoped**: yes
- **required evidence**: `payment_history`
- **falsifiers**: `payment_history_changed`
- **value binding (C6)**: `payment_history` path `historySummaryText`
- **render (validated)**: `Seu histórico de pagamentos: ` + **{historySummaryText}** + `.`
- **decomposition**: span `PAYMENT_HISTORY_Q` → requires `PAYMENT_HISTORY`
- **per-resource key**: yes — the keys above are UNSUFFIXED BASES. `selectCandidateClaim` → `parameterizeKeysBySubject` suffixes every evidence, falsifier and value-binding key with `:{subject}` at select time, matching the investigator's per-resource ledger entries.
