// Zustand store for reservation flow state
import { create } from "zustand"
import type { ReservationDTO } from "@ibatexas/types"

export type ReservationStep = "date-party" | "timeslot" | "requests" | "confirmation"

export interface AvailableSlot {
  timeSlotId: string
  date: string
  startTime: string
  durationMinutes: number
  availableCovers: number
  tableLocations: string[]
}

export interface SpecialRequest {
  type: string
  notes?: string
}

export interface CreatedReservation {
  reservationId: string
  confirmed: boolean
  tableLocation: string | null
  dateTime: string
  partySize: number
  confirmationMessage: string
}

interface ReservationState {
  // Step navigation
  step: ReservationStep

  // Form data
  selectedDate: string      // YYYY-MM-DD
  partySize: number
  selectedSlot: AvailableSlot | null
  specialRequests: SpecialRequest[]

  // Availability data
  availableSlots: AvailableSlot[]
  loadingSlots: boolean
  slotsError: string | null

  // My reservations
  myReservations: ReservationDTO[]
  loadingMyReservations: boolean

  // Modify mode (CUS-053) — non-null while editing an existing reservation
  modifyOriginal: ReservationDTO | null
  modifySubmitting: boolean
  modifyError: string | null
  showSlotPicker: boolean

  // Created reservation
  createdReservation: CreatedReservation | null
  creating: boolean
  createError: string | null

  // Actions
  setDate: (date: string) => void
  setPartySize: (size: number) => void
  setStep: (step: ReservationStep) => void
  setAvailableSlots: (slots: AvailableSlot[], loading: boolean, error: string | null) => void
  selectSlot: (slot: AvailableSlot) => void
  setSpecialRequests: (requests: SpecialRequest[]) => void
  setCreatedReservation: (r: CreatedReservation | null) => void
  setCreating: (v: boolean) => void
  setCreateError: (e: string | null) => void
  setMyReservations: (r: ReservationDTO[], loading: boolean) => void

  // Modify-mode actions (CUS-053)
  startModify: (reservation: ReservationDTO) => void
  cancelModify: () => void
  setShowSlotPicker: (v: boolean) => void
  setModifySubmitting: (v: boolean) => void
  setModifyError: (e: string | null) => void
  applyModified: (updated: ReservationDTO) => void

  reset: () => void
}

const initialState: Pick<ReservationState, 'step' | 'selectedDate' | 'partySize' | 'selectedSlot' | 'specialRequests' | 'availableSlots' | 'loadingSlots' | 'slotsError' | 'myReservations' | 'loadingMyReservations' | 'createdReservation' | 'creating' | 'createError' | 'modifyOriginal' | 'modifySubmitting' | 'modifyError' | 'showSlotPicker'> = {
  step: "date-party",
  selectedDate: "",
  partySize: 2,
  selectedSlot: null,
  specialRequests: [],
  availableSlots: [],
  loadingSlots: false,
  slotsError: null,
  myReservations: [],
  loadingMyReservations: false,
  createdReservation: null,
  creating: false,
  createError: null,
  modifyOriginal: null,
  modifySubmitting: false,
  modifyError: null,
  showSlotPicker: false,
}

// Fields the modify panel shares with the create wizard — reset together when
// entering or leaving modify mode so the two flows never bleed into each other.
const cleanForm = {
  step: "date-party" as ReservationStep,
  selectedDate: "",
  partySize: 2,
  selectedSlot: null,
  specialRequests: [] as SpecialRequest[],
  availableSlots: [] as AvailableSlot[],
  loadingSlots: false,
  slotsError: null,
  modifyOriginal: null,
  modifySubmitting: false,
  modifyError: null,
  showSlotPicker: false,
}

export const useReservationStore = create<ReservationState>()((set) => ({
  ...initialState,

  setDate: (date) => set({ selectedDate: date }),
  setPartySize: (size) => set({ partySize: size }),
  setStep: (step) => set({ step }),
  setAvailableSlots: (slots, loading, error) =>
    set({ availableSlots: slots, loadingSlots: loading, slotsError: error }),
  selectSlot: (slot) => set({ selectedSlot: slot, step: "requests" }),
  setSpecialRequests: (requests) => set({ specialRequests: requests }),
  setCreatedReservation: (r) => set({ createdReservation: r }),
  setCreating: (v) => set({ creating: v }),
  setCreateError: (e) => set({ createError: e }),
  setMyReservations: (r, loading) =>
    set({ myReservations: r, loadingMyReservations: loading }),

  // ── Modify mode (CUS-053) ──────────────────────────────────────────────────

  // Enter modify mode: seed the shared form fields from the reservation and
  // baseline selectedSlot with the CURRENT slot so an untouched time yields no
  // newTimeSlotId in the diff. Does not touch the myReservations list.
  startModify: (reservation) =>
    set({
      ...cleanForm,
      modifyOriginal: reservation,
      selectedDate: reservation.timeSlot.date,
      partySize: reservation.partySize,
      specialRequests: reservation.specialRequests,
      selectedSlot: {
        timeSlotId: reservation.timeSlot.id,
        date: reservation.timeSlot.date,
        startTime: reservation.timeSlot.startTime,
        durationMinutes: reservation.timeSlot.durationMinutes,
        availableCovers: 0,
        tableLocations: [],
      },
    }),

  cancelModify: () => set({ ...cleanForm }),

  setShowSlotPicker: (v) => set({ showSlotPicker: v }),
  setModifySubmitting: (v) => set({ modifySubmitting: v }),
  setModifyError: (e) => set({ modifyError: e }),

  // Replace the edited row in the list with the server's response, then leave
  // modify mode with a clean form.
  applyModified: (updated) =>
    set((state) => ({
      ...cleanForm,
      myReservations: state.myReservations.map((r) =>
        r.id === updated.id ? updated : r,
      ),
    })),

  reset: () => set(initialState),
}))
