import { describe, it, expect } from 'vitest'
import {
  canProceed,
  nextStep,
  prevStep,
  CHECKOUT_STEPS,
  isValidCpf,
  isValidPixName,
  isValidEmail,
} from '../checkout.logic'

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

  // ── Field Validators ──────────────────────────────────────────────

  describe('isValidCpf', () => {
    it('accepts a valid CPF, masked or unmasked', () => {
      expect(isValidCpf('392.086.078-01')).toBe(true)
      expect(isValidCpf('39208607801')).toBe(true)
    })

    it('rejects a bad check digit', () => {
      expect(isValidCpf('392.086.078-00')).toBe(false)
      expect(isValidCpf('123.456.789-00')).toBe(false)
    })

    it('rejects repeated-digit and wrong-length values', () => {
      expect(isValidCpf('111.111.111-11')).toBe(false)
      expect(isValidCpf('00000000000')).toBe(false)
      expect(isValidCpf('123')).toBe(false)
      expect(isValidCpf('')).toBe(false)
    })
  })

  describe('isValidPixName', () => {
    it('requires at least two words', () => {
      expect(isValidPixName('Ana Lima')).toBe(true)
      expect(isValidPixName('  Maria  da  Silva  ')).toBe(true)
    })

    it('rejects a single word or blank', () => {
      expect(isValidPixName('asd')).toBe(false)
      expect(isValidPixName('   ')).toBe(false)
      expect(isValidPixName('')).toBe(false)
    })
  })

  describe('isValidEmail', () => {
    it('accepts a well-formed address', () => {
      expect(isValidEmail('asd@gmail.com')).toBe(true)
      expect(isValidEmail('a.b-c@sub.example.co')).toBe(true)
    })

    it('rejects malformed addresses', () => {
      expect(isValidEmail('foo')).toBe(false)
      expect(isValidEmail('foo@bar')).toBe(false)
      expect(isValidEmail('foo @bar.com')).toBe(false)
      expect(isValidEmail('')).toBe(false)
    })
  })
})
