// Unit tests for the PURE OPS-032 broadcast opt-out list helpers. No React, no
// network — pure logic. Covers the phone-formatted mapping of the READ-ONLY
// GET /api/admin/broadcast/optout response, the blank/missing-input tolerance,
// and the blank-entry skip (so the count never over-reports). Mirrors the
// customers.mappers.test style (invoke-as-function; apps/admin has no
// @testing-library/react).

import { describe, it, expect } from 'vitest'
import { mapOptOutRecipients } from '../broadcast.mappers'

describe('mapOptOutRecipients', () => {
  it('formats each recipient phone with the canonical BR formatter', () => {
    const rows = mapOptOutRecipients({
      recipients: ['+5511999990001', '+551133334444'],
    })
    expect(rows).toEqual([
      { recipient: '+5511999990001', display: '(11) 99999-0001' },
      { recipient: '+551133334444', display: '(11) 3333-4444' },
    ])
  })

  it('preserves the raw recipient as the row key (round-trip identity)', () => {
    const rows = mapOptOutRecipients({ recipients: ['+5511999990001'] })
    expect(rows[0]?.recipient).toBe('+5511999990001')
  })

  it('renders a non-BR / unexpected shape verbatim (never blank)', () => {
    const rows = mapOptOutRecipients({ recipients: ['12345'] })
    expect(rows[0]?.display).toBe('12345')
  })

  it('skips blank entries so the count never over-reports', () => {
    const rows = mapOptOutRecipients({
      recipients: ['+5511999990001', '', '   '],
    })
    expect(rows).toHaveLength(1)
  })

  it('tolerates a missing / null / undefined response (→ empty list)', () => {
    expect(mapOptOutRecipients(null)).toEqual([])
    expect(mapOptOutRecipients(undefined)).toEqual([])
    expect(mapOptOutRecipients({} as never)).toEqual([])
  })
})
