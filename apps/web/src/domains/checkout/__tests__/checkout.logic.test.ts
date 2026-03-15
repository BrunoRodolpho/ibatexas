import { describe, it, expect } from 'vitest'
import { canProceed, nextStep, prevStep, CHECKOUT_STEPS } from '../checkout.logic'

describe('checkout.logic', () => {
  // ── Navigation ──────────────────────────────────────────────────────

  describe('nextStep', () => {
    it('advances through the checkout flow', () => {
      expect(nextStep('cart_review')).toBe('address')
      expect(nextStep('address')).toBe('shipping')
      expect(nextStep('shipping')).toBe('payment')
      expect(nextStep('payment')).toBe('confirmation')
    })

    it('returns null at the last step', () => {
      expect(nextStep('confirmation')).toBeNull()
    })
  })

  describe('prevStep', () => {
    it('goes back through the checkout flow', () => {
      expect(prevStep('confirmation')).toBe('payment')
      expect(prevStep('payment')).toBe('shipping')
    })

    it('returns null at the first step', () => {
      expect(prevStep('cart_review')).toBeNull()
    })
  })

  // ── Validation (Strategy Map) ─────────────────────────────────────

  describe('canProceed', () => {
    it('cart_review: requires items', () => {
      expect(canProceed('cart_review', { itemCount: 0 })).toBe(false)
      expect(canProceed('cart_review', { itemCount: 3 })).toBe(true)
    })

    it('address: requires hasAddress', () => {
      expect(canProceed('address', { itemCount: 1 })).toBe(false)
      expect(canProceed('address', { itemCount: 1, hasAddress: true })).toBe(true)
    })

    it('shipping: requires hasShipping', () => {
      expect(canProceed('shipping', { itemCount: 1 })).toBe(false)
      expect(canProceed('shipping', { itemCount: 1, hasShipping: true })).toBe(true)
    })

    it('payment: requires hasPayment', () => {
      expect(canProceed('payment', { itemCount: 1 })).toBe(false)
      expect(canProceed('payment', { itemCount: 1, hasPayment: true })).toBe(true)
    })

    it('confirmation: always passes', () => {
      expect(canProceed('confirmation', { itemCount: 0 })).toBe(true)
    })

    it('every CHECKOUT_STEPS entry has a validator', () => {
      for (const step of CHECKOUT_STEPS) {
        // Should not throw — validator exists for every step
        expect(typeof canProceed(step, { itemCount: 0 })).toBe('boolean')
      }
    })
  })
})
