// Unit tests for the PURE staff-administration helpers (AUT-038). No React, no
// network — pure logic. Covers the path builders, role/active labels + badges,
// the money helpers (centavos↔reais round-trip, hourly-rate formatting), form
// validation + payload building, and the honest-error contract (message wins over
// error, both fall back to a status-keyed pt-BR message — a failure never reads as
// success). Mirrors the agent-killswitch.mappers.test style.

import { describe, it, expect } from 'vitest'
import {
  STAFF_ENDPOINT,
  staffUpdatePath,
  staffDeactivatePath,
  staffRolePath,
  roleLabel,
  roleBadge,
  activeBadge,
  formatHourlyRate,
  parseReaisToCentavos,
  centavosToReaisInput,
  validateCreateForm,
  validateEditForm,
  isFormValid,
  buildCreatePayload,
  buildUpdatePayload,
  staffErrorFallback,
  staffErrorText,
  staffSuccessMessage,
  STAFF_ROLE_VALUES,
  type CreateStaffForm,
  type EditStaffForm,
} from '../staff.mappers'

describe('path builders', () => {
  it('targets the OWNER-gated staff routes (ids encoded)', () => {
    expect(STAFF_ENDPOINT).toBe('/api/admin/staff')
    expect(staffUpdatePath('abc')).toBe('/api/admin/staff/abc')
    expect(staffDeactivatePath('abc')).toBe('/api/admin/staff/abc/deactivate')
    expect(staffRolePath('abc')).toBe('/api/admin/staff/abc/role')
    expect(staffUpdatePath('a/b')).toBe('/api/admin/staff/a%2Fb')
    expect(staffRolePath('a b')).toBe('/api/admin/staff/a%20b/role')
  })
})

describe('roleLabel / STAFF_ROLE_VALUES', () => {
  it('maps the closed role set to pt-BR, highest-privilege first', () => {
    expect(STAFF_ROLE_VALUES).toEqual(['OWNER', 'MANAGER', 'ATTENDANT'])
    expect(roleLabel('OWNER')).toBe('Proprietário')
    expect(roleLabel('MANAGER')).toBe('Gerente')
    expect(roleLabel('ATTENDANT')).toBe('Atendente')
  })
  it('falls back to the raw value for an unknown role (never blank)', () => {
    expect(roleLabel('WHATEVER')).toBe('WHATEVER')
  })
})

describe('roleBadge / activeBadge', () => {
  it('OWNER is the privilege-bearing info badge; others are neutral', () => {
    expect(roleBadge('OWNER')).toEqual({ label: 'Proprietário', variant: 'info' })
    expect(roleBadge('MANAGER')).toEqual({ label: 'Gerente', variant: 'default' })
    expect(roleBadge('ATTENDANT')).toEqual({ label: 'Atendente', variant: 'default' })
  })
  it('active is a green success; inactive is neutral', () => {
    expect(activeBadge(true)).toEqual({ label: 'Ativo', variant: 'success' })
    expect(activeBadge(false)).toEqual({ label: 'Inativo', variant: 'default' })
  })
})

// formatBRL uses Intl (a non-breaking space after "R$") — normalize whitespace
// before asserting, mirroring the customers.mappers.test idiom.
const norm = (s: string): string => s.replace(/\s+/g, ' ')

describe('formatHourlyRate', () => {
  it('formats integer centavos as BRL/hora', () => {
    expect(norm(formatHourlyRate(2500))).toBe('R$ 25,00/h')
    expect(norm(formatHourlyRate(0))).toBe('R$ 0,00/h')
  })
  it('renders the em-dash for a null / unset / non-finite rate', () => {
    expect(formatHourlyRate(null)).toBe('—')
    expect(formatHourlyRate(undefined)).toBe('—')
    expect(formatHourlyRate(Number.NaN)).toBe('—')
  })
})

describe('parseReaisToCentavos', () => {
  it('parses BR and plain decimals to integer centavos', () => {
    expect(parseReaisToCentavos('25')).toBe(2500)
    expect(parseReaisToCentavos('25,50')).toBe(2550)
    expect(parseReaisToCentavos('25.50')).toBe(2550)
    expect(parseReaisToCentavos(' 25,5 ')).toBe(2550)
    expect(parseReaisToCentavos('0')).toBe(0)
  })
  it('returns null for empty / negative / unparseable input', () => {
    expect(parseReaisToCentavos('')).toBeNull()
    expect(parseReaisToCentavos('   ')).toBeNull()
    expect(parseReaisToCentavos('-5')).toBeNull()
    expect(parseReaisToCentavos('abc')).toBeNull()
    expect(parseReaisToCentavos('25,555')).toBeNull() // more than 2 decimals
    expect(parseReaisToCentavos('1.234,56')).toBeNull() // thousands separators unsupported
  })
})

describe('centavosToReaisInput (edit-form pre-fill round-trip)', () => {
  it('formats centavos as the BR reais edit string', () => {
    expect(centavosToReaisInput(2500)).toBe('25,00')
    expect(centavosToReaisInput(2550)).toBe('25,50')
    expect(centavosToReaisInput(0)).toBe('0,00')
  })
  it('pre-fills empty for a null / unset rate', () => {
    expect(centavosToReaisInput(null)).toBe('')
    expect(centavosToReaisInput(undefined)).toBe('')
  })
  it('round-trips through parseReaisToCentavos', () => {
    for (const c of [0, 100, 2500, 2550, 99999]) {
      expect(parseReaisToCentavos(centavosToReaisInput(c))).toBe(c)
    }
  })
})

describe('validateCreateForm / validateEditForm / isFormValid', () => {
  const validCreate: CreateStaffForm = {
    name: 'Ana',
    phone: '+5511999999999',
    role: 'ATTENDANT',
    hourlyRateReais: '25,00',
  }
  it('accepts a well-formed create form', () => {
    const errors = validateCreateForm(validCreate)
    expect(isFormValid(errors)).toBe(true)
  })
  it('requires name and phone', () => {
    const errors = validateCreateForm({ ...validCreate, name: '  ', phone: '' })
    expect(errors.name).toBeTruthy()
    expect(errors.phone).toBeTruthy()
    expect(isFormValid(errors)).toBe(false)
  })
  it('rejects an unparseable rate but allows an empty (optional) rate', () => {
    expect(validateCreateForm({ ...validCreate, hourlyRateReais: 'abc' }).hourlyRateReais).toBeTruthy()
    expect(isFormValid(validateCreateForm({ ...validCreate, hourlyRateReais: '' }))).toBe(true)
  })
  it('validates the edit form (no role field)', () => {
    const validEdit: EditStaffForm = { name: 'Ana', phone: '+5511999999999', hourlyRateReais: '' }
    expect(isFormValid(validateEditForm(validEdit))).toBe(true)
    expect(validateEditForm({ ...validEdit, name: '' }).name).toBeTruthy()
  })
})

describe('buildCreatePayload / buildUpdatePayload', () => {
  it('creates with a trimmed payload, omitting an unset rate', () => {
    expect(
      buildCreatePayload({ name: ' Ana ', phone: ' +5511999999999 ', role: 'MANAGER', hourlyRateReais: '' }),
    ).toEqual({ phone: '+5511999999999', name: 'Ana', role: 'MANAGER' })
  })
  it('creates with the rate when provided', () => {
    expect(
      buildCreatePayload({ name: 'Ana', phone: '+5511999999999', role: 'OWNER', hourlyRateReais: '30' }),
    ).toEqual({ phone: '+5511999999999', name: 'Ana', role: 'OWNER', hourlyRateCentavos: 3000 })
  })
  it('never carries a role on update, and sends null to clear the rate', () => {
    const payload = buildUpdatePayload({ name: 'Bruno', phone: '+5511988888888', hourlyRateReais: '' })
    expect(payload).toEqual({ name: 'Bruno', phone: '+5511988888888', hourlyRateCentavos: null })
    expect('role' in payload).toBe(false)
  })
  it('sends the parsed rate on update when present', () => {
    expect(
      buildUpdatePayload({ name: 'Bruno', phone: '+5511988888888', hourlyRateReais: '40,00' }).hourlyRateCentavos,
    ).toBe(4000)
  })
})

describe('staffErrorText (honest, message-first-then-error)', () => {
  it('prefers the pt-BR message over the generic reason phrase (preHandler / zod shape)', () => {
    expect(
      staffErrorText({ statusCode: 403, error: 'Forbidden', message: 'Acesso restrito ao proprietário.' }, 403),
    ).toBe('Acesso restrito ao proprietário.')
  })
  it('uses the error field for the route-handler shape (no message)', () => {
    expect(staffErrorText({ error: 'Já existe um funcionário com o telefone "+55...".' }, 409)).toBe(
      'Já existe um funcionário com o telefone "+55...".',
    )
  })
  it('falls back to status-keyed pt-BR when the body has no usable text', () => {
    expect(staffErrorText(null, 404)).toBe(staffErrorFallback(404))
    expect(staffErrorText({}, 409)).toBe(staffErrorFallback(409))
    expect(staffErrorText({ error: '   ', message: '' }, 400)).toBe(staffErrorFallback(400))
  })
  it('a failure never reads as a success message', () => {
    for (const status of [400, 403, 404, 409, 500]) {
      expect(staffErrorFallback(status)).not.toMatch(/salvo|atualizado|desativado|sucesso/i)
    }
  })
})

describe('staffSuccessMessage', () => {
  it('gives an action-specific pt-BR success line', () => {
    expect(staffSuccessMessage('create')).toBe('Funcionário salvo.')
    expect(staffSuccessMessage('update')).toBe('Dados do funcionário atualizados.')
    expect(staffSuccessMessage('deactivate')).toBe('Funcionário desativado.')
    expect(staffSuccessMessage('assign-role')).toBe('Cargo atualizado.')
  })
})
