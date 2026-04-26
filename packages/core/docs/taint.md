# Taint — v1.0 model and field-level migration path

## v1.0: payload-level taint

The `IntentEnvelope` carries **one** `Taint` value — the worst-trust across all
provenance sources that contributed to the payload. Semantics:

- `SYSTEM` (rank 3) — from framework-controlled data (catalog, config, system tools)
- `TRUSTED` (rank 2) — from an authenticated actor or a system tool with integrity guarantees
- `UNTRUSTED` (rank 1) — any content derived from free-form user input

`mergeTaint(a, b)` returns the **meet** of the lattice: lowest trust wins,
always. A `PolicyBundle`'s `TaintPolicy.minimumFor(intentKind)` declares the
lowest trust level allowed to propose that intent. `canPropose(taint, kind,
policy)` gates.

## Known limitation — coarse in mixed-provenance payloads

Example:

```ts
payload: {
  catalogPrice:  8900,           // SYSTEM — from product catalog
  userNote:      "sem cebola",   // UNTRUSTED — from user message
}
```

Payload-level taint forces `envelope.taint = UNTRUSTED`, which may deny actions
that are actually safe because the untrusted field doesn't influence the
sensitive decision path.

## Migration path — field-level taint (v1.1)

When mixed-provenance workflows expose a gap in invariant tests, introduce:

```ts
export interface TaintedValue<T> {
  readonly value: T;
  readonly taint: Taint;
}
```

Payloads gain the option to carry `TaintedValue<T>` per field. `canPropose()`
gains a second signature that walks the payload, checking each tainted field
against its policy-declared requirement. Payload-level taint stays as the
envelope-wide default, computed as the meet of all field taints — **backwards
compatible**.

## API stability contract for v1.0 adopters

**Do** call `canPropose` once per envelope against `envelope.taint` in your
`PolicyBundle`.

**Do not** fan out to payload fields yourself by inspection.

When v1.1 ships field-level taint, your call-site continues to work — it just
gains precision. If you bake "this payload is entirely UNTRUSTED" into your
policy logic, your v1.0 policy will over-refuse in v1.1 and under-refuse if you
try to special-case individual fields without the API.

The rule in one line: **check fields through the API, not by inspection.**
