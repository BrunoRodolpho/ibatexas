// Tests for the `ibx staff` OWNER-only staff-administration commands (AUT-038).
// Drives the commander group end-to-end with fetch + the confirm prompt mocked
// (Module System rule: no DB/network — mock everything external). The transport
// is the shared lib/admin-http (no @ibatexas/agents dep), so no heavy mocks.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { Command } from "commander"

// ── Mock external modules (no network, no prompts) ───────────────────────────

const mockFetch = vi.hoisted(() => vi.fn())
vi.stubGlobal("fetch", mockFetch)

const mockConfirm = vi.hoisted(() => vi.fn())
vi.mock("@inquirer/prompts", () => ({ confirm: mockConfirm }))

// ── Import source after mocks ────────────────────────────────────────────────

import {
  registerStaffCommands,
  staffServerMessage,
  staffHttpErrorMessage,
  formatRate,
  printStaffList,
} from "../commands/staff.js"

// ── Helpers ──────────────────────────────────────────────────────────────────

const KEY = "test-admin-key-0000000000000000000000000000"

/** Build a fresh `staff` command group and run it with the given argv tail. */
function run(...args: string[]): Promise<unknown> {
  const program = new Command()
  program.exitOverride()
  const group = new Command("staff")
  group.exitOverride()
  registerStaffCommands(group)
  program.addCommand(group)
  return program.parseAsync(["node", "ibx", "staff", ...args])
}

function jsonResponse(status: number, body: unknown): { status: number; json: () => Promise<unknown> } {
  return { status, json: async () => body }
}

const member = (over: Record<string, unknown> = {}) => ({
  id: "stf_1",
  phone: "+5511999999999",
  name: "Ana",
  role: "ATTENDANT",
  active: true,
  hourlyRateCentavos: 2500,
  ...over,
})

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

// ── staffServerMessage (message-first-then-error) ─────────────────────────────

describe("staffServerMessage", () => {
  it("prefers the pt-BR message over the generic reason phrase", () => {
    expect(
      staffServerMessage({ error: "Forbidden", message: "Acesso restrito ao proprietário." }),
    ).toBe("Acesso restrito ao proprietário.")
  })
  it("uses the error field when there is no message (route-handler shape)", () => {
    expect(staffServerMessage({ error: "Funcionário não encontrado." })).toBe(
      "Funcionário não encontrado.",
    )
  })
  it("returns undefined for missing / empty / non-string bodies", () => {
    expect(staffServerMessage({})).toBeUndefined()
    expect(staffServerMessage(null)).toBeUndefined()
    expect(staffServerMessage({ error: "  ", message: "" })).toBeUndefined()
    expect(staffServerMessage({ message: 3 })).toBeUndefined()
  })
})

describe("staffHttpErrorMessage", () => {
  it("passes through the server pt-BR text for 403 / 404 / 409 / 400", () => {
    expect(staffHttpErrorMessage(403, { message: "Acesso restrito ao proprietário." })).toBe(
      "Acesso restrito ao proprietário.",
    )
    expect(staffHttpErrorMessage(409, { error: 'Já existe um funcionário com o telefone "x".' })).toBe(
      'Já existe um funcionário com o telefone "x".',
    )
  })
  it("uses an English label for 401 (server sends no message)", () => {
    expect(staffHttpErrorMessage(401, { error: "Unauthorized" })).toMatch(/Unauthorized/)
  })
  it("falls back for an unexpected status", () => {
    expect(staffHttpErrorMessage(500, null)).toMatch(/HTTP 500/)
  })
})

describe("formatRate / printStaffList", () => {
  it("formats integer centavos and the null em-dash", () => {
    expect(formatRate(2500)).toBe("R$ 25,00/h")
    expect(formatRate(null)).toBe("—")
  })
  it("renders active / inactive rows and an empty roster", () => {
    printStaffList([member(), member({ id: "stf_2", name: "Bruno", active: false, hourlyRateCentavos: null })])
    const out = logText()
    expect(out).toContain("Ana")
    expect(out).toContain("Bruno")
    expect(out).toContain("active")
    expect(out).toContain("inactive")
    logSpy.mockClear()
    printStaffList([])
    expect(logText()).toMatch(/No staff found/)
  })
})

// ── staff list ────────────────────────────────────────────────────────────────

describe("staff list", () => {
  it("GETs the roster with the x-admin-key header and prints it", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, { staff: [member()], total: 1 }))
    await run("list")
    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [url, init] = mockFetch.mock.calls[0]
    expect(url).toBe("http://localhost:3001/api/admin/staff")
    expect((init as RequestInit).method).toBe("GET")
    expect((init as { headers: Record<string, string> }).headers["x-admin-key"]).toBe(KEY)
    expect(logText()).toContain("Ana")
    expect(process.exitCode).toBe(0)
  })

  it("passes ?role= and ?active= filters", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, { staff: [], total: 0 }))
    await run("list", "--role", "manager", "--active")
    expect(mockFetch.mock.calls[0][0]).toBe("http://localhost:3001/api/admin/staff?role=MANAGER&active=true")
  })

  it("rejects an invalid role filter without a fetch", async () => {
    await run("list", "--role", "boss")
    expect(mockFetch).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(1)
    expect(errText()).toMatch(/Invalid role/)
  })

  it("rejects conflicting --active / --inactive without a fetch", async () => {
    await run("list", "--active", "--inactive")
    expect(mockFetch).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(1)
  })

  it("refuses (exit 1, no fetch) when ADMIN_API_KEY is unset", async () => {
    delete process.env.ADMIN_API_KEY
    await run("list")
    expect(mockFetch).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(1)
    expect(errText()).toMatch(/ADMIN_API_KEY is not set/)
  })

  it("prints the server pt-BR message and exits 1 on a 403", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(403, { statusCode: 403, error: "Forbidden", message: "Acesso restrito ao proprietário." }),
    )
    await run("list")
    expect(process.exitCode).toBe(1)
    expect(errText()).toContain("Acesso restrito ao proprietário")
  })
})

// ── staff update ────────────────────────────────────────────────────────────────

describe("staff update", () => {
  it("PATCHes only the provided fields", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, { staff: member({ name: "Ana Paula" }) }))
    await run("update", "stf_1", "--name", "Ana Paula", "--rate", "3000")
    const [url, init] = mockFetch.mock.calls[0]
    expect(url).toBe("http://localhost:3001/api/admin/staff/stf_1")
    expect((init as RequestInit).method).toBe("PATCH")
    expect(JSON.parse((init as { body: string }).body)).toEqual({ name: "Ana Paula", hourlyRateCentavos: 3000 })
    expect(logText()).toContain("atualizado")
  })

  it("sends hourlyRateCentavos:null for --clear-rate", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, { staff: member({ hourlyRateCentavos: null }) }))
    await run("update", "stf_1", "--clear-rate")
    expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toEqual({ hourlyRateCentavos: null })
  })

  it("refuses when nothing is passed", async () => {
    await run("update", "stf_1")
    expect(mockFetch).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(1)
    expect(errText()).toMatch(/Nothing to update/)
  })

  it("refuses a non-integer / negative rate", async () => {
    await run("update", "stf_1", "--rate", "-5")
    expect(mockFetch).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(1)
  })

  it("refuses conflicting --rate / --clear-rate", async () => {
    await run("update", "stf_1", "--rate", "2500", "--clear-rate")
    expect(mockFetch).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(1)
  })

  it("surfaces the server pt-BR error on a 409 duplicate phone", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(409, { error: 'Já existe um funcionário com o telefone "+5511988888888".' }),
    )
    await run("update", "stf_1", "--phone", "+5511988888888")
    expect(process.exitCode).toBe(1)
    expect(errText()).toContain("Já existe um funcionário")
  })
})

// ── staff deactivate ──────────────────────────────────────────────────────────

describe("staff deactivate", () => {
  it("with -y skips the prompt and POSTs (no body)", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, { staff: member({ active: false }) }))
    await run("deactivate", "stf_1", "-y")
    expect(mockConfirm).not.toHaveBeenCalled()
    const [url, init] = mockFetch.mock.calls[0]
    expect(url).toBe("http://localhost:3001/api/admin/staff/stf_1/deactivate")
    expect((init as RequestInit).method).toBe("POST")
    expect((init as { body?: string }).body).toBeUndefined()
    expect((init as { headers: Record<string, string> }).headers["content-type"]).toBeUndefined()
    expect(logText()).toContain("desativado")
  })

  it("aborts without a fetch when the confirm prompt is declined", async () => {
    mockConfirm.mockResolvedValueOnce(false)
    await run("deactivate", "stf_1")
    expect(mockConfirm).toHaveBeenCalledTimes(1)
    expect(mockFetch).not.toHaveBeenCalled()
    expect(logText()).toMatch(/Aborted/)
  })

  it("surfaces the last-owner refusal (409) honestly", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(409, { error: "Não é possível desativar ou rebaixar o último proprietário ativo." }),
    )
    await run("deactivate", "stf_1", "-y")
    expect(process.exitCode).toBe(1)
    expect(errText()).toContain("último proprietário")
  })
})

// ── staff assign-role ─────────────────────────────────────────────────────────

describe("staff assign-role", () => {
  it("rejects an invalid role without a fetch", async () => {
    await run("assign-role", "stf_1", "boss")
    expect(mockFetch).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(1)
    expect(errText()).toMatch(/Invalid role/)
  })

  it("with -y POSTs the uppercased role", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, { staff: member({ role: "MANAGER" }) }))
    await run("assign-role", "stf_1", "manager", "-y")
    expect(mockConfirm).not.toHaveBeenCalled()
    const [url, init] = mockFetch.mock.calls[0]
    expect(url).toBe("http://localhost:3001/api/admin/staff/stf_1/role")
    expect((init as RequestInit).method).toBe("POST")
    expect(JSON.parse((init as { body: string }).body)).toEqual({ role: "MANAGER" })
    expect(logText()).toContain("cargo alterado para MANAGER")
  })

  it("aborts without a fetch when the confirm prompt is declined", async () => {
    mockConfirm.mockResolvedValueOnce(false)
    await run("assign-role", "stf_1", "OWNER")
    expect(mockConfirm).toHaveBeenCalledTimes(1)
    expect(mockFetch).not.toHaveBeenCalled()
    expect(logText()).toMatch(/Aborted/)
  })
})
