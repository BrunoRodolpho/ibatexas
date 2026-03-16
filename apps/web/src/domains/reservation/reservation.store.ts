// Zustand store for reservation flow state
import { create } from "zustand"

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
  myReservations: import("@ibatexas/types").ReservationDTO[]
  loadingMyReservations: boolean

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
  setMyReservations: (r: import("@ibatexas/types").ReservationDTO[], loading: boolean) => void
  reset: () => void
}

const initialState: Pick<ReservationState, 'step' | 'selectedDate' | 'partySize' | 'selectedSlot' | 'specialRequests' | 'availableSlots' | 'loadingSlots' | 'slotsError' | 'myReservations' | 'loadingMyReservations' | 'createdReservation' | 'creating' | 'createError'> = {
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
  reset: () => set(initialState),
}))
