/**
 * FE-T01 — proves EXTRACTION_FAILURE_KIND actually fails closed through the
 * REAL production policy composition (the exact `IBATEXAS_COMPOSED_PACKS` +
 * `buildIbatexasPolicyPacks` + `composePolicyRouter` pipeline
 * claustrum-bootstrap.ts wires the live conductor with — built here without
 * pulling in the full bootstrap module, which needs DB/Redis), not just a
 * hand-rolled fixture. Two claims under test:
 *
 *   1. No installed first-party pack claims `EXTRACTION_FAILURE_KIND` (it
 *      truly is an unowned sentinel, not an accidental collision).
 *   2. The REAL kernel `adjudicate()` REFUSEs an envelope of that kind, and
 *      the refusal localizes to a genuine, detail-free pt-BR message (never
 *      an English fallback reaching the customer).
 */

import { describe, expect, it } from "vitest";
import { adjudicate } from "@adjudicate/core/kernel";
import { buildEnvelope, localizeDecision, type Decision } from "@adjudicate/core";
import { portugueseRefusalMessages } from "@adjudicate/locales-pt-br";
import { IBATEXAS_COMPOSED_PACKS } from "@ibatexas/packs-composed";
import {
  composePolicyRouter,
  type CapabilityPolicyPack,
} from "../capability-policy.js";
import {
  buildIbatexasPolicyPacks,
  IBATEXAS_ADOPTER_BUSINESS_GUARDS,
  type ErasedPack,
} from "../compose-policy-packs.js";
import { EXTRACTION_FAILURE_KIND } from "../ibatexas-planner.js";

// Mirrors claustrum-bootstrap.ts's IBATEXAS_POLICY_PACKS / IBATEXAS_POLICY_ROUTER
// construction exactly, so this test proves the SAME router production adjudicates
// against — without importing the full (DB/Redis-backed) bootstrap module.
const REAL_PACKS = buildIbatexasPolicyPacks(
  IBATEXAS_COMPOSED_PACKS as unknown as ReadonlyArray<ErasedPack>,
  IBATEXAS_ADOPTER_BUSINESS_GUARDS,
) as unknown as ReadonlyArray<CapabilityPolicyPack>;
const REAL_ROUTER = composePolicyRouter(REAL_PACKS);

describe("EXTRACTION_FAILURE_KIND (FE-T01) — through the real production policy router", () => {
  it("is not claimed by any installed first-party pack", () => {
    const allClaimedKinds = new Set(REAL_PACKS.flatMap((p) => p.intents));
    expect(allClaimedKinds.has(EXTRACTION_FAILURE_KIND)).toBe(false);
  });

  it("REFUSEs through the real kernel adjudicate() (unowned-kind fail-closed default)", () => {
    const envelope = buildEnvelope({
      kind: EXTRACTION_FAILURE_KIND,
      payload: { reason: "malformed_tool_call" },
      actor: { principal: "llm", sessionId: "web:conv-1" },
      taint: "UNTRUSTED",
      nonce: "n-extraction-failure",
      createdAt: "2026-07-15T00:00:00.000Z",
    });
    const decision: Decision = adjudicate(
      envelope,
      { channel: "web" },
      REAL_ROUTER,
    );
    expect(decision.kind).toBe("REFUSE");
  });

  it("localizes to a genuine, detail-free pt-BR message (never English reaching the customer)", () => {
    const envelope = buildEnvelope({
      kind: EXTRACTION_FAILURE_KIND,
      payload: { reason: "empty_completion" },
      actor: { principal: "llm", sessionId: "web:conv-1" },
      taint: "UNTRUSTED",
      nonce: "n-extraction-failure-2",
      createdAt: "2026-07-15T00:00:00.000Z",
    });
    const decision = adjudicate(envelope, { channel: "web" }, REAL_ROUTER);
    const localized = localizeDecision(decision, portugueseRefusalMessages);
    expect(localized.kind).toBe("REFUSE");
    if (localized.kind === "REFUSE") {
      // pt-BR, non-empty, and — the load-bearing assertion — NOT the kernel's
      // raw English default ("I can't perform this action...").
      expect(localized.refusal.userFacing.length).toBeGreaterThan(0);
      expect(localized.refusal.userFacing).not.toMatch(/I can't|cannot|This action/i);
    }
  });
});
