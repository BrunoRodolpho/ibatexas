import { describe, it, expect } from 'vitest'
import {
  GUEST_PAYMENT_METHODS,
  CHECKOUT_LOGIN_HREF,
  isGuestEligiblePaymentMethod,
  guestFilteredPaymentMethods,
  defaultPaymentMethod,
  guestNeedsLogin,
  type CheckoutPaymentMethod,
} from '../guestGate'

const ALL: readonly CheckoutPaymentMethod[] = ['pix', 'card', 'cash']

describe('guestGate (CUS-023)', () => {
  describe('GUEST_PAYMENT_METHODS', () => {
    it('permits card only — SEC-001 401s PIX / cash without a customerId', () => {
      expect(GUEST_PAYMENT_METHODS).toEqual(['card'])
    })
  })

  describe('CHECKOUT_LOGIN_HREF', () => {
    it('returns the guest to checkout after signing in', () => {
      expect(CHECKOUT_LOGIN_HREF).toBe('/entrar?next=/checkout')
    })
  })

  describe('isGuestEligiblePaymentMethod', () => {
    it('accepts card', () => {
      expect(isGuestEligiblePaymentMethod('card')).toBe(true)
    })
    it('rejects PIX and cash', () => {
      expect(isGuestEligiblePaymentMethod('pix')).toBe(false)
      expect(isGuestEligiblePaymentMethod('cash')).toBe(false)
    })
  })

  describe('guestFilteredPaymentMethods', () => {
    it('offers every method to an authenticated customer, preserving order', () => {
      expect(guestFilteredPaymentMethods(true, ALL)).toEqual(['pix', 'card', 'cash'])
    })

    it('offers only card to a guest', () => {
      expect(guestFilteredPaymentMethods(false, ALL)).toEqual(['card'])
    })

    it('preserves an already-filtered list (e.g. shipping removed cash)', () => {
      expect(guestFilteredPaymentMethods(false, ['pix', 'card'])).toEqual(['card'])
      expect(guestFilteredPaymentMethods(true, ['pix', 'card'])).toEqual(['pix', 'card'])
    })

    it('returns a fresh array (never the input reference)', () => {
      expect(guestFilteredPaymentMethods(true, ALL)).not.toBe(ALL)
    })
  })

  describe('defaultPaymentMethod', () => {
    it('defaults an authenticated customer to PIX', () => {
      expect(defaultPaymentMethod(true)).toBe('pix')
    })
    it('defaults a guest to card (the only method they can complete)', () => {
      expect(defaultPaymentMethod(false)).toBe('card')
    })
  })

  describe('guestNeedsLogin', () => {
    it('is false for any authenticated selection', () => {
      expect(guestNeedsLogin(true, 'pix')).toBe(false)
      expect(guestNeedsLogin(true, 'card')).toBe(false)
      expect(guestNeedsLogin(true, 'cash')).toBe(false)
    })

    it('is false for a guest paying by card', () => {
      expect(guestNeedsLogin(false, 'card')).toBe(false)
    })

    it('is true for a guest holding a PIX / cash selection', () => {
      expect(guestNeedsLogin(false, 'pix')).toBe(true)
      expect(guestNeedsLogin(false, 'cash')).toBe(true)
    })
  })
})
