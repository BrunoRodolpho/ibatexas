import { describe, it, expect } from 'vitest'
import { canProceed, nextStep, prevStep, CHECKOUT_STEPS, mergeItemInstructionsIntoNotes, CHECKOUT_NOTES_MAX } from '../checkout.logic'

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

  // ── Per-item special instructions → order notes (CUS-015) ────────────
  describe('mergeItemInstructionsIntoNotes', () => {
    it('returns the base note unchanged when no item has instructions', () => {
      expect(mergeItemInstructionsIntoNotes('Tocar a campainha', [
        { title: 'Costela', quantity: 1 },
      ])).toEqual({ notes: 'Tocar a campainha', overflow: false })
    })

    it('returns empty notes when there is nothing to send', () => {
      expect(mergeItemInstructionsIntoNotes('  ', [{ title: 'X', quantity: 1 }]))
        .toEqual({ notes: '', overflow: false })
    })

    it('appends a line per item carrying an instruction, after the base note', () => {
      const out = mergeItemInstructionsIntoNotes('Sem talheres', [
        { title: 'Costela', quantity: 2, specialInstructions: 'bem passada' },
        { title: 'Refri', quantity: 1, variantTitle: 'Lata', specialInstructions: 'gelado' },
        { title: 'Pão', quantity: 1 },
      ])
      expect(out.notes).toBe('Sem talheres\n2× Costela: bem passada\n1× Refri — Lata: gelado')
      expect(out.overflow).toBe(false)
    })

    it('drops blank/whitespace-only instructions', () => {
      expect(mergeItemInstructionsIntoNotes('', [
        { title: 'A', quantity: 1, specialInstructions: '   ' },
        { title: 'B', quantity: 1, specialInstructions: 'ok' },
      ]).notes).toBe('1× B: ok')
    })

    it('flags overflow above CHECKOUT_NOTES_MAX without truncating anything', () => {
      const out = mergeItemInstructionsIntoNotes('', [
        { title: 'X', quantity: 1, specialInstructions: 'a'.repeat(1000) },
      ])
      expect(out.overflow).toBe(true)
      expect(out.notes).toContain('a'.repeat(1000))
      expect(out.notes.length).toBeGreaterThan(CHECKOUT_NOTES_MAX)
    })

    it('preserves later item instructions (e.g. allergy notes) even when the base note fills the cap', () => {
      const out = mergeItemInstructionsIntoNotes('x'.repeat(CHECKOUT_NOTES_MAX), [
        { title: 'Costela', quantity: 1, specialInstructions: 'ALERGIA a amendoim' },
      ])
      expect(out.overflow).toBe(true)
      expect(out.notes).toContain('ALERGIA a amendoim')
    })

    it('does not flag overflow at exactly CHECKOUT_NOTES_MAX', () => {
      const out = mergeItemInstructionsIntoNotes('x'.repeat(CHECKOUT_NOTES_MAX), [])
      expect(out.notes.length).toBe(CHECKOUT_NOTES_MAX)
      expect(out.overflow).toBe(false)
    })
  })
})
