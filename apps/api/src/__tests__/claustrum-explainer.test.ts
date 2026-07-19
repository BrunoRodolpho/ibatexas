// Unit tests for the pt-BR refusal explainer (ibatexasExplainer).
//
// The explainer localizes a kernel/pack `Refusal` to user-facing pt-BR by its
// stable `code` via the @adjudicate/locales-pt-br registry. The load-bearing
// invariant: a SECURITY refusal NEVER surfaces the operator-facing `detail`
// (and does not trust pack `userFacing` either) — it renders only the curated
// registry entry or a generic pt-BR message.

import { describe, it, expect } from "vitest";
import { refuse, type Refusal } from "@adjudicate/core";
import { portugueseRefusalMessages } from "@adjudicate/locales-pt-br";
import { ibatexasExplainer, opsExplainer } from "../claustrum-bootstrap.js";

// Mirror the generic fallbacks defined inside ibatexasExplainer().
const GENERIC_PTBR = "Desculpe, não consegui atender ao pedido.";
const GENERIC_SECURITY_PTBR =
  "Não consigo continuar com essa solicitação. Pode tentar de outra forma?";

describe("ibatexasExplainer — pt-BR refusal localization", () => {
  const explainer = ibatexasExplainer();

  it("renders a mapped kernel code from the pt-BR registry (over English userFacing)", () => {
    const out = explainer.render(
      refuse("BUSINESS_RULE", "default_deny", "English default text"),
    );
    expect(out).toBe(portugueseRefusalMessages.byCode.default_deny);
    expect(out).toBe("Essa ação não é permitida neste momento.");
  });

  it("renders a mapped SECURITY code from the registry and never leaks operator detail", () => {
    const out = explainer.render(
      refuse(
        "SECURITY",
        "kill_switch_active",
        "System is temporarily unavailable.",
        "pg pool exhausted host=db-1",
      ),
    );
    expect(out).toBe(portugueseRefusalMessages.byCode.kill_switch_active);
    expect(out).not.toContain("db-1");
    expect(out).not.toContain("pool");
  });

  it("falls back to a generic pt-BR message for an UNMAPPED SECURITY code — no userFacing/detail leak", () => {
    const out = explainer.render(
      refuse(
        "SECURITY",
        "made.up.security.code",
        "leaky-userFacing-SHOULD-NOT-SHOW",
        "computed=abc expected=def",
      ),
    );
    expect(out).toBe(GENERIC_SECURITY_PTBR);
    expect(out).not.toContain("leaky");
    expect(out).not.toContain("abc");
    expect(out).not.toContain("def");
  });

  it("falls through to the pack's embedded pt-BR userFacing for an unmapped non-SECURITY code", () => {
    const userFacing = "Seu pedido já saiu pra entrega — não dá mais pra alterar.";
    const out = explainer.render(refuse("STATE", "order.already_shipped", userFacing));
    expect(out).toBe(userFacing);
  });

  it("falls back to a generic pt-BR message for an unmapped non-SECURITY code with no userFacing", () => {
    const out = explainer.render({
      kind: "STATE",
      code: "made.up.code",
      userFacing: undefined,
    } as unknown as Refusal);
    expect(out).toBe(GENERIC_PTBR);
  });

  it("never returns an empty string across all refusal kinds (CC-004)", () => {
    for (const kind of ["SECURITY", "BUSINESS_RULE", "AUTH", "STATE"] as const) {
      const out = explainer.render(refuse(kind, "any.unmapped.code", "uf"));
      expect(out.length).toBeGreaterThan(0);
    }
  });
});

// ── BKL-145 — the STAFF-VOICED ops overlay ──────────────────────────────────
// The base explainer's copy is customer-voiced; the ops plane overlays a small
// staff-voiced map for NON-SECURITY codes only. SECURITY renders and unmapped
// codes are byte-identical to the base (the leak-proof branch stays sole author).
describe("opsExplainer — staff-voiced overlay (ops plane only)", () => {
  const base = ibatexasExplainer();
  const ops = opsExplainer(base);

  it("overlays auth.required with the staff unblock (never the customer onboarding ask)", () => {
    const out = ops.render(refuse("BUSINESS_RULE", "auth.required", "customer copy"));
    expect(out).toBe(
      "Essa ação precisa de um pedido identificado — me diga o número do pedido.",
    );
    expect(out).not.toContain("cadastro");
    expect(out).not.toContain("WhatsApp");
  });

  it("overlays order.not_found without the customer-addressed 'pra você'", () => {
    const out = ops.render(
      refuse("STATE", "order.not_found", "Não encontrei um pedido em aberto pra você."),
    );
    expect(out).toBe("Não encontrei esse pedido — confira o número e tente de novo.");
    expect(out).not.toContain("pra você");
  });

  it("an UNMAPPED code falls through byte-identically to the base", () => {
    const refusal = refuse("BUSINESS_RULE", "default_deny", "English default text");
    expect(ops.render(refusal)).toBe(base.render(refusal));
  });

  it("SECURITY renders are NEVER overlaid — base leak-proof branch byte-identical", () => {
    const refusal = refuse(
      "SECURITY",
      "auth.required", // even a code IN the overlay map must not overlay under SECURITY
      "user facing",
      "operator detail host=db-1",
    );
    expect(ops.render(refusal)).toBe(base.render(refusal));
    expect(ops.render(refusal)).not.toContain("db-1");
  });
});
