/**
 * ModifyReservationForm (CUS-053). Web component tests run in the node vitest
 * env with the real react/jsx-runtime building a plain element tree (the
 * invoke-as-a-function pattern; no @testing-library). We mock the store hook,
 * next-intl, the atoms/icons/child components (used only as element TYPES), and
 * the modify helpers — then walk the returned tree and fire the button handlers
 * to assert the PATCH orchestration + the no-op guard.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import type { ReactElement } from "react"

// ── Hoisted shared mocks ──────────────────────────────────────────────────────
const h = vi.hoisted(() => ({
  store: {} as Record<string, unknown>,
  buildModifyPayload: vi.fn(),
  hasModifyChanges: vi.fn(),
  fetchAvailabilitySlots: vi.fn(),
  submitModify: vi.fn(),
}))

vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
vi.mock("@/components/atoms", () => ({
  Button: ({ children, onClick, disabled }: Record<string, unknown>) => ({ children, onClick, disabled }),
  Card: ({ children }: { children?: unknown }) => children,
  Heading: ({ children }: { children?: unknown }) => children,
  Text: ({ children }: { children?: unknown }) => children,
}))
vi.mock("lucide-react", () => ({
  CalendarDays: () => null,
  Clock: () => null,
  Sparkles: () => null,
  X: () => null,
}))
vi.mock("../DatePicker", () => ({ DatePicker: () => null }))
vi.mock("../PartySizeSelector", () => ({ PartySizeSelector: () => null }))
vi.mock("../TimeslotGrid", () => ({ TimeslotGrid: () => null }))
vi.mock("../SpecialRequestsForm", () => ({ SpecialRequestsForm: () => null }))
vi.mock("@/domains/reservation", () => ({
  useReservationStore: () => h.store,
  buildModifyPayload: h.buildModifyPayload,
  hasModifyChanges: h.hasModifyChanges,
  fetchAvailabilitySlots: h.fetchAvailabilitySlots,
  submitModify: h.submitModify,
  // Pass-through: the strict-narrowing boundary is unit-tested in modify.test.ts;
  // these component tests assert the handleSave wiring, not the narrowing.
  toStrictSpecialRequests: (reqs: unknown) => reqs,
}))

import { ModifyReservationForm } from "../ModifyReservationForm"

// ── Tree walk ─────────────────────────────────────────────────────────────────
// jsx() builds real elements ({ type, props }); component types are never
// invoked, so we read handlers + labels off each element's `props`.
function collect(node: unknown, out: Record<string, unknown>[]): void {
  if (node == null || typeof node !== "object") return
  if (Array.isArray(node)) {
    node.forEach((c) => collect(c, out))
    return
  }
  const props = (node as Record<string, unknown>).props as Record<string, unknown> | undefined
  if (!props) return
  if (typeof props.onClick === "function") out.push(props)
  collect(props.children, out)
}

function handlersFor(el: ReactElement): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  collect(el, out)
  return out
}

const ORIGINAL = {
  id: "r1",
  partySize: 2,
  specialRequests: [],
  timeSlot: { id: "slot-1", date: "2026-08-01", startTime: "19:30", durationMinutes: 90 },
}

function baseStore() {
  return {
    modifyOriginal: ORIGINAL,
    selectedDate: "2026-08-01",
    partySize: 4,
    specialRequests: [],
    selectedSlot: { timeSlotId: "slot-1", date: "2026-08-01", startTime: "19:30", durationMinutes: 90, availableCovers: 0, tableLocations: [] },
    availableSlots: [],
    loadingSlots: false,
    slotsError: null,
    showSlotPicker: false,
    modifySubmitting: false,
    modifyError: null,
    setDate: vi.fn(),
    setPartySize: vi.fn(),
    setSpecialRequests: vi.fn(),
    selectSlot: vi.fn(),
    setAvailableSlots: vi.fn(),
    setShowSlotPicker: vi.fn(),
    setModifySubmitting: vi.fn(),
    setModifyError: vi.fn(),
    cancelModify: vi.fn(),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  h.store = baseStore()
})

describe("ModifyReservationForm (CUS-053)", () => {
  it("renders null when no reservation is being modified", () => {
    h.store = { ...baseStore(), modifyOriginal: null }
    expect(ModifyReservationForm({ onSaved: vi.fn() })).toBeNull()
  })

  it("save with no changes sets the no-changes error and never PATCHes", async () => {
    h.buildModifyPayload.mockReturnValue({})
    h.hasModifyChanges.mockReturnValue(false)
    const onSaved = vi.fn()

    const tree = ModifyReservationForm({ onSaved }) as ReactElement
    const save = handlersFor(tree).find((n) => n.children === "reservations.modify_save")
    expect(save).toBeDefined()
    await (save!.onClick as () => Promise<void>)()

    expect(h.store.setModifyError).toHaveBeenCalledWith("reservations.modify_no_changes")
    expect(h.submitModify).not.toHaveBeenCalled()
    expect(onSaved).not.toHaveBeenCalled()
  })

  it("save with changes PATCHes and hands the updated reservation to onSaved", async () => {
    const body = { newPartySize: 4 }
    const updated = { id: "r1", partySize: 4 }
    h.buildModifyPayload.mockReturnValue(body)
    h.hasModifyChanges.mockReturnValue(true)
    h.submitModify.mockResolvedValue(updated)
    const onSaved = vi.fn()

    const tree = ModifyReservationForm({ onSaved }) as ReactElement
    const save = handlersFor(tree).find((n) => n.children === "reservations.modify_save")!
    await (save.onClick as () => Promise<void>)()

    expect(h.submitModify).toHaveBeenCalledWith("r1", body)
    expect(onSaved).toHaveBeenCalledWith(updated)
    expect(h.store.setModifySubmitting).toHaveBeenCalledWith(true)
    expect(h.store.setModifySubmitting).toHaveBeenCalledWith(false)
  })

  it("save surfaces the thrown error message", async () => {
    h.buildModifyPayload.mockReturnValue({ newPartySize: 4 })
    h.hasModifyChanges.mockReturnValue(true)
    h.submitModify.mockRejectedValue(new Error("Horário indisponível."))

    const tree = ModifyReservationForm({ onSaved: vi.fn() }) as ReactElement
    const save = handlersFor(tree).find((n) => n.children === "reservations.modify_save")!
    await (save.onClick as () => Promise<void>)()

    expect(h.store.setModifyError).toHaveBeenCalledWith("Horário indisponível.")
  })

  it("'Alterar horário' opens the picker and loads slots", async () => {
    h.fetchAvailabilitySlots.mockResolvedValue([{ timeSlotId: "s2" }])

    const tree = ModifyReservationForm({ onSaved: vi.fn() }) as ReactElement
    const change = handlersFor(tree).find((n) => n.children === "reservations.modify_change_time")!
    await (change.onClick as () => Promise<void>)()

    expect(h.store.setShowSlotPicker).toHaveBeenCalledWith(true)
    expect(h.fetchAvailabilitySlots).toHaveBeenCalledWith("2026-08-01", 4)
    expect(h.store.setAvailableSlots).toHaveBeenCalledWith([{ timeSlotId: "s2" }], false, null)
  })

  it("slot load failure routes the error into setAvailableSlots", async () => {
    h.fetchAvailabilitySlots.mockRejectedValue(new Error("Erro ao buscar disponibilidade."))

    const tree = ModifyReservationForm({ onSaved: vi.fn() }) as ReactElement
    const change = handlersFor(tree).find((n) => n.children === "reservations.modify_change_time")!
    await (change.onClick as () => Promise<void>)()

    expect(h.store.setAvailableSlots).toHaveBeenLastCalledWith([], false, "Erro ao buscar disponibilidade.")
  })
})
