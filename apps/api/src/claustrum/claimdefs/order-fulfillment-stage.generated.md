# Claim type: ORDER_FULFILLMENT_STAGE@1

> GENERATED from the ClaimDefinition source by `claimdef-compiler`. Do not hand-edit.

- **kind**: `read_claim`
- **min source integrity**: `structured`
- **triad-scoped**: yes
- **required evidence**: `order_fulfillment_stage`
- **falsifiers**: `order_cancelled`
- **value binding (C6)**: `order_fulfillment_stage` path `fulfillmentStatus`
- **render (validated)**: `Seu pedido está na etapa: ` + **{fulfillmentStatus}** + `.`
- **decomposition**: span `ORDER_STATUS_Q` → requires `ORDER_FULFILLMENT_STAGE`
- **per-resource key**: yes — the keys above are UNSUFFIXED BASES. `selectCandidateClaim` → `parameterizeKeysBySubject` suffixes every evidence, falsifier and value-binding key with `:{subject}` at select time, matching the investigator's per-resource ledger entries.
