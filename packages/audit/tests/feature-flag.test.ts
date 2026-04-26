import { describe, expect, it } from "vitest";
import { isLedgerEnabled, isLedgerEnforced } from "../src/feature-flag.js";

describe("feature flags — parseBool", () => {
  it("isLedgerEnabled accepts 1/true/yes/on (case-insensitive)", () => {
    expect(isLedgerEnabled({ IBX_LEDGER_ENABLED: "1" })).toBe(true);
    expect(isLedgerEnabled({ IBX_LEDGER_ENABLED: "true" })).toBe(true);
    expect(isLedgerEnabled({ IBX_LEDGER_ENABLED: "True" })).toBe(true);
    expect(isLedgerEnabled({ IBX_LEDGER_ENABLED: "yes" })).toBe(true);
    expect(isLedgerEnabled({ IBX_LEDGER_ENABLED: "ON" })).toBe(true);
  });

  it("isLedgerEnabled rejects anything else", () => {
    expect(isLedgerEnabled({})).toBe(false);
    expect(isLedgerEnabled({ IBX_LEDGER_ENABLED: "" })).toBe(false);
    expect(isLedgerEnabled({ IBX_LEDGER_ENABLED: "0" })).toBe(false);
    expect(isLedgerEnabled({ IBX_LEDGER_ENABLED: "no" })).toBe(false);
    expect(isLedgerEnabled({ IBX_LEDGER_ENABLED: "false" })).toBe(false);
  });

  it("isLedgerEnforced is independent of isLedgerEnabled", () => {
    expect(
      isLedgerEnforced({
        IBX_LEDGER_ENABLED: "true",
        IBX_LEDGER_ENFORCE: "false",
      }),
    ).toBe(false);
    expect(
      isLedgerEnforced({
        IBX_LEDGER_ENABLED: "false",
        IBX_LEDGER_ENFORCE: "true",
      }),
    ).toBe(true);
  });
});
