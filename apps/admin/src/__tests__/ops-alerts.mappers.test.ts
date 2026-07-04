// Unit tests for the PURE ops-alerts inbox helpers (BKL-082). Covers the
// EXHAUSTIVE pt-BR label registers (no raw-key fallback), the terminal check
// gating the "Resolver" action, the defensive OPEN-first sort, the querystring
// builder, and the timestamp/source formatting. No React, no network — pure logic.

import { describe, it, expect } from 'vitest'
import {
  OPS_ALERT_CAUSE_LABELS,
  OPS_ALERT_SEVERITY_LABELS,
  OPS_ALERT_STATUS_LABELS,
  causeLabel,
  severityLabel,
  statusLabel,
  severityBadgeVariant,
  statusBadgeVariant,
  isResolvable,
  sortOpsAlerts,
  buildOpsAlertsQuery,
  formatOpsAlertTimestamp,
  sourceScopeLabel,
  type OpsAlert,
  type OpsAlertCause,
  type OpsAlertSeverity,
  type OpsAlertStatus,
} from '../domains/admin/ops-alerts.mappers'

const ALL_CAUSES: readonly OpsAlertCause[] = [
  'ops_stuck_order',
  'ops_pix_expiry_backlog',
  'ops_stale_defer',
  'ops_dlq_depth',
]
const ALL_SEVERITIES: readonly OpsAlertSeverity[] = ['low', 'medium', 'high']
const ALL_STATUSES: readonly OpsAlertStatus[] = [
  'OPEN',
  'ACKNOWLEDGED',
  'AUTO_RESOLVED',
  'RESOLVED',
]

function makeAlert(overrides: Partial<OpsAlert> = {}): OpsAlert {
  return {
    id: 'a1',
    cause: 'ops_stuck_order',
    severity: 'medium',
    status: 'OPEN',
    source: 'stuck-order-checker',
    scope: null,
    title: 'Pedido travado',
    detail: null,
    context: null,
    occurrences: 1,
    dedupeKey: 'k1',
    firstSeenAt: '2026-07-03T10:00:00.000Z',
    lastSeenAt: '2026-07-03T10:00:00.000Z',
    acknowledgedAt: null,
    acknowledgedBy: null,
    resolvedAt: null,
    resolvedBy: null,
    resolutionType: null,
    createdAt: '2026-07-03T10:00:00.000Z',
    updatedAt: '2026-07-03T10:00:00.000Z',
    ...overrides,
  }
}

describe('pt-BR label registers (exhaustive — no raw-key fallback)', () => {
  it('has a non-empty pt-BR label for every cause / severity / status', () => {
    for (const c of ALL_CAUSES) {
      expect(OPS_ALERT_CAUSE_LABELS[c]).toBeTruthy()
      expect(causeLabel(c)).toBe(OPS_ALERT_CAUSE_LABELS[c])
      expect(causeLabel(c)).not.toBe(c) // never the raw enum key
    }
    for (const s of ALL_SEVERITIES) {
      expect(OPS_ALERT_SEVERITY_LABELS[s]).toBeTruthy()
      expect(severityLabel(s)).toBe(OPS_ALERT_SEVERITY_LABELS[s])
    }
    for (const st of ALL_STATUSES) {
      expect(OPS_ALERT_STATUS_LABELS[st]).toBeTruthy()
      expect(statusLabel(st)).toBe(OPS_ALERT_STATUS_LABELS[st])
    }
  })

  it('mirrors the canonical server pt-BR cause/severity values', () => {
    expect(OPS_ALERT_CAUSE_LABELS.ops_dlq_depth).toBe(
      'fila de mensagens mortas acumulando (DLQ)',
    )
    expect(OPS_ALERT_SEVERITY_LABELS.high).toBe('alta')
    expect(OPS_ALERT_STATUS_LABELS.AUTO_RESOLVED).toBe('resolvido auto')
  })
})

describe('severityBadgeVariant', () => {
  it('maps severity bands to Badge tiers', () => {
    expect(severityBadgeVariant('high')).toBe('danger')
    expect(severityBadgeVariant('medium')).toBe('warning')
    expect(severityBadgeVariant('low')).toBe('default')
  })
})

describe('statusBadgeVariant', () => {
  it('maps status to Badge tiers', () => {
    expect(statusBadgeVariant('OPEN')).toBe('warning')
    expect(statusBadgeVariant('ACKNOWLEDGED')).toBe('info')
    expect(statusBadgeVariant('AUTO_RESOLVED')).toBe('info')
    expect(statusBadgeVariant('RESOLVED')).toBe('success')
  })
})

describe('isResolvable', () => {
  it('is true only for the non-terminal statuses (OPEN / ACKNOWLEDGED)', () => {
    expect(isResolvable('OPEN')).toBe(true)
    expect(isResolvable('ACKNOWLEDGED')).toBe(true)
    expect(isResolvable('AUTO_RESOLVED')).toBe(false)
    expect(isResolvable('RESOLVED')).toBe(false)
  })
})

describe('sortOpsAlerts', () => {
  it('orders OPEN-first by status rank, then most-recently-active', () => {
    const resolved = makeAlert({ id: 'resolved', status: 'RESOLVED', lastSeenAt: '2026-07-03T12:00:00.000Z' })
    const ack = makeAlert({ id: 'ack', status: 'ACKNOWLEDGED', lastSeenAt: '2026-07-03T09:00:00.000Z' })
    const openOld = makeAlert({ id: 'open-old', status: 'OPEN', lastSeenAt: '2026-07-03T08:00:00.000Z' })
    const openNew = makeAlert({ id: 'open-new', status: 'OPEN', lastSeenAt: '2026-07-03T11:00:00.000Z' })

    const sorted = sortOpsAlerts([resolved, ack, openOld, openNew])
    expect(sorted.map((a) => a.id)).toEqual(['open-new', 'open-old', 'ack', 'resolved'])
  })

  it('does not mutate the input array', () => {
    const input = [
      makeAlert({ id: 'r', status: 'RESOLVED' }),
      makeAlert({ id: 'o', status: 'OPEN' }),
    ]
    const before = input.map((a) => a.id)
    sortOpsAlerts(input)
    expect(input.map((a) => a.id)).toEqual(before)
  })
})

describe('buildOpsAlertsQuery', () => {
  it('returns an empty string when no params are set', () => {
    expect(buildOpsAlertsQuery({})).toBe('')
  })

  it('encodes status, cause, limit and offset', () => {
    expect(buildOpsAlertsQuery({ status: 'OPEN', cause: 'ops_dlq_depth', limit: 200, offset: 40 })).toBe(
      '?status=OPEN&cause=ops_dlq_depth&limit=200&offset=40',
    )
  })

  it('omits falsy filters but keeps an explicit limit', () => {
    expect(buildOpsAlertsQuery({ status: '', cause: undefined, limit: 200 })).toBe('?limit=200')
  })
})

describe('formatOpsAlertTimestamp', () => {
  it('returns an em-dash for a malformed date', () => {
    expect(formatOpsAlertTimestamp('not-a-date')).toBe('—')
  })

  it('formats a valid ISO string (non-empty, not the em-dash fallback)', () => {
    const out = formatOpsAlertTimestamp('2026-07-03T10:00:00.000Z')
    expect(out).not.toBe('—')
    expect(out.length).toBeGreaterThan(0)
  })
})

describe('sourceScopeLabel', () => {
  it('joins source and scope when scope is present', () => {
    expect(sourceScopeLabel({ source: 'dlq-depth-checker', scope: 'orders.dlq' })).toBe(
      'dlq-depth-checker · orders.dlq',
    )
  })

  it('returns just the source when scope is null', () => {
    expect(sourceScopeLabel({ source: 'stuck-order-checker', scope: null })).toBe('stuck-order-checker')
  })
})
