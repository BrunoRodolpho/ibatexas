# Claim type: COUPON_VALID@1

> GENERATED from the ClaimDefinition source by `claimdef-compiler`. Do not hand-edit.

- **kind**: `read_claim`
- **min source integrity**: `structured`
- **triad-scoped**: no
- **required evidence**: `coupon:valid`
- **falsifiers**: `coupon:promotions_changed`
- **value binding (C6)**: `coupon:valid` path `validityText`
- **render (validated)**: **{validityText}** + `. É só informar o código no checkout.`
- **decomposition**: span `COUPON_VALIDITY_Q` → requires `COUPON_VALID`, `COUPON_INVALID`
