# Claim type: ORDER_HISTORY@1

> GENERATED from the ClaimDefinition source by `claimdef-compiler`. Do not hand-edit.

- **kind**: `read_claim`
- **min source integrity**: `structured`
- **triad-scoped**: yes
- **required evidence**: `order_history`
- **falsifiers**: `order_history_changed`
- **value binding (C6)**: `order_history` path `historySummaryText`
- **render (validated)**: `Seu histórico de pedidos: ` + **{historySummaryText}** + `.`
- **decomposition**: span `ORDER_HISTORY_Q` → requires `ORDER_HISTORY`
- **per-resource key**: yes — the keys above are UNSUFFIXED BASES. `selectCandidateClaim` → `parameterizeKeysBySubject` suffixes every evidence, falsifier and value-binding key with `:{subject}` at select time, matching the investigator's per-resource ledger entries.
