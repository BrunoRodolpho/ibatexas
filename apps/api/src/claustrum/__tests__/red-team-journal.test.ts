// red-team-journal — ERDS-058 durable store seam.
//
// Proves the createPostgresRedTeamJournal upsert/create seam:
//   1. maps a record onto agentRedTeamRun.create (optional fields → null);
//   2. FAIL-OPEN: a prisma throw is swallowed (the suite is never broken).

import { describe, expect, it, vi } from "vitest";
import {
  createPostgresRedTeamJournal,
  type AgentRedTeamPrisma,
  type AgentRedTeamRunRecord,
} from "../red-team-journal.js";

const RUN: AgentRedTeamRunRecord = {
  agentId: "pix-payment-failure-remediation",
  agentVersion: "1.2.0",
  testSuite: "prompt-injection",
  testCase: "ignore-previous-instructions",
  decisionKind: "REFUSE",
  intentKind: "pix.charge.refund",
  modelCalls: 2,
  assertionsPassed: 5,
  at: "2026-06-16T12:00:00.000Z",
};

describe("createPostgresRedTeamJournal", () => {
  it("inserts a row with the record fields", async () => {
    const create = vi.fn(async () => ({ run_id: "x" }));
    const prisma = { agentRedTeamRun: { create } } as unknown as AgentRedTeamPrisma;

    await createPostgresRedTeamJournal(prisma).record(RUN);

    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({
      data: {
        agentId: "pix-payment-failure-remediation",
        agentVersion: "1.2.0",
        testSuite: "prompt-injection",
        testCase: "ignore-previous-instructions",
        decisionKind: "REFUSE",
        intentKind: "pix.charge.refund",
        modelCalls: 2,
        assertionsPassed: 5,
        at: "2026-06-16T12:00:00.000Z",
      },
    });
  });

  it("maps omitted optional fields to null", async () => {
    const create = vi.fn(async () => ({}));
    const prisma = { agentRedTeamRun: { create } } as unknown as AgentRedTeamPrisma;

    await createPostgresRedTeamJournal(prisma).record({
      agentId: "a",
      testSuite: "s",
      testCase: "c",
      decisionKind: "EXECUTE",
      modelCalls: 0,
      at: "2026-06-16T00:00:00.000Z",
    });

    const [arg] = create.mock.calls[0] as unknown as [{ data: Record<string, unknown> }];
    expect(arg.data.agentVersion).toBeNull();
    expect(arg.data.intentKind).toBeNull();
    expect(arg.data.assertionsPassed).toBeNull();
  });

  it("fails open when prisma throws (suite unaffected)", async () => {
    const create = vi.fn(async () => {
      throw new Error("connection refused");
    });
    const prisma = { agentRedTeamRun: { create } } as unknown as AgentRedTeamPrisma;

    await expect(
      createPostgresRedTeamJournal(prisma).record(RUN),
    ).resolves.toBeUndefined();
    expect(create).toHaveBeenCalledTimes(1);
  });
});
