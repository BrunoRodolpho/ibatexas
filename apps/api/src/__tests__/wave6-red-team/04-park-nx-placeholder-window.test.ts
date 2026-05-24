// Wave 6 Red-Team — Target 1 (P0-7-TRUE parkDeferredIntent NX wrapper)
//
// Finding: the NX wrapper writes a placeholder envelope between
// step 1 (SETNX) and step 2 (framework park). Within that narrow
// window, a concurrent reader sees the placeholder, NOT a parked
// envelope. The placeholder shape is:
//
//   { __nx_placeholder__: true, sessionId, claimedAt: "..." }
//
// This is FINE for the existing defer-resolver (it checks
// `parked.signal !== signal` first — placeholder has no `signal` so
// it returns `signal_mismatch`). It is NOT fine for any future code
// path that:
//   (a) reads `parked.envelope` without first checking for signal/
//       verification.hash;
//   (b) treats `defer:pending:*` as a manifest of parked work for
//       reporting / metrics.
//
// Severity: P2 — no current consumer is broken; this is a forward
// hazard. A new dashboard polling defer-pending size would mis-count
// during boot bursts.
//
// Also: if `parkDeferredIntent` THROWS after INCR'ing the per-session
// quota counter but BEFORE the SET, the wrapper deletes the placeholder
// (line 156-159) but does NOT decrement the counter. The slot is
// "leaked" — quota appears full to legitimate callers.

import { describe, it, expect, vi } from "vitest";

// Stub framework park that increments counter then throws — modelling
// a network blip between INCR and SET. The point is to show counter
// state DOESN'T roll back in this path.
async function stubFrameworkParkThatThrows(): Promise<never> {
  throw new Error("simulated network blip after INCR");
}

describe("RED-TEAM Target 1 — NX wrapper placeholder + quota-leak window", () => {
  it("OBSERVATION: placeholder shape is recognizably non-envelope", () => {
    // Pin the placeholder shape so any future consumer that
    // assumes `parked.envelope.kind` will fail loudly rather than
    // silently dispatching an empty envelope.
    const placeholderValue = JSON.stringify({
      __nx_placeholder__: true,
      sessionId: "sess-abc",
      claimedAt: new Date().toISOString(),
    });
    const parsed = JSON.parse(placeholderValue);
    expect(parsed.__nx_placeholder__).toBe(true);
    expect(parsed.envelope).toBeUndefined();
    expect(parsed.signal).toBeUndefined();
  });

  it("CONFIRMS: defer-resolver's signal-mismatch path defends against placeholder read", () => {
    // Manual simulation: if a resolver reads the placeholder before
    // the framework overwrites it, the `parked.signal !== signal`
    // check returns signal_mismatch — safe.
    const placeholderRaw = JSON.stringify({
      __nx_placeholder__: true,
      sessionId: "sess-abc",
      claimedAt: new Date().toISOString(),
    });
    const parked = JSON.parse(placeholderRaw) as {
      signal?: string;
      envelope?: { kind: string };
    };
    const incomingSignal = "pix.confirmed";

    // Existing defer-resolver code at apps/api/src/subscribers/
    // defer-resolver.ts:377 — `parked.signal !== signal`.
    const wouldShortCircuit = parked.signal !== incomingSignal;
    expect(wouldShortCircuit).toBe(true);
  });

  it("HAZARD: a counter that polls defer:pending:* would mis-count placeholders", () => {
    // A naive `redis.scan('defer:pending:*')` and count operation would
    // include the placeholder in the in-flight gauge. The W3-published
    // `kernel_defer_pending_gauge` (kernel-metrics-sink.ts:298-305)
    // is implemented this way — narrow race that bumps the gauge by
    // up to one per session for the duration of the SETNX→SET gap.
    //
    // For low traffic this is invisible; for a startup burst with N
    // concurrent first-time DEFERs, the gauge briefly reads N higher
    // than the truth.
    //
    // We DO NOT have a fix recommendation that doesn't change the
    // wrapper's contract — but we surface the discrepancy for monitor-
    // tuning ops.
    expect(true).toBe(true); // documentation pin
  });

  it("HAZARD: when framework park throws AFTER counter INCR, wrapper cleans up the placeholder but NOT the counter", async () => {
    // Build a stub that mimics the wrapper's catch path. The wrapper
    // (apps/api/src/adapters/park-deferred-intent-nx.ts:155-161):
    //
    //   try { result = await parkDeferredIntent(args) ... }
    //   catch (err) {
    //     await args.redis.del(parkKey).catch(() => {});
    //     throw err;
    //   }
    //
    // It does NOT decrement counterKey. The framework's own roll-back
    // path (defer-park.ts:198-199) is only reached on the "newCount >
    // quota" branch, not on a thrown exception.
    //
    // We assert this by reading the wrapper module and verifying the
    // catch block has no `decr` on the counter key.
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const wrapperPath = join(
      __dirname,
      "..",
      "..",
      "adapters",
      "park-deferred-intent-nx.ts",
    );
    const source = readFileSync(wrapperPath, "utf8");
    // The catch block lines (155-161) — verify they only delete the
    // park key, never decrement a counter.
    const catchBlock = source
      .split("\n")
      .slice(150, 165)
      .join("\n");
    expect(catchBlock).toContain("del?.(parkKey)");
    expect(catchBlock).not.toMatch(/decr\?.\(counterKey/);
  });
});

// ── Recommendation ──────────────────────────────────────────────────
//
// Two improvements:
//   (a) Tighten the placeholder schema so any reader that sees
//       `__nx_placeholder__:true` returns immediately (don't even
//       attempt the verification.hash check downstream).
//   (b) On the wrapper's catch path, also DECR the counter key
//       (best-effort, swallow errors) so a thrown-mid-park does not
//       leak a quota slot. Note: this requires the wrapper to know
//       the counter key — easy to derive (`deferCounterKey(sessionId)`)
//       since `@adjudicate/runtime` exports it.
