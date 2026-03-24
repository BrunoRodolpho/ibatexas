// Unit tests for consent store — accept, reject, reset actions

import { describe, it, expect, beforeEach } from "vitest"
import { useConsentStore } from "@/domains/consent"

beforeEach(() => {
  useConsentStore.getState().reset()
})

describe("useConsentStore", () => {
  it("accept() sets hasConsented=true and accepted=true", () => {
    useConsentStore.getState().accept()

    const state = useConsentStore.getState()
    expect(state.hasConsented).toBe(true)
    expect(state.accepted).toBe(true)
  })

  it("reject() sets hasConsented=true and accepted=false", () => {
    useConsentStore.getState().reject()

    const state = useConsentStore.getState()
    expect(state.hasConsented).toBe(true)
    expect(state.accepted).toBe(false)
  })

  it("reset() returns to hasConsented=false and accepted=false", () => {
    useConsentStore.getState().accept()
    useConsentStore.getState().reset()

    const state = useConsentStore.getState()
    expect(state.hasConsented).toBe(false)
    expect(state.accepted).toBe(false)
  })
})
