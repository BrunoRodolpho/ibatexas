// WS-B: qa-control ROUTE HANDLERS behind the gate.
//
// The companion qa-control.test.ts pins the registration GATE (qaControlGate)
// in isolation. This file complements it: with an aligned dev env + a mocked
// filesystem / child-process layer that forces the gate OPEN, it exercises the
// actual handlers the read-only qa-viewer drives — the bearer preHandler, the
// three catalog endpoints, run listing + trace serving, run-body validation,
// and the streamed NDJSON batch runner (spawn is mocked; no real `ibx` is
// ever launched, no real FS is touched).
//
// Every external edge is mocked: node:fs (existsSync), node:fs/promises
// (readdir/readFile/stat), node:child_process (spawn). Nothing hits a real
// disk, process, DB, or network.

import { describe, it, expect, beforeEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { EventEmitter } from "node:events";
import { basename } from "node:path";

// 24-char dev token (>= 16 required by the gate). Not a secret. // gitleaks:allow
const TOKEN = "qa-ctl-secret-token-1234";
const AUTH = { authorization: `Bearer ${TOKEN}` };

// Mutable test state shared with the hoisted module mocks below.
const state = vi.hoisted(() => ({
  runsReaddirCalls: 0,
  runDirsSeq: null as string[][] | null,
  runDirents: [] as Array<{ name: string; isDirectory: () => boolean }>,
  scenarioFiles: [] as string[],
  journeyFiles: [] as string[],
  journeyYaml: {} as Record<string, string>,
  traceContent: "",
  runsDirMissing: false,
  scenariosDirMissing: false,
  spawnCalls: [] as string[][],
  spawnBehavior: null as
    | null
    | ((args: string[]) => { lines?: string[]; code?: number; error?: string }),
  mtimeFor: ((_p: string) => 0) as (p: string) => number,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: (p: unknown) => {
      const path = String(p);
      if (state.runsDirMissing && /[\\/]runs$/.test(path)) return false;
      if (state.scenariosDirMissing && /scenarios$/.test(path)) return false;
      // run dirs whose name carries these markers have no trace.jsonl.
      if (path.includes("RUN-NOTRACE")) return false;
      if (path.includes("RUN-MISSING")) return false;
      return true; // pnpm-workspace.yaml (repo-root probe), IBX_BIN (gate), etc.
    },
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readdir: async (p: unknown) => {
      const path = String(p);
      if (path.endsWith("scenarios")) return state.scenarioFiles as never;
      if (path.includes("journeys")) return state.journeyFiles as never;
      // runs dir (withFileTypes: true) — Dirent-like entries.
      state.runsReaddirCalls += 1;
      if (state.runDirsSeq) {
        const idx = Math.min(state.runsReaddirCalls - 1, state.runDirsSeq.length - 1);
        return state.runDirsSeq[idx]!.map((n) => ({
          name: n,
          isDirectory: () => true,
        })) as never;
      }
      return state.runDirents as never;
    },
    readFile: async (p: unknown) => {
      const path = String(p);
      if (path.endsWith("trace.jsonl")) return state.traceContent as never;
      return (state.journeyYaml[basename(path)] ?? "") as never;
    },
    stat: async (p: unknown) => ({ mtimeMs: state.mtimeFor(String(p)) }) as never,
  };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (_cmd: string, args: string[]) => {
      state.spawnCalls.push(args);
      const behavior = state.spawnBehavior
        ? state.spawnBehavior(args)
        : { lines: ["a\n", "b"], code: 0 };
      const stdout = new EventEmitter();
      const stderr = new EventEmitter();
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
      };
      child.stdout = stdout;
      child.stderr = stderr;
      setImmediate(() => {
        if (behavior.error) {
          child.emit("error", new Error(behavior.error));
          return;
        }
        for (const line of behavior.lines ?? []) {
          stdout.emit("data", Buffer.from(line));
        }
        child.emit("close", behavior.code ?? 0);
      });
      return child as never;
    },
  };
});

import { qaControlRoutes } from "../qa-control.js";

async function build(): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(qaControlRoutes);
  await app.ready();
  return app;
}

/** Parse a hijacked NDJSON streaming reply into framed events. */
function frames(payload: string): Array<Record<string, unknown>> {
  return payload
    .trim()
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

beforeEach(() => {
  vi.unstubAllEnvs();
  // Align the env so qaControlGate() opens (NOT production, flag on, token>=16,
  // ibx-bin existsSync mocked true).
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("IBX_QA_CONTROL_ENABLED", "true");
  vi.stubEnv("IBX_QA_CONTROL_TOKEN", TOKEN);

  state.runsReaddirCalls = 0;
  state.runDirsSeq = null;
  state.runsDirMissing = false;
  state.scenariosDirMissing = false;
  state.spawnCalls.length = 0;
  state.spawnBehavior = null;
  state.traceContent = '{"t":"hello"}\n{"t":"world"}\n';
  state.scenarioFiles = ["sc-smoke.yaml", "sc-edge.yml", "readme.md"];
  state.journeyFiles = ["JOURNEY-A.yaml", "JOURNEY-B.yaml", "JOURNEY-C.yaml", "not-journey.txt"];
  state.journeyYaml = {
    "JOURNEY-A.yaml": `id: "JOURNEY-A"\nstatus: 'active'\n`,
    "JOURNEY-B.yaml": "id: JOURNEY-B\nstatus: draft\n",
    "JOURNEY-C.yaml": "name: no-id-or-status-here\n",
  };
  state.runDirents = [
    { name: "RUN-2", isDirectory: () => true },
    { name: "RUN-1", isDirectory: () => true },
    { name: "RUN-NOTRACE", isDirectory: () => true },
    { name: "afile.txt", isDirectory: () => false },
  ];
  state.mtimeFor = (p: string) => {
    if (p.includes("RUN-NEW")) return 500;
    if (p.includes("RUN-2")) return 200;
    if (p.includes("RUN-1")) return 100;
    return 50;
  };
});

// ── Gate-closed: routes are NOT registered ────────────────────────────────────

describe("qa-control routes — gate CLOSED (fail-closed registration)", () => {
  it("does not register any /internal/qa/* route under production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const app = await build();
    const res = await app.inject({
      method: "GET",
      url: "/internal/qa/journeys",
      headers: AUTH,
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

// ── Bearer preHandler ─────────────────────────────────────────────────────────

describe("qa-control routes — bearer gate", () => {
  it("401s a request with no Authorization header", async () => {
    const app = await build();
    const res = await app.inject({ method: "GET", url: "/internal/qa/journeys" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "Unauthorized" });
    await app.close();
  });

  it("401s a request with a wrong (same-length) bearer token", async () => {
    const app = await build();
    const wrong = `Bearer ${"x".repeat(TOKEN.length)}`;
    const res = await app.inject({
      method: "GET",
      url: "/internal/qa/journeys",
      headers: { authorization: wrong },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("admits a request carrying the exact bearer token", async () => {
    const app = await build();
    const res = await app.inject({
      method: "GET",
      url: "/internal/qa/journeys",
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});

// ── Catalog endpoints ─────────────────────────────────────────────────────────

describe("qa-control routes — catalog", () => {
  it("GET /journeys parses id/status from yaml (quote-stripped + fallbacks)", async () => {
    const app = await build();
    const res = await app.inject({ method: "GET", url: "/internal/qa/journeys", headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json().journeys).toEqual([
      { id: "JOURNEY-A", status: "active" }, // quotes stripped from id + status
      { id: "JOURNEY-B", status: "draft" },
      { id: "JOURNEY-C", status: "unknown" }, // no id line → filename; no status → "unknown"
    ]);
    await app.close();
  });

  it("GET /scenarios lists only *.yaml|*.yml (sans extension)", async () => {
    const app = await build();
    const res = await app.inject({ method: "GET", url: "/internal/qa/scenarios", headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json().scenarios).toEqual([{ name: "sc-edge" }, { name: "sc-smoke" }]);
    await app.close();
  });

  it("GET /scenarios returns [] when the scenarios dir is absent", async () => {
    state.scenariosDirMissing = true;
    const app = await build();
    const res = await app.inject({ method: "GET", url: "/internal/qa/scenarios", headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json().scenarios).toEqual([]);
    await app.close();
  });

  it("GET /agents projects the registry (id, displayName, subjects)", async () => {
    const app = await build();
    const res = await app.inject({ method: "GET", url: "/internal/qa/agents", headers: AUTH });
    expect(res.statusCode).toBe(200);
    const agents = res.json().agents as Array<{ id: string; subjects: string[] }>;
    const pix = agents.find((a) => a.id === "pix-payment-failure-remediation");
    expect(pix).toBeDefined();
    expect(pix?.subjects).toContain("payment.status_changed");
    await app.close();
  });
});

// ── Run listing + trace serving ───────────────────────────────────────────────

describe("qa-control routes — runs listing + trace", () => {
  it("GET /runs filters non-dirs, marks hasTrace, sorts newest-first", async () => {
    const app = await build();
    const res = await app.inject({ method: "GET", url: "/internal/qa/runs", headers: AUTH });
    expect(res.statusCode).toBe(200);
    const runs = res.json().runs as Array<{ id: string; hasTrace: boolean; mtime: number }>;
    expect(runs.map((r) => r.id)).toEqual(["RUN-2", "RUN-1", "RUN-NOTRACE"]); // afile.txt dropped
    expect(runs.map((r) => r.hasTrace)).toEqual([true, true, false]);
    expect(runs[2]!.mtime).toBe(0); // no trace ⇒ mtime 0
    await app.close();
  });

  it("GET /runs returns [] when the runs dir is absent", async () => {
    state.runsDirMissing = true;
    const app = await build();
    const res = await app.inject({ method: "GET", url: "/internal/qa/runs", headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json().runs).toEqual([]);
    await app.close();
  });

  it("GET /runs/:id/trace serves the NDJSON trace for a valid id", async () => {
    const app = await build();
    const res = await app.inject({
      method: "GET",
      url: "/internal/qa/runs/RUN-OK/trace",
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/x-ndjson");
    expect(res.payload).toBe(state.traceContent);
    await app.close();
  });

  it("GET /runs/:id/trace 400s a path-traversal / invalid id", async () => {
    const app = await build();
    const res = await app.inject({
      method: "GET",
      url: "/internal/qa/runs/..%2Fetc/trace",
      headers: AUTH,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "invalid run id" });
    await app.close();
  });

  it("GET /runs/:id/trace 404s when the trace file is missing", async () => {
    const app = await build();
    const res = await app.inject({
      method: "GET",
      url: "/internal/qa/runs/RUN-MISSING/trace",
      headers: AUTH,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "trace not found" });
    await app.close();
  });
});

// ── Run-body validation (no spawn) ────────────────────────────────────────────

describe("qa-control routes — POST /run validation", () => {
  it("400s a body with unknown keys (strict schema)", async () => {
    const app = await build();
    const res = await app.inject({
      method: "POST",
      url: "/internal/qa/run",
      headers: AUTH,
      payload: { bogus: true },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid run body");
    expect(state.spawnCalls).toHaveLength(0);
    await app.close();
  });

  it("400s when no items resolve", async () => {
    const app = await build();
    const res = await app.inject({
      method: "POST",
      url: "/internal/qa/run",
      headers: AUTH,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "no items to run" });
    expect(state.spawnCalls).toHaveLength(0);
    await app.close();
  });

  it("400s an explicit item whose id is absent from the live catalog", async () => {
    const app = await build();
    const res = await app.inject({
      method: "POST",
      url: "/internal/qa/run",
      headers: AUTH,
      payload: { items: [{ kind: "journey", id: "JOURNEY-DOES-NOT-EXIST" }] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("unknown journey id: JOURNEY-DOES-NOT-EXIST");
    expect(state.spawnCalls).toHaveLength(0); // refused BEFORE any spawn
    await app.close();
  });
});

// ── Streamed batch runner ─────────────────────────────────────────────────────

describe("qa-control routes — streamed batch runner", () => {
  it("POST /lint streams a single command and reflects a localhost Origin", async () => {
    const app = await build();
    const res = await app.inject({
      method: "POST",
      url: "/internal/qa/lint",
      headers: { ...AUTH, origin: "http://localhost:3010" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/x-ndjson");
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:3010");

    const evs = frames(res.payload);
    expect(evs[0]).toEqual({ type: "batch.start", total: 1 });
    expect(evs.at(-1)).toEqual({ type: "batch.end" });
    // the command argv reached spawn as the operator would type it.
    expect(state.spawnCalls[0]!.slice(1)).toEqual(["journey", "lint", "--json"]);
    // both buffered + newline-split lines surfaced as log frames.
    const logs = evs.filter((e) => e.type === "log").map((e) => e.line);
    expect(logs).toEqual(["a", "b"]);
    const end = evs.find((e) => e.type === "item.end")!;
    expect(end.status).toBe("pass");
    expect(end.exitCode).toBe(0);
    await app.close();
  });

  it("POST /graph-export streams the graph export command", async () => {
    const app = await build();
    const res = await app.inject({ method: "POST", url: "/internal/qa/graph-export", headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(state.spawnCalls[0]!.slice(1)).toEqual(["graph", "export"]);
    await app.close();
  });

  it("POST /run (explicit scenario) translates to `scenario run <id>` and passes", async () => {
    const app = await build();
    const res = await app.inject({
      method: "POST",
      url: "/internal/qa/run",
      headers: AUTH,
      payload: { items: [{ kind: "scenario", id: "sc-smoke" }] },
    });
    expect(res.statusCode).toBe(200);
    expect(state.spawnCalls[0]!.slice(1)).toEqual(["scenario", "run", "sc-smoke"]);
    const evs = frames(res.payload);
    expect(evs.find((e) => e.type === "item.start")).toMatchObject({
      kind: "scenario",
      id: "sc-smoke",
      label: "scenario:sc-smoke",
    });
    expect(evs.find((e) => e.type === "item.end")).toMatchObject({ status: "pass", exitCode: 0 });
    await app.close();
  });

  it("POST /run (explicit agent) forwards --order / --status flags", async () => {
    const app = await build();
    const res = await app.inject({
      method: "POST",
      url: "/internal/qa/run",
      headers: AUTH,
      payload: {
        items: [
          {
            kind: "agent",
            id: "pix-payment-failure-remediation",
            orderId: "ord_1",
            status: "failed",
          },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(state.spawnCalls[0]!.slice(1)).toEqual([
      "agent",
      "trigger",
      "pix-payment-failure-remediation",
      "--order",
      "ord_1",
      "--status",
      "failed",
    ]);
    await app.close();
  });

  it("POST /run (all:agents) expands the catalog without per-item validation", async () => {
    const app = await build();
    const res = await app.inject({
      method: "POST",
      url: "/internal/qa/run",
      headers: AUTH,
      payload: { all: "agents" },
    });
    expect(res.statusCode).toBe(200);
    expect(state.spawnCalls[0]!.slice(1)).toEqual([
      "agent",
      "trigger",
      "pix-payment-failure-remediation",
    ]);
    await app.close();
  });

  it("POST /run (all:scenarios) expands every catalog scenario into a `scenario run`", async () => {
    const app = await build();
    const res = await app.inject({
      method: "POST",
      url: "/internal/qa/run",
      headers: AUTH,
      payload: { all: "scenarios" },
    });
    expect(res.statusCode).toBe(200);
    expect(state.spawnCalls.map((c) => c.slice(1))).toEqual([
      ["scenario", "run", "sc-edge"],
      ["scenario", "run", "sc-smoke"],
    ]);
    const ends = frames(res.payload).filter((e) => e.type === "item.end");
    expect(ends).toHaveLength(2);
    expect(ends.every((e) => e.status === "pass")).toBe(true);
    await app.close();
  });

  it("POST /run (all:journeys) runs only ACTIVE journeys and attaches a fresh runId", async () => {
    // before-spawn dir set vs after-spawn set: the NEW dir is the trace owner.
    state.runDirsSeq = [["RUN-OLD"], ["RUN-OLD", "RUN-NEW"]];
    const app = await build();
    const res = await app.inject({
      method: "POST",
      url: "/internal/qa/run",
      headers: AUTH,
      payload: { all: "journeys" },
    });
    expect(res.statusCode).toBe(200);
    // Only JOURNEY-A is active; B (draft) and C (unknown) are excluded.
    expect(state.spawnCalls).toHaveLength(1);
    expect(state.spawnCalls[0]!.slice(1)).toEqual(["journey", "run", "JOURNEY-A", "--k", "1"]);
    const evs = frames(res.payload);
    const end = evs.find((e) => e.type === "item.end")!;
    expect(end.kind).toBe("journey");
    expect(end.runId).toBe("RUN-NEW"); // freshest dir absent from the before-set
    await app.close();
  });

  it("POST /run honours an explicit journey k and marks a non-zero exit as fail", async () => {
    state.spawnBehavior = () => ({ lines: ["boom\n"], code: 2 });
    const app = await build();
    const res = await app.inject({
      method: "POST",
      url: "/internal/qa/run",
      headers: AUTH,
      payload: { items: [{ kind: "journey", id: "JOURNEY-A", k: 3 }] },
    });
    expect(res.statusCode).toBe(200);
    expect(state.spawnCalls[0]!.slice(1)).toEqual(["journey", "run", "JOURNEY-A", "--k", "3"]);
    const end = frames(res.payload).find((e) => e.type === "item.end")!;
    expect(end.status).toBe("fail");
    expect(end.exitCode).toBe(2);
    await app.close();
  });

  it("POST /lint surfaces a spawn error as a log frame and a failed item", async () => {
    state.spawnBehavior = () => ({ error: "ENOENT ibx not built" });
    const app = await build();
    const res = await app.inject({ method: "POST", url: "/internal/qa/lint", headers: AUTH });
    expect(res.statusCode).toBe(200);
    const evs = frames(res.payload);
    const log = evs.find((e) => e.type === "log");
    expect(log!.line).toContain("[spawn error] ENOENT ibx not built");
    const end = evs.find((e) => e.type === "item.end")!;
    expect(end.status).toBe("fail");
    expect(end.exitCode).toBe(1);
    await app.close();
  });
});
