// Unit tests for the PURE Canal Operacional helpers (BKL-087). Covers the
// EXHAUSTIVE pt-BR decision labels + Badge-tier mapping (with the raw-key /
// neutral fallback for an unknown kind), the response coercion, the
// fetch-result → thread-entry branch (success vs. honest error), the pt-BR
// error-message extractor (server `error` / staff-guard `message` / status
// fallback), and the composer gate. No React, no network — pure logic. Mirrors
// the ops-alerts.mappers.test / ops-snapshot.mappers.test style.

import { describe, it, expect } from 'vitest'
import {
  OPS_DECISION_LABELS,
  OPS_DECISION_VARIANTS,
  OPS_CHAT_STATUS_FALLBACKS,
  OPS_CHAT_GENERIC_ERROR,
  MAX_OPS_CHAT_MESSAGE,
  decisionLabel,
  decisionBadgeVariant,
  coerceResponse,
  entryFromResult,
  errorMessageFromBody,
  userEntry,
  assistantEntry,
  errorEntry,
  canSend,
  type OpsDecisionKind,
  type OpsChatResponse,
} from '../ops-chat.mappers'

const ALL_DECISIONS: readonly OpsDecisionKind[] = [
  'EXECUTE',
  'REFUSE',
  'REQUEST_CONFIRMATION',
  'ESCALATE',
  'DEFER',
  'REWRITE',
]

function makeResponse(overrides: Partial<OpsChatResponse> = {}): OpsChatResponse {
  return {
    reply: 'Feito.',
    decision: 'EXECUTE',
    executed: true,
    proposedKinds: ['order.status.transition'],
    ...overrides,
  }
}

describe('decision labels (exhaustive pt-BR — no raw-key fallback for known kinds)', () => {
  it('has a non-empty pt-BR label for every kernel decision kind', () => {
    for (const k of ALL_DECISIONS) {
      expect(OPS_DECISION_LABELS[k]).toBeTruthy()
      expect(decisionLabel(k)).toBe(OPS_DECISION_LABELS[k])
      expect(decisionLabel(k)).not.toBe(k) // never the raw enum key
    }
  })

  it('maps each kind to its expected pt-BR label', () => {
    expect(decisionLabel('EXECUTE')).toBe('Execução')
    expect(decisionLabel('REFUSE')).toBe('Recusa')
    expect(decisionLabel('REQUEST_CONFIRMATION')).toBe('Confirmação necessária')
    expect(decisionLabel('ESCALATE')).toBe('Escalação')
    expect(decisionLabel('DEFER')).toBe('Adiamento')
    expect(decisionLabel('REWRITE')).toBe('Reescrita')
  })

  it('falls back to the raw kind for an unknown value (never blank)', () => {
    expect(decisionLabel('SOMETHING_NEW')).toBe('SOMETHING_NEW')
  })
})

describe('decisionBadgeVariant (exhaustive → Badge tiers, neutral fallback)', () => {
  it('has a variant for every kernel decision kind', () => {
    for (const k of ALL_DECISIONS) {
      expect(OPS_DECISION_VARIANTS[k]).toBeTruthy()
      expect(decisionBadgeVariant(k)).toBe(OPS_DECISION_VARIANTS[k])
    }
  })

  it('maps semantics to the right tier (success/danger/warning/neutral/info)', () => {
    expect(decisionBadgeVariant('EXECUTE')).toBe('success')
    expect(decisionBadgeVariant('REFUSE')).toBe('danger')
    expect(decisionBadgeVariant('REQUEST_CONFIRMATION')).toBe('warning')
    expect(decisionBadgeVariant('ESCALATE')).toBe('default')
    expect(decisionBadgeVariant('DEFER')).toBe('default')
    expect(decisionBadgeVariant('REWRITE')).toBe('info')
  })

  it('falls back to neutral (default) for an unknown value', () => {
    expect(decisionBadgeVariant('SOMETHING_NEW')).toBe('default')
  })
})

describe('coerceResponse (defensive shaping of an unknown 200 body)', () => {
  it('passes a well-formed body through unchanged', () => {
    const res = coerceResponse(makeResponse())
    expect(res).toEqual({
      reply: 'Feito.',
      decision: 'EXECUTE',
      executed: true,
      proposedKinds: ['order.status.transition'],
    })
  })

  it('defaults every field for an empty / non-object body', () => {
    expect(coerceResponse(null)).toEqual({ reply: '', decision: '', executed: false, proposedKinds: [] })
    expect(coerceResponse('nope')).toEqual({ reply: '', decision: '', executed: false, proposedKinds: [] })
  })

  it('coerces executed to a strict boolean (truthy strings are not true)', () => {
    expect(coerceResponse({ executed: 'true' }).executed).toBe(false)
    expect(coerceResponse({ executed: true }).executed).toBe(true)
  })

  it('drops non-string members of proposedKinds and a non-array to []', () => {
    expect(coerceResponse({ proposedKinds: ['a', 3, null, 'b'] }).proposedKinds).toEqual(['a', 'b'])
    expect(coerceResponse({ proposedKinds: 'x' }).proposedKinds).toEqual([])
  })
})

describe('entryFromResult (fetch result → assistant / honest error entry)', () => {
  it('builds an assistant entry from an ok result', () => {
    const entry = entryFromResult('e1', { ok: true, status: 200, body: makeResponse({ decision: 'REFUSE', executed: false }) })
    expect(entry).toEqual({
      id: 'e1',
      role: 'assistant',
      reply: 'Feito.',
      decision: 'REFUSE',
      executed: false,
      proposedKinds: ['order.status.transition'],
    })
  })

  it('builds an honest error entry (never success) from a non-ok result', () => {
    const entry = entryFromResult('e2', { ok: false, status: 503, body: { error: 'Canal operacional indisponível no momento.' } })
    expect(entry.role).toBe('error')
    expect(entry).toEqual({ id: 'e2', role: 'error', text: 'Canal operacional indisponível no momento.' })
  })
})

describe('errorMessageFromBody (honest pt-BR, never a raw English reason)', () => {
  it('prefers the route custom error text (`error` field)', () => {
    expect(errorMessageFromBody({ error: 'Canal operacional indisponível no momento.' }, 503)).toBe(
      'Canal operacional indisponível no momento.',
    )
  })

  it('reads the staff-guard pt-BR from `message` when `error` is a generic English reason', () => {
    expect(
      errorMessageFromBody({ statusCode: 403, error: 'Forbidden', message: 'Acesso restrito a funcionários.' }, 403),
    ).toBe('Acesso restrito a funcionários.')
  })

  it('never surfaces a bare English HTTP reason — falls back by status', () => {
    expect(errorMessageFromBody({ error: 'Bad Gateway' }, 502)).toBe(OPS_CHAT_STATUS_FALLBACKS[502])
  })

  it('uses the status fallback for a non-JSON / empty body', () => {
    expect(errorMessageFromBody(null, 502)).toBe(OPS_CHAT_STATUS_FALLBACKS[502])
    expect(errorMessageFromBody(null, 503)).toBe(OPS_CHAT_STATUS_FALLBACKS[503])
    expect(errorMessageFromBody(null, 403)).toBe(OPS_CHAT_STATUS_FALLBACKS[403])
  })

  it('uses the generic message for an unmapped status with no usable body text', () => {
    expect(errorMessageFromBody({}, 418)).toBe(OPS_CHAT_GENERIC_ERROR)
  })
})

describe('thread-entry builders', () => {
  it('builds a user entry', () => {
    expect(userEntry('u1', 'ping')).toEqual({ id: 'u1', role: 'user', text: 'ping' })
  })

  it('builds an assistant entry mirroring the response', () => {
    expect(assistantEntry('a1', makeResponse())).toEqual({
      id: 'a1',
      role: 'assistant',
      reply: 'Feito.',
      decision: 'EXECUTE',
      executed: true,
      proposedKinds: ['order.status.transition'],
    })
  })

  it('builds an error entry', () => {
    expect(errorEntry('x1', 'ops')).toEqual({ id: 'x1', role: 'error', text: 'ops' })
  })
})

describe('canSend (composer gate)', () => {
  it('is false while a turn is in flight', () => {
    expect(canSend('oi', true)).toBe(false)
  })

  it('is false for an empty / whitespace-only draft', () => {
    expect(canSend('', false)).toBe(false)
    expect(canSend('   \n ', false)).toBe(false)
  })

  it('is true for a non-empty draft when idle', () => {
    expect(canSend('qual a situação da cozinha?', false)).toBe(true)
  })

  it('rejects a draft longer than the max after trimming', () => {
    expect(canSend('a'.repeat(MAX_OPS_CHAT_MESSAGE), false)).toBe(true)
    expect(canSend('a'.repeat(MAX_OPS_CHAT_MESSAGE + 1), false)).toBe(false)
  })
})
