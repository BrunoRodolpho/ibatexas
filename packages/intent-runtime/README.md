# @adjudicate/intent-runtime

Replay-safe resume for deferred intents.

The kernel returns `DEFER` when an intent is valid but awaits an external
signal — a payment webhook confirming a pending charge, a manager approving
a request, an inventory restock unblocking an order. This package handles
the **resume** half of that flow with content-addressed deduplication so
duplicate webhook deliveries fold into exactly one execution.

## Public surface

```ts
import {
  resumeDeferredIntent,
  deferResumeHash,
  DEFER_PENDING_TTL_GRACE_SECONDS,
  type DeferRedis,
  type DeferLogger,
  type DeferResumeResult,
  type ParkedEnvelope,
  type ResumeDeferredIntentArgs,
} from "@adjudicate/intent-runtime";
```

## How it works

When the kernel returns `DEFER`, the adopter parks the envelope at a
session-scoped Redis key with TTL = `signal.timeoutMs + grace`. When the
awaited signal lands, the adopter calls `resumeDeferredIntent`, which:

1. Reads the parked envelope.
2. Computes `deferResumeHash(intentHash, signal)`.
3. Acquires a resume token via `SET NX` — first writer wins.
4. On success, deletes the parked key and returns the envelope so the
   adopter can re-adjudicate it. Duplicate deliveries return
   `duplicate_resume_suppressed`.

The Redis client and key-builder are injected — this package has no
transport or namespacing assumptions of its own.

## Adapter contract

```ts
interface DeferRedis {
  get(key: string): Promise<string | null>;
  set(
    key: string,
    value: string,
    options: { NX: true; EX: number },
  ): Promise<string | null>;
  del(key: string): Promise<unknown>;
}
```

Any Redis client implementing those three methods works. The shape matches
`node-redis` v4+; `ioredis` users need a thin wrapper.

## Second-domain example

[`examples/clinic/clinic-policies.ts`](./examples/clinic/clinic-policies.ts)
is a minimal `PolicyBundle` that shows how to author a domain against
`@adjudicate/intent-{core,kernel}` without forking the framework — useful
for verifying the kernel handles your domain shape before wiring up the
resume flow above.
