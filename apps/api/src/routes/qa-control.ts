// QA-control routes (WS-B) — DEV-ONLY harness driver for the qa-viewer.
//
// Lets the read-only qa-viewer (:3010) drive the journey/scenario/agent
// pipeline and stream a live run, instead of the operator shelling out to
// `ibx`. HARD-GATED on three axes so it can never exist in production:
//
//   1. NODE_ENV must NOT be "production"        (registration is skipped)
//   2. IBX_QA_CONTROL_ENABLED must be truthy    (registration is skipped)
//   3. every request carries `Authorization: Bearer ${IBX_QA_CONTROL_TOKEN}`
//      (timing-safe compare; refused without a >=16 char token configured)
//
// It spawns the SAME `ibx` binary the operator runs (parity + env isolation)
// as a child process, and streams its stdout/stderr back as NDJSON the viewer
// consumes with fetch()+ReadableStream (EventSource can't send the bearer
// header). The viewer is cross-origin (:3010 → :3001); in dev the global CORS
// plugin already allows localhost:* for the JSON routes, and the streaming
// route (which hijacks the reply, bypassing that plugin) reflects a localhost
// Origin itself. No cookies are involved — bearer only.

import { spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { parseBoolEnv } from "@ibatexas/types";
import { AGENT_REGISTRY } from "@ibatexas/agents";
import { registerRcaReadRoutes } from "./qa-rca.js";
import { registerPromptRoutes } from "./qa-prompts.js";

/** Streaming routes hijack the reply (bypassing the CORS plugin); they reflect
 *  a localhost Origin themselves. This matches `http://localhost[:port]` only. */
const LOCALHOST_ORIGIN = /^http:\/\/localhost(:\d+)?$/;

const RUN_KINDS = ["journey", "scenario", "agent"] as const;
type RunKind = (typeof RUN_KINDS)[number];

/** A single run request. `id` is validated against the live catalog before any
 *  child process is spawned (see the /internal/qa/run handler). */
const RunItemSchema = z
  .object({
    kind: z.enum(RUN_KINDS),
    id: z.string().min(1),
    k: z.number().int().positive().max(20).optional(),
    // agent-only: the entity the injected PIX-failure trigger targets.
    orderId: z.string().min(1).optional(),
    paymentId: z.string().min(1).optional(),
    status: z.enum(["failed", "expired"]).optional(),
  })
  .strict();
type RunItem = z.infer<typeof RunItemSchema>;

const RunBodySchema = z
  .object({
    items: z.array(RunItemSchema).max(100).optional(),
    all: z.enum(["journeys", "scenarios", "agents"]).optional(),
  })
  .strict();

// ── Repo-root + ibx resolution (independent of cwd) ───────────────────────────

function findRepoRoot(): string {
  const override = process.env.IBX_REPO_ROOT;
  if (override && existsSync(join(override, "pnpm-workspace.yaml"))) return override;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

const REPO_ROOT = findRepoRoot();
const IBX_BIN = join(REPO_ROOT, "packages", "cli", "dist", "index.js");
const RUNS_DIR = join(REPO_ROOT, "runs");
const JOURNEYS_DIR = join(REPO_ROOT, "packages", "journeys", "journeys");
const SCENARIOS_DIR = join(REPO_ROOT, "packages", "cli", "scenarios");

/**
 * The hard gate for the qa-control surface, as a pure call-time check so it is
 * unit-testable (mirrors auth.ts `devOtpBypass`). ENABLED only when ALL hold:
 * NOT production, IBX_QA_CONTROL_ENABLED truthy, IBX_QA_CONTROL_TOKEN >= 16
 * chars, and the ibx binary is built. Any failure ⇒ routes are not registered.
 */
export function qaControlGate(): {
  ok: boolean;
  reason?: "production" | "disabled" | "token" | "no-ibx-bin";
} {
  if (process.env.NODE_ENV === "production") return { ok: false, reason: "production" };
  if (!parseBoolEnv(process.env.IBX_QA_CONTROL_ENABLED, false)) return { ok: false, reason: "disabled" };
  if ((process.env.IBX_QA_CONTROL_TOKEN ?? "").length < 16) return { ok: false, reason: "token" };
  if (!existsSync(IBX_BIN)) return { ok: false, reason: "no-ibx-bin" };
  return { ok: true };
}

// ── Catalog helpers (filesystem / registry — never imports @ibatexas/journeys) ─

function stripQuotes(s: string): string {
  return s.replace(/^['"]|['"]$/g, "").trim();
}

async function listJourneys(): Promise<Array<{ id: string; status: string }>> {
  const files = (await readdir(JOURNEYS_DIR))
    .filter((f) => /^JOURNEY-.*\.ya?ml$/.test(f))
    .sort((a, b) => a.localeCompare(b));
  const out: Array<{ id: string; status: string }> = [];
  for (const f of files) {
    const raw = await readFile(join(JOURNEYS_DIR, f), "utf-8");
    // `\s*(\S.*)` (not `\s*(.+)`) keeps the match linear — the `\S` boundary
    // removes the whitespace/`.` overlap that flags as super-linear backtracking.
    const id = stripQuotes(/^id:\s*(\S.*)$/m.exec(raw)?.[1] ?? f.replace(/\.ya?ml$/, ""));
    const status = stripQuotes(/^status:\s*(\S.*)$/m.exec(raw)?.[1] ?? "unknown");
    out.push({ id, status });
  }
  return out;
}

async function listScenarios(): Promise<Array<{ name: string }>> {
  if (!existsSync(SCENARIOS_DIR)) return [];
  return (await readdir(SCENARIOS_DIR))
    .filter((f) => /\.ya?ml$/.test(f))
    .sort((a, b) => a.localeCompare(b))
    .map((f) => ({ name: f.replace(/\.ya?ml$/, "") }));
}

function listAgents(): Array<{ id: string; displayName: string; subjects: string[] }> {
  return AGENT_REGISTRY.map((a) => ({
    id: a.id,
    displayName: a.displayName,
    subjects: [...a.trigger.subjects],
  }));
}

async function listRunDirs(): Promise<Set<string>> {
  if (!existsSync(RUNS_DIR)) return new Set();
  const entries = await readdir(RUNS_DIR, { withFileTypes: true });
  return new Set(entries.filter((e) => e.isDirectory()).map((e) => e.name));
}

// ── Child-process streaming ───────────────────────────────────────────────────

/** Translate a run item into the `ibx` argv the operator would type. */
function argvFor(item: RunItem): string[] {
  switch (item.kind) {
    case "journey":
      return ["journey", "run", item.id, "--k", String(item.k ?? 1)];
    case "scenario":
      return ["scenario", "run", item.id];
    case "agent":
      return [
        "agent",
        "trigger",
        item.id,
        ...(item.orderId ? ["--order", item.orderId] : []),
        ...(item.paymentId ? ["--payment", item.paymentId] : []),
        ...(item.status ? ["--status", item.status] : []),
      ];
  }
}

/**
 * Spawn `ibx <args>`, forwarding stdout/stderr line-by-line to `onLine`.
 * Resolves with the exit code (non-zero = failure). Inherits the SUT env so
 * the harness sees the same test-stack credentials apps/api booted with.
 */
function spawnIbx(args: string[], onLine: (line: string) => void): Promise<number> {
  return new Promise((resolveExit) => {
    const child = spawn(process.execPath, [IBX_BIN, ...args], {
      cwd: REPO_ROOT,
      env: process.env,
    });
    let buf = "";
    const onData = (chunk: Buffer) => {
      buf += chunk.toString("utf-8");
      let nl = buf.indexOf("\n");
      while (nl !== -1) {
        onLine(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        nl = buf.indexOf("\n");
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", (err) => {
      onLine(`[spawn error] ${err.message}`);
      resolveExit(1);
    });
    child.on("close", (code) => {
      if (buf.length > 0) onLine(buf);
      resolveExit(code ?? 1);
    });
  });
}

/** NDJSON event frame writer over the hijacked raw response. */
function frame(reply: FastifyReply, event: Record<string, unknown>): void {
  reply.raw.write(`${JSON.stringify(event)}\n`);
}

// ── Run-item resolution + validation (catalog-derived) ────────────────────────

/** Expand an `all:*` selector into the trusted, catalog-derived run list. */
async function resolveAllItems(
  all: "journeys" | "scenarios" | "agents",
): Promise<RunItem[]> {
  if (all === "journeys") {
    return (await listJourneys())
      .filter((j) => j.status === "active")
      .map((j): RunItem => ({ kind: "journey", id: j.id }));
  }
  if (all === "scenarios") {
    return (await listScenarios()).map((s): RunItem => ({ kind: "scenario", id: s.name }));
  }
  return listAgents().map((a): RunItem => ({ kind: "agent", id: a.id }));
}

/** Validate caller-supplied items against the live catalog. Returns the first
 *  item whose id is absent from its kind's catalog, or null when all resolve. */
async function findUnknownItem(items: RunItem[]): Promise<RunItem | null> {
  const idsByKind: Record<RunKind, Set<string>> = {
    journey: new Set((await listJourneys()).map((j) => j.id)),
    scenario: new Set((await listScenarios()).map((s) => s.name)),
    agent: new Set(listAgents().map((a) => a.id)),
  };
  return items.find((it) => !idsByKind[it.kind].has(it.id)) ?? null;
}

// ── Plugin ────────────────────────────────────────────────────────────────────

export async function qaControlRoutes(server: FastifyInstance): Promise<void> {
  const gate = qaControlGate();
  if (!gate.ok) {
    server.log.info(
      { reason: gate.reason },
      "[qa-control] routes NOT registered (disabled / fail-closed)",
    );
    return;
  }
  const token = process.env.IBX_QA_CONTROL_TOKEN ?? "";
  server.log.warn({ repoRoot: REPO_ROOT }, "[qa-control] DEV harness-control routes ENABLED");

  const expected = Buffer.from(`Bearer ${token}`);

  // Bearer gate on every QA-control request (timing-safe). OPTIONS preflight is
  // handled by the global CORS plugin and never reaches this hook.
  server.addHook("preHandler", async (request, reply) => {
    if (!request.url.startsWith("/internal/qa/")) return;
    const auth = request.headers["authorization"];
    const got = Buffer.from(typeof auth === "string" ? auth : "");
    if (got.length !== expected.length || !timingSafeEqual(got, expected)) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
  });

  // Every route does filesystem access (and the run routes spawn processes), so
  // bound them with the global @fastify/rate-limit (registerRateLimit, server.ts)
  // via explicit per-route config — generous for a single-operator dev surface.
  const RL = { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } } as const;

  // ── Catalog (feeds the viewer's three run pickers) ──────────────────────────
  server.get("/internal/qa/journeys", RL, async () => ({ journeys: await listJourneys() }));
  server.get("/internal/qa/scenarios", RL, async () => ({ scenarios: await listScenarios() }));
  server.get("/internal/qa/agents", RL, async () => ({ agents: listAgents() }));

  // ── RCA turn-forensics reads + Prompt navigate/edit (share this gate+bearer) ─
  registerRcaReadRoutes(server);
  registerPromptRoutes(server, RL);

  // ── Run list + trace serving ────────────────────────────────────────────────
  server.get("/internal/qa/runs", RL, async () => {
    if (!existsSync(RUNS_DIR)) return { runs: [] };
    const entries = await readdir(RUNS_DIR, { withFileTypes: true });
    const runs = await Promise.all(
      entries
        .filter((e) => e.isDirectory())
        .map(async (e) => {
          const tracePath = join(RUNS_DIR, e.name, "trace.jsonl");
          const hasTrace = existsSync(tracePath);
          const mtime = hasTrace ? (await stat(tracePath)).mtimeMs : 0;
          return { id: e.name, hasTrace, mtime };
        }),
    );
    runs.sort((a, b) => b.mtime - a.mtime);
    return { runs };
  });

  server.get<{ Params: { id: string } }>("/internal/qa/runs/:id/trace", RL, async (request, reply) => {
    const { id } = request.params;
    if (!/^[A-Za-z0-9_-]+$/.test(id)) {
      return reply.code(400).send({ error: "invalid run id" });
    }
    const tracePath = join(RUNS_DIR, id, "trace.jsonl");
    if (resolve(tracePath) !== tracePath || !existsSync(tracePath)) {
      return reply.code(404).send({ error: "trace not found" });
    }
    reply.header("Content-Type", "application/x-ndjson");
    return reply.send(await readFile(tracePath, "utf-8"));
  });

  // ── Lint / graph-export (single streamed command) ───────────────────────────
  server.post("/internal/qa/lint", RL, async (request, reply) =>
    streamBatch(request, reply, [{ kind: "command", args: ["journey", "lint", "--json"], label: "lint" }]),
  );
  server.post("/internal/qa/graph-export", RL, async (request, reply) =>
    streamBatch(request, reply, [{ kind: "command", args: ["graph", "export"], label: "graph export" }]),
  );

  // ── Batch run (journeys / scenarios / agents — one, many, or all) ───────────
  server.post("/internal/qa/run", RL, async (request, reply) => {
    const parsed = RunBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid run body", detail: parsed.error.issues });
    }
    const body = parsed.data;

    const items =
      body.all === undefined ? (body.items ?? []) : await resolveAllItems(body.all);
    if (items.length === 0) {
      return reply.code(400).send({ error: "no items to run" });
    }

    // The `all:*` paths are catalog-derived and trusted. Explicit items carry
    // caller-supplied ids — validate each against the live catalog BEFORE any
    // child process is spawned, rather than passing an unknown id through to
    // the `ibx` argv (defense-in-depth behind the dev gate + bearer).
    if (body.all === undefined) {
      const unknownItem = await findUnknownItem(items);
      if (unknownItem !== null) {
        return reply
          .code(400)
          .send({ error: `unknown ${unknownItem.kind} id: ${unknownItem.id}` });
      }
    }

    const work = items.map((it) => ({
      kind: it.kind,
      id: it.id,
      args: argvFor(it),
      label: `${it.kind}:${it.id}`,
    }));
    return streamBatch(request, reply, work);
  });
}

// ── Shared streamed-batch runner ──────────────────────────────────────────────

interface BatchUnit {
  kind: RunKind | "command";
  id?: string;
  args: string[];
  label: string;
}

// `ibx journey run` prints `runId=<id>` per attempt (renderSingleReport in
// packages/cli/src/commands/journey.ts); the trace dir is runs/<runId>/ (== the
// randomUUID the runner emits, run-journey-cli.ts). Capturing the id from THIS
// child's own stdout attributes the trace to exactly this invocation — a
// before/after directory diff cross-attributes concurrent /internal/qa/run
// requests (both see each other's fresh dirs). Matches the run-id charset the
// trace-serving route accepts. Last match wins (the newest --k attempt).
const RUN_ID_LINE_RE = /\brunId=([A-Za-z0-9_-]+)/g;
function extractRunId(line: string): string | undefined {
  let runId: string | undefined;
  for (const m of line.matchAll(RUN_ID_LINE_RE)) runId = m[1];
  return runId;
}

/** Fallback only: after a journey run, the freshly-created runs/<id>/ dir holds
 *  its trace. Returns the newest dir absent from `before`, or undefined when none
 *  appeared. NOTE: not concurrency-safe (a sibling run's dir can leak in) — used
 *  solely when stdout `runId=` capture found nothing. */
async function freshestRunId(before: Set<string>): Promise<string | undefined> {
  const after = await listRunDirs();
  const fresh = [...after].filter((d) => !before.has(d));
  if (fresh.length === 0) return undefined;
  const withMtime = await Promise.all(
    fresh.map(async (d) => {
      const tracePath = join(RUNS_DIR, d, "trace.jsonl");
      const mtime = existsSync(tracePath) ? (await stat(tracePath)).mtimeMs : 0;
      return { d, mtime };
    }),
  );
  withMtime.sort((a, b) => b.mtime - a.mtime);
  return withMtime[0]?.d;
}

async function streamBatch(
  request: FastifyRequest,
  reply: FastifyReply,
  units: BatchUnit[],
): Promise<void> {
  reply.hijack();
  const origin = request.headers.origin;
  if (typeof origin === "string" && LOCALHOST_ORIGIN.test(origin)) {
    reply.raw.setHeader("Access-Control-Allow-Origin", origin);
    reply.raw.setHeader("Vary", "Origin");
  }
  reply.raw.setHeader("Content-Type", "application/x-ndjson");
  reply.raw.setHeader("Cache-Control", "no-cache");
  reply.raw.setHeader("X-Accel-Buffering", "no");
  reply.raw.flushHeaders();

  frame(reply, { type: "batch.start", total: units.length });

  for (let index = 0; index < units.length; index++) {
    const unit = units[index];
    if (unit === undefined) continue;
    frame(reply, { type: "item.start", index, kind: unit.kind, id: unit.id, label: unit.label });

    const before = unit.kind === "journey" ? await listRunDirs() : new Set<string>();
    // Capture the runId straight from THIS child's stdout so concurrent runs
    // never cross-attribute each other's traces (a directory diff would).
    let capturedRunId: string | undefined;
    const exitCode = await spawnIbx(unit.args, (line) => {
      if (unit.kind === "journey") {
        const id = extractRunId(line);
        if (id !== undefined) capturedRunId = id;
      }
      frame(reply, { type: "log", index, line });
    });

    // Prefer the id this run printed; fall back to the (non-concurrency-safe)
    // directory diff only if the run emitted no runId line.
    const runId =
      unit.kind === "journey"
        ? (capturedRunId ?? (await freshestRunId(before)))
        : undefined;

    frame(reply, {
      type: "item.end",
      index,
      kind: unit.kind,
      id: unit.id,
      label: unit.label,
      status: exitCode === 0 ? "pass" : "fail",
      exitCode,
      ...(runId ? { runId } : {}),
    });
  }

  frame(reply, { type: "batch.end" });
  reply.raw.end();
}
