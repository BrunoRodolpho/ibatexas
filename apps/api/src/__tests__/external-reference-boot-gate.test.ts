// LE2-018 — REFUSE-TO-START, proven.
//
// Ticket 18's last acceptance criterion is "refuse-to-start behavior proven on
// the test stack", and it is the one that is easy to fake. A test that mocked
// the reconciler and asserted the mock threw would prove nothing about the
// process; a test that actually ran `bootstrapClaustrum()` would need Postgres,
// Redis, an Anthropic key and a conductor, and would fail for ten reasons
// before it reached this gate.
//
// So this file proves the two halves separately, and both for real:
//
//   1. THE SEAM — `assertExternalReferencesReconcile` over the REAL declaration
//      table (@ibatexas/catalog's actual `EXTERNAL_REFERENCES`), with the store
//      probes injected. A deliberately-missing reference must throw, and the
//      diagnostic must name the reference, its store, its config variable and
//      the code sites that break.
//   2. THE WIRING — that `claustrum-bootstrap.ts` actually calls it, awaits it,
//      and does not wrap it in a try/catch. A perfect gate nobody calls is the
//      failure mode this ticket exists to end, and it is exactly what the
//      `// must be created in Medusa admin before going live` comment was.
//
// Together those are the claim: on this stack, a missing declared reference
// stops the process.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  EXTERNAL_REFERENCES,
  type ExternalReferenceStore,
} from "@ibatexas/catalog";
import {
  assertExternalReferencesReconcile,
  ExternalReferenceReconciliationError,
  reconcileExternalReferences,
  type ExternalReferenceProbe,
  type ExternalReferenceProbes,
} from "@ibatexas/tools";
import { describe, expect, it } from "vitest";

// __dirname → apps/api/src/__tests__
const BOOTSTRAP_SOURCE = join(__dirname, "..", "claustrum-bootstrap.ts");

/** Every declared reference's config variable, set to something plausible. */
const CONFIGURED_ENV: Record<string, string> = Object.fromEntries(
  EXTERNAL_REFERENCES.map((declaration) => [
    declaration.keyFrom,
    `TEST_${declaration.id.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`,
  ]),
);

const present: ExternalReferenceProbe = async () => ({ status: "present" });

/** Probes where everything exists except the key named. */
function allPresentExcept(missingKey: string): ExternalReferenceProbes {
  const probe: ExternalReferenceProbe = async (key) =>
    key === missingKey ? { status: "absent" } : { status: "present" };
  const stores: ExternalReferenceStore[] = ["promotion", "delivery-zone"];
  return Object.fromEntries(stores.map((store) => [store, probe]));
}

const ALL_PRESENT: ExternalReferenceProbes = {
  promotion: present,
  "delivery-zone": present,
};

describe("LE2-018 — the api refuses to start on a missing external reference", () => {
  it("has something to reconcile (a gate over an empty table proves nothing)", () => {
    expect(EXTERNAL_REFERENCES.length).toBeGreaterThan(0);
  });

  it.each(EXTERNAL_REFERENCES.map((d) => [d.id, d] as const))(
    "%s missing from its store ⇒ the boot gate THROWS",
    async (_id, declaration) => {
      await expect(
        assertExternalReferencesReconcile({
          env: CONFIGURED_ENV,
          probes: allPresentExcept(CONFIGURED_ENV[declaration.keyFrom]!),
        }),
      ).rejects.toBeInstanceOf(ExternalReferenceReconciliationError);
    },
  );

  it("its config variable unset ⇒ the boot gate THROWS", async () => {
    // The other half of "missing": a reference nobody configured is a reference
    // that cannot exist, and the process must not start guessing.
    const { [EXTERNAL_REFERENCES[0]!.keyFrom]: _dropped, ...partial } = CONFIGURED_ENV;
    await expect(
      assertExternalReferencesReconcile({ env: partial, probes: ALL_PRESENT }),
    ).rejects.toThrow(EXTERNAL_REFERENCES[0]!.keyFrom);
  });

  it("the store unreachable ⇒ the boot gate THROWS (it did not prove anything)", async () => {
    await expect(
      assertExternalReferencesReconcile({
        env: CONFIGURED_ENV,
        probes: {
          promotion: async () => ({ status: "unreachable", detail: "ECONNREFUSED :9000" }),
          "delivery-zone": present,
        },
      }),
    ).rejects.toThrow(/could not be reached/);
  });

  it("everything present ⇒ the gate RESOLVES and the boot continues", async () => {
    const result = await assertExternalReferencesReconcile({
      env: CONFIGURED_ENV,
      probes: ALL_PRESENT,
    });
    expect(result.ok).toBe(true);
    expect(result.checked).toBe(EXTERNAL_REFERENCES.length);
  });
});

describe("LE2-018 — the diagnostic a refused boot leaves behind", () => {
  it("names the reference, the store, the config variable, the consumers and the cost", async () => {
    const welcome = EXTERNAL_REFERENCES.find((d) => d.id === "promotion.welcome-credit");
    expect(welcome, "the welcome credit must be a declared reference").toBeDefined();

    const err = await assertExternalReferencesReconcile({
      env: CONFIGURED_ENV,
      probes: allPresentExcept(CONFIGURED_ENV[welcome!.keyFrom]!),
    }).then(
      () => null,
      (e: unknown) => e as ExternalReferenceReconciliationError,
    );

    expect(err).not.toBeNull();
    const message = err!.message;
    expect(message).toContain("promotion.welcome-credit");
    expect(message).toContain("promotion store");
    expect(message).toContain("WELCOME_CREDIT_COUPON_CODE");
    for (const consumer of welcome!.declaredBy) {
      expect(message, `the refusal must name ${consumer.site}`).toContain(consumer.site);
    }
    // …and what it costs to have shipped it broken, not just that it is broken.
    expect(message).toContain(welcome!.why.slice(0, 40));
  });

  it("reports EVERY missing reference at once, not the first", async () => {
    // An operator provisioning a fresh environment should get one list, not one
    // restart per coupon.
    const result = await reconcileExternalReferences({
      env: {},
      probes: ALL_PRESENT,
    });
    expect(result.misses).toHaveLength(EXTERNAL_REFERENCES.length);
  });
});

describe("LE2-018 — the gate is actually wired into the api's boot", () => {
  const source = readFileSync(BOOTSTRAP_SOURCE, "utf8");

  it("claustrum-bootstrap.ts imports the assertion from @ibatexas/tools", () => {
    expect(source).toMatch(/assertExternalReferencesReconcile[\s\S]*from "@ibatexas\/tools"/);
  });

  const CALL = source.indexOf("await assertExternalReferencesReconcile(");

  it("AWAITS it — a floating promise would let the boot race past the gate", () => {
    expect(CALL).toBeGreaterThan(-1);
  });

  it("does not swallow the refusal in a try/catch", () => {
    // The whole feature is that this throw reaches the top and kills the
    // process. A `catch` around it — even one that logs — is the bug.
    // Look at the 400 characters on either side: a wrapping try/catch would
    // have to open before and close after.
    const window = source.slice(Math.max(0, CALL - 400), CALL + 400);
    expect(window).not.toMatch(/\btry\s*\{/);
  });

  it("runs it beside the other fail-closed boot gates, after them", () => {
    // Ordering claim from the gate's own comment: the roster gates come first
    // (they need no IO and fail faster), this one last.
    expect(source.indexOf("toolRosterDrift(")).toBeLessThan(CALL);
  });

  it("is guarded by nothing — no env var, no flag, no conditional", () => {
    // The call's only argument is a probe SEAM (the same kind `pgPool` and
    // `modelProvider` are), and injecting probes does not skip the
    // reconciliation. What must never appear is a condition that decides
    // whether the gate runs at all.
    const statement = source.slice(CALL, source.indexOf(");", CALL) + 2);
    expect(statement).not.toMatch(/\bif\b|process\.env|NODE_ENV|SKIP|DISABLE/);
    const precedingLine = source.slice(source.lastIndexOf("\n", CALL - 1) + 1, CALL);
    expect(precedingLine.trim()).toBe("");
  });
});
