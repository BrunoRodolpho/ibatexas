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

import { describe, it, expect } from "vitest";

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

  it("REMEDIATED: when framework park throws AFTER counter INCR, the wrapper cleans up BOTH the placeholder AND the counter (no quota-slot leak)", async () => {
    // This test originally DOCUMENTED a hazard: the wrapper's catch path
    // released the placeholder (`args.redis.del(parkKey)`) but did NOT
    // decrement counterKey, so a park that threw AFTER the framework's INCR
    // leaked a quota slot. Recommendation (b) below proposed the fix.
    //
    // audit-2026-05-24 P1-8 + I8 IMPLEMENTED that remediation in the
    // canonical wrapper:
    //
    //   } catch (err) {
    //     await releaseNxPlaceholder(redis, parkKey, placeholderValue); // Lua CAD
    //     await redis.decr(counterKey).catch(() => {});                 // quota slot
    //     throw err;
    //   }
    //
    // So the hazard no longer exists — we now PIN the remediation: the catch
    // must clean up BOTH the placeholder and the counter.
    //
    // WS5/WS8 (claustrum-on-dev): the canonical wrapper lives in apps/api at
    // `adapters/park-nx.ts` (the llm-provider transition-shim copy was deleted
    // together with the brain in WS8). Read the canonical module.
    //
    // F-22 moved two things this assertion depended on, and the assertions
    // moved with them rather than being loosened:
    //   • `releaseNxPlaceholder` grew its OWN `catch (err)`, so the naive
    //     `indexOf("} catch (err) {")` now lands on that one. The search is
    //     anchored past the framework delegation, which is what the comment
    //     below always SAID it did.
    //   • the quota DECR dropped its optional-call cast (`redis.decr?.(…)`)
    //     for a direct `redis.decr(…)`, because `decr` is a REQUIRED member of
    //     the composition-validated surface. The regex tracks that.
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const wrapperPath = join(
      __dirname,
      "..",
      "..",
      "adapters",
      "park-nx.ts",
    );
    const source = readFileSync(wrapperPath, "utf8");
    // Locate the catch block by searching for the signature `} catch (err) {`
    // immediately following the framework primitive delegation — robust to
    // line-number drift across edits.
    const delegationIdx = source.indexOf("await parkDeferredIntent(");
    expect(delegationIdx).toBeGreaterThan(-1);
    const catchIdx = source.indexOf("} catch (err) {", delegationIdx);
    expect(catchIdx).toBeGreaterThan(-1);
    // Bound the slice at the enclosing function's closing brace (the first
    // column-0 `}` after the catch) rather than at an arbitrary character
    // count — a fixed count silently truncates the block as comments grow,
    // which is exactly how the `throw err` assertion first went missing.
    const fnEndIdx = source.indexOf("\n}", catchIdx);
    expect(fnEndIdx).toBeGreaterThan(catchIdx);
    const catchBlock = source.slice(catchIdx, fnEndIdx);
    // Placeholder cleanup (Lua compare-and-delete via releaseNxPlaceholder).
    expect(catchBlock).toContain("releaseNxPlaceholder");
    expect(catchBlock).toContain("parkKey");
    // Quota-slot cleanup — the P1-8 remediation (no longer the documented hazard).
    expect(catchBlock).toMatch(/redis\.decr\(counterKey/);
    expect(catchBlock).toContain("throw err");
    // F-22: the catch must NOT reach for a raw DEL. The pre-F-22 cleanup
    // degraded to `redis.del(parkKey)` whenever the Lua release was
    // unavailable or threw, which is the defect that ruling retired.
    expect(catchBlock).not.toMatch(/\.del\??\.?\(/);
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
