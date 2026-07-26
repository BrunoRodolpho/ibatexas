// Tests for add_order_note tool
// Mock-based; no database or NATS required.
//
// ── BKL-242 — the tool is DISPATCH-ONLY and must NOT re-adjudicate ────────
//
// This tool's only caller is the claustrum tool registry, which dispatches it on
// a kernel EXECUTE the Conductor already adjudicated and ledger-claimed.
// Pre-fix it minted a second `order.note.add` envelope and ran
// `addNoteFromEnvelope` again — an AUDIT-BLIND second decision, because
// `createOrderCommandService()` is called here with no auditSink. The live proof
// is a MISSING row rather than a duplicated one: conductor EXECUTE
// `intent_audit` 5278, the note row written 9ms later, and no second audit row
// anywhere. An inner REFUSE would have silently contradicted the audited EXECUTE
// with nothing in the trail to show for it.
//
// So `addNoteFromEnvelope` is mocked here purely as a TRIPWIRE: every arm
// asserts it was never called. The write now goes through
// `OrderCommandService.writeAdjudicatedNote`, the post-decision persistence body
// extracted for exactly this caller shape in BKL-083b.
//
// Scenarios:
// - Auth check: throws when no customerId
// - Content-length guard at the tool boundary
// - Ownership guard: a foreign order is "not found", never written to
// - `canPerformAction` fulfillment gate (canceled orders refuse notes)
// - Happy path: persists via writeAdjudicatedNote, publishes NATS, NEVER
//   re-adjudicates

import { describe, it, expect, beforeEach, vi } from "vitest"
import { Channel } from "@ibatexas/types"
import type { AgentContext } from "@ibatexas/types"
import { addOrderNote } from "../add-order-note.js"

// -- Hoisted mocks ────────────────────────────────────────────────────────────

const mockGetById = vi.hoisted(() => vi.fn())
/**
 * BKL-242 tripwire. The tool must never call this again: it is the
 * second-adjudication path. Kept on the mocked service (rather than deleted) so
 * a regression calls a REAL spy we assert on, instead of dying on
 * `not a function` — a failure mode that reads like a mock gap, not a defect.
 */
const mockAddNoteFromEnvelope = vi.hoisted(() => vi.fn())
const mockWriteAdjudicatedNote = vi.hoisted(() => vi.fn())
const mockPublishNatsEvent = vi.hoisted(() => vi.fn())

vi.mock("@ibatexas/domain", () => ({
  createOrderQueryService: () => ({ getById: mockGetById }),
  createOrderCommandService: () => ({
    addNoteFromEnvelope: mockAddNoteFromEnvelope,
    writeAdjudicatedNote: mockWriteAdjudicatedNote,
  }),
}))

vi.mock("@ibatexas/nats-client", () => ({
  publishNatsEvent: mockPublishNatsEvent,
}))

// -- Fixtures ─────────────────────────────────────────────────────────────────

const CTX_AUTH = {
  customerId: "cus_01",
  channel: Channel.WhatsApp,
  sessionId: "sess_01",
  userType: "customer" as const,
}

const CTX_GUEST = {
  channel: Channel.Web,
  sessionId: "sess_02",
  userType: "guest" as const,
}

const ORDER = {
  id: "order_01",
  customerId: "cus_01",
  fulfillmentStatus: "preparing",
  paymentStatus: "paid",
  paymentMethod: "pix",
  totalInCentavos: 8900,
}

const VALID_INPUT = { orderId: "order_01", content: "Sem cebola, por favor." }

// -- Tests ────────────────────────────────────────────────────────────────────

describe("addOrderNote", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetById.mockResolvedValue(ORDER)
    mockWriteAdjudicatedNote.mockResolvedValue({ noteId: "note_01" })
    mockPublishNatsEvent.mockResolvedValue(undefined)
  })

  // ── Tool-boundary guards (unchanged by BKL-242) ─────────────────────────

  it("throws when customerId is missing", async () => {
    await expect(
      addOrderNote(VALID_INPUT, CTX_GUEST as AgentContext),
    ).rejects.toThrow("Autenticação necessária")
    expect(mockWriteAdjudicatedNote).not.toHaveBeenCalled()
  })

  it("refuses empty content without touching the order", async () => {
    const result = await addOrderNote({ orderId: "order_01", content: "" }, CTX_AUTH)

    expect(result.success).toBe(false)
    expect(result.message).toContain("entre 1 e 500")
    expect(mockGetById).not.toHaveBeenCalled()
    expect(mockWriteAdjudicatedNote).not.toHaveBeenCalled()
  })

  it("refuses content over 500 characters", async () => {
    const result = await addOrderNote(
      { orderId: "order_01", content: "a".repeat(501) },
      CTX_AUTH,
    )

    expect(result.success).toBe(false)
    expect(result.message).toContain("entre 1 e 500")
    expect(mockWriteAdjudicatedNote).not.toHaveBeenCalled()
  })

  it("reports a foreign order as not found and never writes to it", async () => {
    mockGetById.mockResolvedValue({ ...ORDER, customerId: "cus_OTHER" })

    const result = await addOrderNote(VALID_INPUT, CTX_AUTH)

    expect(result.success).toBe(false)
    expect(result.message).toBe("Pedido não encontrado.")
    expect(mockWriteAdjudicatedNote).not.toHaveBeenCalled()
    expect(mockAddNoteFromEnvelope).not.toHaveBeenCalled()
  })

  it("reports a missing order as not found", async () => {
    mockGetById.mockResolvedValue(null)

    const result = await addOrderNote(VALID_INPUT, CTX_AUTH)

    expect(result.success).toBe(false)
    expect(result.message).toBe("Pedido não encontrado.")
    expect(mockWriteAdjudicatedNote).not.toHaveBeenCalled()
  })

  it("honours the canPerformAction fulfillment gate (no notes on a canceled order)", async () => {
    mockGetById.mockResolvedValue({ ...ORDER, fulfillmentStatus: "canceled" })

    const result = await addOrderNote(VALID_INPUT, CTX_AUTH)

    expect(result.success).toBe(false)
    expect(mockWriteAdjudicatedNote).not.toHaveBeenCalled()
    expect(mockAddNoteFromEnvelope).not.toHaveBeenCalled()
  })

  // ── BKL-242 — no second adjudication on the dispatch path ──────────────

  it("persists via writeAdjudicatedNote and NEVER re-adjudicates", async () => {
    const result = await addOrderNote(VALID_INPUT, CTX_AUTH)

    // No second envelope, no second kernel run, no audit-blind inner decision.
    expect(mockAddNoteFromEnvelope).not.toHaveBeenCalled()
    // The write still runs exactly once, attributed to the verified customer
    // from ctx (never from the model payload).
    expect(mockWriteAdjudicatedNote).toHaveBeenCalledExactlyOnceWith(
      { orderId: "order_01", body: "Sem cebola, por favor." },
      { author: "customer", authorId: "cus_01" },
    )
    expect(result.success).toBe(true)
    expect(result.message).toBe("Observação adicionada ao pedido.")
  })

  it("publishes order.note_added with the persisted noteId", async () => {
    mockWriteAdjudicatedNote.mockResolvedValue({ noteId: "note_42" })

    await addOrderNote(VALID_INPUT, CTX_AUTH)

    expect(mockPublishNatsEvent).toHaveBeenCalledWith(
      "order.note_added",
      expect.objectContaining({
        eventType: "order.note_added",
        orderId: "order_01",
        noteId: "note_42",
        author: "customer",
      }),
    )
  })

  it("propagates a write failure instead of reporting a note that never committed", async () => {
    mockWriteAdjudicatedNote.mockRejectedValue(new Error("note write failed"))

    await expect(addOrderNote(VALID_INPUT, CTX_AUTH)).rejects.toThrow(
      "note write failed",
    )
    expect(mockPublishNatsEvent).not.toHaveBeenCalled()
  })
})
