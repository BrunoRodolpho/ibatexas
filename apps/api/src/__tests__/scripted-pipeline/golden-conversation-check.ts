// T2-6b — golden-conversation conformance check (CC-006 methodology +
// ibatexas extensions).
//
// Structurally implements the upstream `@claustrum/conformance` extension
// points (ConformanceCheck / ConformanceOptions / ConformanceResult — types
// mirrored below 1:1 from the published 0.1.1 surface) so this check can be
// passed to upstream `runConformance(conductor, { checks, fixturesDir })`
// unchanged the day `@claustrum/conformance` is added as a dependency. It is
// NOT imported today: the package is not in the workspace dependency graph,
// and adding a registry dep mid-phase would rewrite the shared lockfile other
// in-flight work holds open (see the suite header). The shapes are tiny and
// pinned; drift surfaces as a type error at the future one-line swap.
//
// METHODOLOGY — byte-faithful to upstream CC-006 (few-shot-regression.ts):
//   - discover `*.json` fixtures in `options.fixturesDir`, sorted by id;
//   - per fixture, open a Capsule for synthetic customer `cc006-${id}`,
//     conversation `cc006-conv-${id}`, channel "web", fixed receivedAt;
//   - drive the LAST user message through `handleTurn`;
//   - compare deduplicated envelope-kind sets + final Decision.kind;
//   - never throw: failures accumulate into `details`.
//
// EXTENSIONS (the adopter invariants CC-006 cannot see):
//   - expectedRefusalCode — the kernel/pack stable Refusal.code, asserted on
//     BOTH the Decision and the dispatch result (acted.code);
//   - expectAwaitingConfirmation — response.meta.awaitingConfirmation AND the
//     envelope actually parked in the session store (the live JOURNEY-001
//     confirm-gate leg, D-014);
//   - expectedParkedPayload — subset match on the parked envelope's RESOLVED
//     payload ({{ORDER_ID}}-templated at load: the NL→id auto-resolve leg);
//   - expectedResponseText — exact rendered text (scripted responder).

import { handleTurn, type Conductor } from "@claustrum/core";
import {
  loadGoldenFixtures,
  type GoldenConversationFixture,
  type TemplateSubstitutions,
} from "./fixture-format.js";

// ── Upstream type mirrors (@claustrum/conformance 0.1.1) ────────────────────

export interface ConformanceCheck {
  readonly id: string;
  readonly name: string;
  run(
    conductor: Conductor,
    options: ConformanceOptions,
  ): Promise<ConformanceResult>;
}

export interface ConformanceOptions {
  readonly sampling?: number;
  readonly seed?: number;
  readonly checks?: ReadonlyArray<ConformanceCheck>;
  readonly fixturesDir?: string;
}

export interface ConformanceResult {
  readonly id: string;
  readonly name: string;
  readonly passed: boolean;
  readonly details?: string;
}

// Upstream CC-006 pins this timestamp; matching it keeps the drive
// byte-comparable across the two runners.
const FIXED_RECEIVED_AT = "2026-05-18T00:00:00.000Z";

export function cc006CustomerId(fixtureId: string): string {
  return `cc006-${fixtureId}`;
}

export function cc006ConversationId(fixtureId: string): string {
  return `cc006-conv-${fixtureId}`;
}

function lastUserMessage(
  fixture: GoldenConversationFixture,
): string | undefined {
  for (let i = fixture.conversation.length - 1; i >= 0; i--) {
    const m = fixture.conversation[i];
    if (m?.role === "user") return m.content;
  }
  return undefined;
}

function isSubset(
  expected: Readonly<Record<string, unknown>>,
  actual: unknown,
): boolean {
  if (actual === null || typeof actual !== "object") return false;
  const a = actual as Record<string, unknown>;
  return Object.entries(expected).every(
    ([k, v]) => JSON.stringify(a[k]) === JSON.stringify(v),
  );
}

// The resolved outcome of a single driven turn (handleTurn's awaited result).
type TurnResult = Awaited<ReturnType<typeof handleTurn>>;

// Each per-fixture check returns a failure message, or null when it passes.
// They are evaluated in order and short-circuit on the first failure, exactly
// mirroring the original sequence of `continue`-guarded assertions.

// ── Base CC-006 assertions ──
function checkEnvelopeKinds(
  fixture: GoldenConversationFixture,
  result: TurnResult,
): string | null {
  const actualKinds = Array.from(
    new Set(result.plan.envelopes.map((e) => String(e.kind))),
  ).sort((a, b) => a.localeCompare(b));
  const expectedKinds = Array.from(
    new Set(fixture.expectedEnvelopeKinds.map(String)),
  ).sort((a, b) => a.localeCompare(b));
  if (
    actualKinds.length !== expectedKinds.length ||
    actualKinds.some((k, i) => k !== expectedKinds[i])
  ) {
    return `fixture "${fixture.id}": envelope kinds [${actualKinds.join(",")}] ≠ expected [${expectedKinds.join(",")}]`;
  }
  return null;
}

function checkDecisionKind(
  fixture: GoldenConversationFixture,
  result: TurnResult,
): string | null {
  if (result.decision.kind !== fixture.expectedDecisionKind) {
    return `fixture "${fixture.id}": decision.kind=${result.decision.kind} ≠ expected ${fixture.expectedDecisionKind}`;
  }
  return null;
}

// ── T2-6b extensions ──
function checkRefusalCode(
  fixture: GoldenConversationFixture,
  result: TurnResult,
): string | null {
  if (fixture.expectedRefusalCode === undefined) return null;
  const refusal =
    result.decision.kind === "REFUSE"
      ? (result.decision as { refusal: { code: string } }).refusal
      : undefined;
  if (refusal?.code !== fixture.expectedRefusalCode) {
    return `fixture "${fixture.id}": refusal.code=${refusal?.code ?? "<none>"} ≠ expected ${fixture.expectedRefusalCode}`;
  }
  const acted = result.acted as { kind: string; code?: string };
  if (acted.kind !== "refused" || acted.code !== fixture.expectedRefusalCode) {
    return `fixture "${fixture.id}": acted=${acted.kind}/${acted.code ?? "<none>"} ≠ refused/${fixture.expectedRefusalCode}`;
  }
  return null;
}

async function checkAwaitingConfirmation(
  conductor: Conductor,
  fixture: GoldenConversationFixture,
  result: TurnResult,
): Promise<string | null> {
  if (fixture.expectAwaitingConfirmation !== true) return null;
  if (result.response.meta?.awaitingConfirmation !== true) {
    return (
      `fixture "${fixture.id}": response.meta.awaitingConfirmation not set ` +
      `(meta=${JSON.stringify(result.response.meta ?? null)})`
    );
  }
  const session = await conductor.sessions.load(
    cc006CustomerId(fixture.id),
    "web",
  );
  const parked = session.pendingConfirmations;
  if (parked.length !== 1) {
    return `fixture "${fixture.id}": expected exactly 1 parked confirmation, found ${parked.length}`;
  }
  if (
    fixture.expectedParkedPayload !== undefined &&
    !isSubset(fixture.expectedParkedPayload, parked[0]?.envelope.payload)
  ) {
    return (
      `fixture "${fixture.id}": parked payload ${JSON.stringify(parked[0]?.envelope.payload)} ` +
      `does not contain expected ${JSON.stringify(fixture.expectedParkedPayload)}`
    );
  }
  return null;
}

function checkResponseText(
  fixture: GoldenConversationFixture,
  result: TurnResult,
): string | null {
  if (
    fixture.expectedResponseText !== undefined &&
    result.response.text !== fixture.expectedResponseText
  ) {
    return (
      `fixture "${fixture.id}": response.text=${JSON.stringify(result.response.text)} ` +
      `≠ expected ${JSON.stringify(fixture.expectedResponseText)}`
    );
  }
  return null;
}

// Drive one fixture and run every assertion; returns the first failure message
// (or null when the fixture fully verifies).
async function verifyFixture(
  conductor: Conductor,
  fixture: GoldenConversationFixture,
): Promise<string | null> {
  const text = lastUserMessage(fixture);
  if (text === undefined) return `fixture "${fixture.id}": no user message`;

  const customerId = cc006CustomerId(fixture.id);
  const conversationId = cc006ConversationId(fixture.id);

  let capsule;
  try {
    capsule = await conductor.openCapsule({
      channel: "web",
      customerId,
      inbound: {
        channel: "web",
        customerId,
        conversationId,
        text,
        receivedAt: FIXED_RECEIVED_AT,
      },
    });
  } catch (err) {
    return `fixture "${fixture.id}": openCapsule threw: ${(err as Error).message}`;
  }

  let result: TurnResult;
  try {
    result = await handleTurn(capsule, {
      channel: "web",
      customerId,
      conversationId,
      text,
      receivedAt: FIXED_RECEIVED_AT,
    });
  } catch (err) {
    await conductor.closeCapsule(capsule);
    return `fixture "${fixture.id}": handleTurn threw: ${(err as Error).message}`;
  }
  await conductor.closeCapsule(capsule);

  return (
    checkEnvelopeKinds(fixture, result) ??
    checkDecisionKind(fixture, result) ??
    checkRefusalCode(fixture, result) ??
    (await checkAwaitingConfirmation(conductor, fixture, result)) ??
    checkResponseText(fixture, result)
  );
}

export interface CreateGoldenConversationCheckOptions {
  /** Bound at suite setup (seeded ids); applied to fixtures at load. */
  readonly substitutions: TemplateSubstitutions;
}

export function createGoldenConversationCheck(
  opts: CreateGoldenConversationCheckOptions,
): ConformanceCheck {
  return {
    id: "IBX-GC-006",
    name: "Golden conversations reproduce envelope kinds, decisions and responder behavior",
    async run(conductor, options): Promise<ConformanceResult> {
      if (options.fixturesDir === undefined) {
        return {
          id: "IBX-GC-006",
          name: this.name,
          passed: false,
          details: "options.fixturesDir is required for this check",
        };
      }
      const fixtures = await loadGoldenFixtures(
        options.fixturesDir,
        opts.substitutions,
      );
      if (fixtures.length === 0) {
        return {
          id: "IBX-GC-006",
          name: this.name,
          passed: false,
          // Unlike upstream CC-006's vacuous pass, an EMPTY adopter fixture
          // dir is a wiring bug — these fixtures are committed.
          details: `no fixtures discovered at ${options.fixturesDir}`,
        };
      }

      const failures: string[] = [];
      let verified = 0;

      for (const fixture of fixtures) {
        const failure = await verifyFixture(conductor, fixture);
        if (failure !== null) failures.push(failure);
        else verified++;
      }

      if (failures.length > 0) {
        return {
          id: "IBX-GC-006",
          name: this.name,
          passed: false,
          details: `golden-conversation regressions:\n  ${failures.join("\n  ")}`,
        };
      }
      return {
        id: "IBX-GC-006",
        name: this.name,
        passed: true,
        details: `Verified ${verified} golden conversation(s) against the composed conductor.`,
      };
    },
  };
}
