/**
 * BKL-286 leg 2 — describeChatError is TOTAL and never echoes its input.
 *
 * The anti-raw-payload guarantee is a property of this function: whatever it is
 * handed, it returns one of a small closed set of vetted pt-BR sentences. These
 * cases are the proof, including deliberately hostile inputs (a response body,
 * an array, a nested object) that must still come back as copy.
 */

import { describe, it, expect } from 'vitest'
import {
  describeChatError,
  CHAT_ERROR_CODE_SESSION_DENIED,
  CHAT_GENERIC_FAILURE_PTBR,
  CHAT_SESSION_EXPIRED_PTBR,
} from '../chat.errors'

const VETTED = new Set([CHAT_SESSION_EXPIRED_PTBR, CHAT_GENERIC_FAILURE_PTBR])

describe('describeChatError — session-denied recognition', () => {
  it('maps the machine-readable code to the expired-session copy + restart', () => {
    expect(describeChatError({ code: CHAT_ERROR_CODE_SESSION_DENIED })).toEqual({
      message: CHAT_SESSION_EXPIRED_PTBR,
      canRestart: true,
    })
  })

  it('maps a legacy denial (prose, no code) to the same view', () => {
    expect(describeChatError({ message: 'Acesso negado.' }).canRestart).toBe(true)
  })

  it('maps a 403 response to the same view — the credential is unusable either way', () => {
    expect(describeChatError({ status: 403 })).toEqual({
      message: CHAT_SESSION_EXPIRED_PTBR,
      canRestart: true,
    })
  })

  it('does NOT offer a restart for an unrelated failure', () => {
    expect(describeChatError({ status: 500 })).toEqual({
      message: CHAT_GENERIC_FAILURE_PTBR,
      canRestart: false,
    })
    expect(describeChatError()).toEqual({
      message: CHAT_GENERIC_FAILURE_PTBR,
      canRestart: false,
    })
  })
})

describe('describeChatError — no input can become customer-facing text', () => {
  const hostile: unknown[] = [
    { message: { messageId: 'abc-123' } }, // a response body
    { message: ['messageId', 'abc-123'] },
    { message: '{"messageId":"3f2a"}' }, // raw JSON as a string
    { message: null },
    { message: 42 },
    { code: { toString: () => CHAT_ERROR_CODE_SESSION_DENIED } }, // not === the code
    { code: 'some_unknown_code', message: 'Internal Server Error' },
    { status: '403' }, // a string status is NOT the number 403
    {},
  ]

  it.each(hostile)('returns vetted copy for %j', (input) => {
    const view = describeChatError(input as Parameters<typeof describeChatError>[0])
    expect(VETTED.has(view.message)).toBe(true)
    expect(typeof view.canRestart).toBe('boolean')
  })

  it('never leaks a payload fragment into the message', () => {
    const view = describeChatError({ message: '{"messageId":"3f2a-secret"}' })
    expect(view.message).not.toContain('messageId')
    expect(view.message).not.toContain('3f2a-secret')
    expect(view.message).not.toContain('{')
  })

  it('every returned sentence is pt-BR customer copy, not a code or a status', () => {
    for (const view of [
      describeChatError({ code: CHAT_ERROR_CODE_SESSION_DENIED }),
      describeChatError({ status: 500 }),
    ]) {
      expect(view.message).not.toMatch(/[{}[\]]/)
      expect(view.message).not.toMatch(/\b(error|Error|null|undefined)\b/)
      expect(view.message.endsWith('.')).toBe(true)
    }
  })
})
