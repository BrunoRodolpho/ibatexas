// Unit tests for the PURE OPS-013 order staff-notes helpers. No React, no
// network — pure logic. Covers the pt-BR author (OrderActor) labels, the
// timestamp formatter's null/invalid guards, and the READ-ONLY notes-response
// mapping (order preserved, missing input tolerated). The exact locale date
// string varies by ICU build, so the timestamp assertions check identity
// (contains the year / not the em-dash) rather than an exact rendering. Mirrors
// the customers.mappers.test style (invoke-as-function; apps/admin has no
// @testing-library/react).

import { describe, it, expect } from 'vitest'
import {
  orderNoteAuthorLabel,
  formatNoteTimestamp,
  mapOrderNotes,
} from '../order-notes.mappers'

describe('orderNoteAuthorLabel', () => {
  it('maps each OrderActor to its pt-BR label', () => {
    expect(orderNoteAuthorLabel('admin')).toBe('Admin')
    expect(orderNoteAuthorLabel('system')).toBe('Sistema')
    expect(orderNoteAuthorLabel('system_backfill')).toBe('Migração')
    expect(orderNoteAuthorLabel('customer')).toBe('Cliente')
  })
  it('falls back to the raw value for an unknown actor', () => {
    expect(orderNoteAuthorLabel('robot')).toBe('robot')
  })
  it('renders the em-dash for a null / empty author', () => {
    expect(orderNoteAuthorLabel(null)).toBe('—')
    expect(orderNoteAuthorLabel('   ')).toBe('—')
  })
})

describe('formatNoteTimestamp', () => {
  it('renders a real ISO timestamp (not the em-dash)', () => {
    const out = formatNoteTimestamp('2026-06-01T14:30:00.000Z')
    expect(out).not.toBe('—')
    expect(out).toContain('2026')
  })
  it('renders the em-dash for a null / empty / unparseable value', () => {
    expect(formatNoteTimestamp(null)).toBe('—')
    expect(formatNoteTimestamp('')).toBe('—')
    expect(formatNoteTimestamp('not-a-date')).toBe('—')
  })
})

describe('mapOrderNotes', () => {
  it('maps notes to pre-formatted display rows, preserving order', () => {
    const rows = mapOrderNotes({
      notes: [
        { id: 'n1', author: 'admin', authorId: 'staff-1', content: 'Primeira nota', createdAt: '2026-06-01T14:30:00.000Z' },
        { id: 'n2', author: 'system', authorId: null, content: 'Nota do sistema', createdAt: '2026-06-02T09:00:00.000Z' },
      ],
    })
    expect(rows).toHaveLength(2)
    expect(rows[0]?.id).toBe('n1')
    expect(rows[0]?.authorLabel).toBe('Admin')
    expect(rows[0]?.content).toBe('Primeira nota')
    expect(rows[1]?.authorLabel).toBe('Sistema')
  })
  it('tolerates a missing / null / undefined response (→ empty list)', () => {
    expect(mapOrderNotes(null)).toEqual([])
    expect(mapOrderNotes(undefined)).toEqual([])
    expect(mapOrderNotes({} as never)).toEqual([])
  })
})
