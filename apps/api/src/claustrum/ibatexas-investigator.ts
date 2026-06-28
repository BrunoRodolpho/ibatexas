// ibatexas-investigator.ts — the INVESTIGATE stage host (SDD §M / §Q.6; v1.1 §7;
// Inv 7). Implements the published @claustrum/core `InvestigatorPort`: it WRITES
// this turn's resolved reads INTO the per-turn Evidence Ledger that the Conductor
// threads onward to CLAIMS-VALIDATE. The topology is one-directional (SDD §F):
// Read/Action FEED the ledger; the Claims kernel reads it OUT. The investigator
// never reads claims back — it only records evidence (and read errors).
//
// B-PR1 SCOPE — bootstrap seam, FLAG DEFAULT-OFF: this module is wired into the
// composition root but only RUNS when ENABLE_CLAIMS_PIPELINE is on (the shadow
// claims path; activation is a later PR). It is a faithful skeleton: the real
// first-party read backends (which return concrete values AND distinguishable
// error states) thread in via an injected `gatherReads` in a later PR.
//
// Inv 7 (load-bearing — error ≠ absence; fail CLOSED): a read that ERRORS is
// recorded via `ledger.recordError(key, reason)`, a DISTINCT ledger state from a
// read ABSENCE (a never-recorded key). A silently-omitted failed read would let a
// missing safety read look like "nothing to say" instead of "we could not check".
//
// The investigator OWNS THE CLOCK (the ledger is clockless — `fetchedAt` is
// supplied BY this stage, per the published InvestigatorPort doc): `now()` is
// injected (default `Date.now`) so the recorded timestamps are deterministic in
// tests.

import type { EvidenceEntryInput, LedgerTaint, SourceMode } from "@adjudicate/core";
import type { InvestigateInput, InvestigatorPort } from "@claustrum/core";

/**
 * One read the investigator records into the per-turn Evidence Ledger.
 *
 * `origin` is the trust label applied AT MINT against the PUBLISHED 2-value
 * `LedgerTaint`: a first-party DB read is `"TRUSTED"`; an untrusted / free-text
 * (LLM- or customer-derived) read is `"UNTRUSTED_DATA"`.
 *
 * TODO(R1-published): the 3-value `OriginProvenance` (with `FIRST_PARTY`) lives
 * in the LOCAL/unpublished R1-led kernel — it is NOT in published
 * `@adjudicate/core@1.6.0` (whose `EvidenceEntry.originProvenance` is the 2-value
 * `LedgerTaint`). Do NOT fake a `FIRST_PARTY` against the 2-value type here; a
 * first-party read is labeled `"TRUSTED"` until the 3-value kernel publishes.
 */
export interface TurnRead {
  /** The evidence key this read binds (the ledger / claims kernel key). */
  readonly key: string;
  /** Human/system-readable descriptor of which read produced the value. */
  readonly source: string;
  /** Origin trust at mint (published 2-value `LedgerTaint`) — see the type doc. */
  readonly origin: LedgerTaint;
  /** `"live"` (read this turn) vs `"cache"`. Defaults to `"live"`. */
  readonly sourceMode?: SourceMode;
  /**
   * Produce the read VALUE. May throw / reject — a thrown read is recorded as a
   * read ERROR (Inv 7), NEVER silently omitted.
   */
  readonly read: () => unknown | Promise<unknown>;
}

/**
 * Derive this turn's reads from the resolved cognition + plan. INJECTED so the
 * host can wire the real first-party read backends later; defaults to
 * {@link defaultTurnReads}.
 */
export type TurnReadGatherer = (
  input: InvestigateInput,
) => ReadonlyArray<TurnRead> | Promise<ReadonlyArray<TurnRead>>;

export interface IbatexasInvestigatorDeps {
  /** This turn's read source. Defaults to {@link defaultTurnReads}. */
  readonly gatherReads?: TurnReadGatherer;
  /**
   * The clock the investigator stamps `fetchedAt` with (the ledger is clockless;
   * the investigator owns the clock — published InvestigatorPort doc). Defaults
   * to `Date.now`.
   */
  readonly now?: () => number;
}

/**
 * The DEFAULT read gatherer (B-PR1 placeholder): derives one read per read-only
 * tool call the planner made this turn (`plan.readToolCalls`). A read-tool input
 * is LLM/customer-derived, so it is labeled `"UNTRUSTED_DATA"`. The real
 * first-party read backends (concrete values + `"TRUSTED"` + distinguishable
 * error states) thread in via an injected gatherer in a later PR. Pure.
 */
export function defaultTurnReads(input: InvestigateInput): TurnRead[] {
  const calls = input.plan.readToolCalls ?? [];
  return calls.map((call, i) => ({
    key: `read:${call.name}:${i}`,
    source: call.name,
    // A read-tool input is LLM/customer-derived — never a validating value (Inv
    // 3 is enforced downstream by the soundness predicate; here it is recorded
    // faithfully as UNTRUSTED_DATA).
    origin: "UNTRUSTED_DATA" as LedgerTaint,
    sourceMode: "live" as SourceMode,
    read: () => call.input,
  }));
}

/**
 * Create the ibatexas INVESTIGATE stage (the published `InvestigatorPort`).
 *
 * `investigate` gathers this turn's reads and WRITES each into `input.ledger`:
 * a successful read → `ledger.record(...)`; a thrown/failed read →
 * `ledger.recordError(key, reason)` (Inv 7 — error ≠ absence, fail CLOSED).
 * Returns `void` — the ledger IS the output (threaded onward; no second copy).
 */
export function createIbatexasInvestigator(
  deps: IbatexasInvestigatorDeps = {},
): InvestigatorPort {
  const gatherReads = deps.gatherReads ?? defaultTurnReads;
  const now = deps.now ?? (() => Date.now());

  return {
    async investigate(input: InvestigateInput): Promise<void> {
      const { ledger } = input;
      const reads = await gatherReads(input);

      for (const r of reads) {
        let value: unknown;
        try {
          value = await r.read();
        } catch (err) {
          // Inv 7 — a read ERROR is a DISTINCT, recorded ledger state, never a
          // silent omission (which would be a read ABSENCE). Fail CLOSED.
          ledger.recordError(r.key, reasonOf(err));
          continue;
        }

        const entry: EvidenceEntryInput = {
          key: r.key,
          value,
          source: r.source,
          // The investigator owns the clock; the ledger needs none.
          fetchedAt: now(),
          sourceMode: r.sourceMode ?? "live",
          taint: r.origin,
          // 2-value published originProvenance (see TurnRead.origin TODO).
          originProvenance: r.origin,
        };
        ledger.record(entry);
      }
    },
  };
}

/** Render a thrown value as a stable, non-throwing reason string (audit). */
function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
