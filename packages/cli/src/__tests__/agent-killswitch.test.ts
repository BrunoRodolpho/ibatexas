// Tests for the `ibx agent` kill-switch operator controls (BKL-120).
// Drives the commander group end-to-end with fetch + the confirm prompt mocked
// (Module System rule: no DB/network — mock everything external).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { Command } from "commander"

// ── Mock external modules (no network, no heavy workspace deps) ──────────────

const mockFetch = vi.hoisted(() => vi.fn())
vi.stubGlobal("fetch", mockFetch)

const mockConfirm = vi.hoisted(() => vi.fn())
vi.mock("@inquirer/prompts", () => ({ confirm: mockConfirm }))
vi.mock("@ibatexas/agents", () => ({ AGENT_REGISTRY: [] }))
vi.mock("@ibatexas/journeys", () => ({ injectPixFailureTrigger: vi.fn() }))

// ── Import source after mocks ────────────────────────────────────────────────

import {
  registerAgentCommands,
  resolveAdminKey,
  serverMessage,
  httpErrorMessage,
  printKillStatus,
} from "../commands/agent.js"

// ── Helpers ──────────────────────────────────────────────────────────────────

const KEY = "test-admin-key-0000000000000000000000000000"

/** Build a fresh `agent` command group and run it with the given argv tail. */
function run(...args: string[]): Promise<unknown> {
  const program = new Command()
  program.exitOverride()
  const group = new Command("agent")
  group.exitOverride()
  registerAgentCommands(group)
  program.addCommand(group)
  return program.parseAsync(["node", "ibx", "agent", ...args])
}

function jsonResponse(status: number, body: unknown): { status: number; json: () => Promise<unknown> } {
  return { status, json: async () => body }
}

let logSpy: ReturnType<typeof vi.spyOn>
let errSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.clearAllMocks()
  process.env.ADMIN_API_KEY = KEY
  process.exitCode = 0
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
})

afterEach(() => {
  logSpy.mockRestore()
  errSpy.mockRestore()
  delete process.env.ADMIN_API_KEY
})

const logText = (): string => logSpy.mock.calls.map((c) => c.join(" ")).join("\n")
const errText = (): string => errSpy.mock.calls.map((c) => c.join(" ")).join("\n")

// ── resolveAdminKey ───────────────────────────────────────────────────────────

describe("resolveAdminKey", () => {
  it("returns the key when set", () => {
    process.env.ADMIN_API_KEY = KEY
    expect(resolveAdminKey()).toBe(KEY)
  })

  it("returns the first non-empty entry of a comma-separated rotation list", () => {
    process.env.ADMIN_API_KEY = ` ${KEY} , second-key `
    expect(resolveAdminKey()).toBe(KEY)
  })

  it("returns null when unset or empty", () => {
    delete process.env.ADMIN_API_KEY
    expect(resolveAdminKey()).toBeNull()
    process.env.ADMIN_API_KEY = "   "
    expect(resolveAdminKey()).toBeNull()
  })
})

// ── message mapping ───────────────────────────────────────────────────────────

describe("serverMessage", () => {
  it("extracts a non-empty message string", () => {
    expect(serverMessage({ message: "boom" })).toBe("boom")
  })
  it("returns undefined for missing/empty/non-string", () => {
    expect(serverMessage({})).toBeUndefined()
    expect(serverMessage(null)).toBeUndefined()
    expect(serverMessage({ message: "" })).toBeUndefined()
    expect(serverMessage({ message: 3 })).toBeUndefined()
  })
})

describe("httpErrorMessage", () => {
  it("passes through the server's pt-BR message for 503/404/403", () => {
    expect(httpErrorMessage(503, { message: "Plano de agentes indisponível." })).toBe(
      "Plano de agentes indisponível.",
    )
    expect(httpErrorMessage(404, { message: 'Agente desconhecido: "x".' })).toBe(
      'Agente desconhecido: "x".',
    )
  })
  it("uses an English label for 401 (server sends no message)", () => {
    expect(httpErrorMessage(401, { error: "Unauthorized" })).toMatch(/Unauthorized/)
  })
  it("falls back for an unexpected status", () => {
    expect(httpErrorMessage(500, null)).toMatch(/HTTP 500/)
  })
})

describe("printKillStatus", () => {
  it("renders KILLED and live badges", () => {
    printKillStatus([
      { agentId: "a", killed: false },
      { agentId: "b", killed: true },
    ])
    const out = logText()
    expect(out).toContain("a")
    expect(out).toContain("b")
    expect(out).toContain("KILLED")
  })
  it("handles an empty roster", () => {
    printKillStatus([])
    expect(logText()).toMatch(/No managed agents/)
  })
})

// ── agent status ──────────────────────────────────────────────────────────────

describe("agent status", () => {
  it("GETs the roster with the x-admin-key header and prints it", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(200, { agents: [{ agentId: "a", killed: false }, { agentId: "b", killed: true }] }),
    )
    await run("status")
    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [url, init] = mockFetch.mock.calls[0]
    expect(url).toBe("http://localhost:3001/api/admin/agents/kill-status")
    expect((init as RequestInit).method).toBe("GET")
    expect((init as { headers: Record<string, string> }).headers["x-admin-key"]).toBe(KEY)
    expect(logText()).toContain("KILLED")
    expect(process.exitCode).toBe(0)
  })

  it("passes ?agentId= when an id is given", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, { agents: [{ agentId: "a", killed: false }] }))
    await run("status", "a")
    expect(mockFetch.mock.calls[0][0]).toBe(
      "http://localhost:3001/api/admin/agents/kill-status?agentId=a",
    )
  })

  it("refuses (exit 1, no fetch) when ADMIN_API_KEY is unset", async () => {
    delete process.env.ADMIN_API_KEY
    await run("status")
    expect(mockFetch).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(1)
    expect(errText()).toMatch(/ADMIN_API_KEY is not set/)
  })

  it("prints the server pt-BR message and exits 1 on 503 plane-off", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(503, { message: "Plano de agentes indisponível (IBX_AGENTS_ENABLED)." }),
    )
    await run("status")
    expect(process.exitCode).toBe(1)
    expect(errText()).toContain("Plano de agentes indisponível")
  })

  it("prints an unreachable-API error and exits 1 when fetch rejects", async () => {
    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"))
    await run("status")
    expect(process.exitCode).toBe(1)
    expect(errText()).toMatch(/Could not reach the API/)
  })
})

// ── agent kill ────────────────────────────────────────────────────────────────

describe("agent kill", () => {
  it("with -y skips the prompt and POSTs to /kill", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, { agentId: "a", killed: true }))
    await run("kill", "a", "-y")
    expect(mockConfirm).not.toHaveBeenCalled()
    const [url, init] = mockFetch.mock.calls[0]
    expect(url).toBe("http://localhost:3001/api/admin/agents/a/kill")
    expect((init as RequestInit).method).toBe("POST")
    expect((init as { headers: Record<string, string> }).headers["x-admin-key"]).toBe(KEY)
    expect(logText()).toContain("KILLED")
    expect(process.exitCode).toBe(0)
  })

  it("aborts without a fetch when the confirm prompt is declined", async () => {
    mockConfirm.mockResolvedValueOnce(false)
    await run("kill", "a")
    expect(mockConfirm).toHaveBeenCalledTimes(1)
    expect(mockFetch).not.toHaveBeenCalled()
    expect(logText()).toMatch(/Aborted/)
  })

  it("proceeds when the confirm prompt is accepted", async () => {
    mockConfirm.mockResolvedValueOnce(true)
    mockFetch.mockResolvedValueOnce(jsonResponse(200, { agentId: "a", killed: true }))
    await run("kill", "a")
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it("attaches the reason as a JSON body with content-type", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, { agentId: "a", killed: true }))
    await run("kill", "a", "--reason", "picanha acabou", "-y")
    const init = mockFetch.mock.calls[0][1] as { headers: Record<string, string>; body?: string }
    expect(init.headers["content-type"]).toBe("application/json")
    expect(JSON.parse(init.body ?? "{}")).toEqual({ reason: "picanha acabou" })
  })

  it("sends no body (and no content-type) without a reason", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, { agentId: "a", killed: true }))
    await run("kill", "a", "-y")
    const init = mockFetch.mock.calls[0][1] as { headers: Record<string, string>; body?: string }
    expect(init.body).toBeUndefined()
    expect(init.headers["content-type"]).toBeUndefined()
  })

  it("prints the server message and exits 1 on a 404 unknown agent", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(404, { message: 'Agente desconhecido: "nope".' }))
    await run("kill", "nope", "-y")
    expect(process.exitCode).toBe(1)
    expect(errText()).toContain("Agente desconhecido")
  })

  it("reports a permission failure on 403", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(403, { message: "Acesso restrito a gerentes — chave de API sem permissão suficiente." }),
    )
    await run("kill", "a", "-y")
    expect(process.exitCode).toBe(1)
    expect(errText()).toContain("Acesso restrito a gerentes")
  })
})

// ── agent restore ─────────────────────────────────────────────────────────────

describe("agent restore", () => {
  it("POSTs to /unkill with no confirmation and reports cleared", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, { agentId: "a", killed: false }))
    await run("restore", "a")
    expect(mockConfirm).not.toHaveBeenCalled()
    const [url, init] = mockFetch.mock.calls[0]
    expect(url).toBe("http://localhost:3001/api/admin/agents/a/unkill")
    expect((init as RequestInit).method).toBe("POST")
    expect(logText()).toContain("cleared")
    expect(process.exitCode).toBe(0)
  })
})
