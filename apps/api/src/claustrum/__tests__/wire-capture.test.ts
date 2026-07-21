/**
 * Wire Truth (seam 1, pure core) — canonical hashing, the ALS pending bucket,
 * call sealing, and the size cap. The composed capture-pipeline test ("one
 * model call in → one llm_wire row out") lives in wire-capture-pipeline.test.ts;
 * this file pins the arithmetic those pieces must get right on their own:
 * hash stability across key order, capture-without-context as a designed no-op,
 * seal assigning call indexes in emit order (retry attempts share one), claim
 * emptying the buffer, TTL pruning abandoned turns, and honest truncation
 * flagging at the cap.
 */

import { describe, expect, it } from "vitest";
import {
  beginWireTurn,
  canonicalWireHash,
  capJsonBody,
  captureWireExchange,
  claimWireExchanges,
  sealWireCall,
  WIRE_BODY_MAX_BYTES,
} from "../wire-capture.js";

const AT = "2026-07-21T02:00:00.000Z";

describe("canonicalWireHash", () => {
  it("is stable across object key order", () => {
    const a = canonicalWireHash({ model: "m", messages: [{ role: "user", content: "oi" }] });
    const b = canonicalWireHash({ messages: [{ role: "user", content: "oi" }], model: "m" });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("differs when any value differs", () => {
    expect(canonicalWireHash({ t: 0 })).not.toBe(canonicalWireHash({ t: 0.1 }));
  });
});

describe("capJsonBody", () => {
  it("passes small bodies through untruncated", () => {
    const body = { messages: [{ role: "user", content: "oi" }] };
    expect(capJsonBody(body)).toEqual({ value: body, truncated: false });
  });

  it("truncates oversized bodies with an honest marker", () => {
    const capped = capJsonBody({ blob: "x".repeat(WIRE_BODY_MAX_BYTES + 1024) });
    expect(capped.truncated).toBe(true);
    const marker = capped.value as { __truncated: boolean; originalBytes: number; head: string };
    expect(marker.__truncated).toBe(true);
    expect(marker.originalBytes).toBeGreaterThan(WIRE_BODY_MAX_BYTES);
    expect(marker.head.length).toBeLessThanOrEqual(WIRE_BODY_MAX_BYTES);
  });
});

describe("capture → seal → claim", () => {
  it("is a designed no-op outside a wire-turn context (live-check, harnesses)", () => {
    captureWireExchange({ model: "m", request: { q: 1 }, response: null, at: AT });
    sealWireCall("turn-none");
    expect(claimWireExchanges("turn-none")).toHaveLength(0);
  });

  it("assigns call indexes in seal order; retry attempts share one call", async () => {
    await beginWireTurn(async () => {
      // call 0 — planner, single attempt.
      captureWireExchange({ model: "m", request: { call: "planner" }, response: { ok: 1 }, at: AT });
      sealWireCall("turn-A");
      // call 1 — responder, three attempts (regenerate-on-empty loop).
      captureWireExchange({ model: "m", request: { call: "responder" }, response: { try: 1 }, at: AT });
      captureWireExchange({ model: "m", request: { call: "responder" }, response: { try: 2 }, at: AT });
      captureWireExchange({ model: "m", request: { call: "responder" }, response: { try: 3 }, at: AT });
      sealWireCall("turn-A");
    });
    const claimed = claimWireExchanges("turn-A");
    expect(claimed.map((x) => [x.seq, x.callIndex])).toEqual([
      [0, 0],
      [1, 1],
      [2, 1],
      [3, 1],
    ]);
    expect(claimed[0]?.requestHash).toMatch(/^[0-9a-f]{64}$/);
    // Attempts of the same call share the request → share the hash.
    expect(claimed[1]?.requestHash).toBe(claimed[3]?.requestHash);
    expect(claimWireExchanges("turn-A")).toHaveLength(0);
  });

  it("leaves unsealed exchanges behind (a call whose trace was never emitted)", async () => {
    await beginWireTurn(async () => {
      captureWireExchange({ model: "m", request: { sealed: true }, response: null, at: AT });
      sealWireCall("turn-B");
      captureWireExchange({ model: "m", request: { orphan: true }, response: null, at: AT });
      // no seal — the emit guard was off for this call.
    });
    const claimed = claimWireExchanges("turn-B");
    expect(claimed).toHaveLength(1);
    expect((claimed[0]?.request as { sealed?: boolean }).sealed).toBe(true);
  });

  it("keeps concurrent turns isolated (ALS context per turn)", async () => {
    await Promise.all([
      beginWireTurn(async () => {
        captureWireExchange({ model: "m", request: { turn: "C" }, response: null, at: AT });
        await Promise.resolve();
        sealWireCall("turn-C");
      }),
      beginWireTurn(async () => {
        captureWireExchange({ model: "m", request: { turn: "D" }, response: null, at: AT });
        await Promise.resolve();
        sealWireCall("turn-D");
      }),
    ]);
    const c = claimWireExchanges("turn-C");
    const d = claimWireExchanges("turn-D");
    expect(c).toHaveLength(1);
    expect(d).toHaveLength(1);
    expect((c[0]?.request as { turn: string }).turn).toBe("C");
    expect((d[0]?.request as { turn: string }).turn).toBe("D");
  });

  it("prunes abandoned turns after the TTL so the buffer stays bounded", async () => {
    await beginWireTurn(async () => {
      captureWireExchange({ model: "m", request: { old: true }, response: null, at: AT, nowMs: 1_000_000 });
      sealWireCall("turn-old", 1_000_000);
    });
    await beginWireTurn(async () => {
      captureWireExchange({
        model: "m",
        request: { fresh: true },
        response: null,
        at: AT,
        nowMs: 1_000_000 + 20 * 60_000,
      });
      sealWireCall("turn-new", 1_000_000 + 20 * 60_000);
    });
    expect(claimWireExchanges("turn-old")).toHaveLength(0);
    expect(claimWireExchanges("turn-new")).toHaveLength(1);
  });
});
