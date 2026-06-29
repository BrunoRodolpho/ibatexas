'use client'

import { useEffect, useRef, useState } from 'react'
import { X, Clock, AlertTriangle, ArrowUp } from 'lucide-react'
import { Badge } from '../atoms/Badge'
import { TextArea } from '../atoms/TextArea'
import { SectionHeader } from '../atoms/SectionHeader'
import { Modal } from '../molecules/Modal'
import { incidentStatusVariant } from '../utils/status-variant'
import { formatAge, formatDateTime } from '../utils/format'
import {
  INCIDENT_LABELS,
  INCIDENT_STATUS_LABELS,
  INCIDENT_SEVERITY_LABELS,
  INCIDENT_CAUSE_LABELS,
  INCIDENT_CAUSE_EXPLANATIONS,
  INCIDENT_CONFIRM,
  ACTION_LABELS,
} from '../constants/admin-labels'

// ── UI-local incident shape (mirrors @ibatexas/domain ConversationIncident,
// JSON-serialized: dates arrive as ISO strings). The ui package depends on
// @ibatexas/types only, so this is declared here rather than imported. ──────────
export interface AdminIncident {
  readonly id: string
  readonly sessionId: string
  readonly conversationId?: string | null
  readonly customerId?: string | null
  readonly channel: string
  readonly senderRef?: string | null
  readonly cause: string
  readonly lastCause?: string | null
  readonly severity: string // 'low' | 'medium' | 'high'
  readonly status: string // IncidentStatus
  readonly dropCount: number
  readonly customerImpacted: boolean
  readonly openedAt: string
  readonly lastDropAt: string
  readonly acknowledgedAt?: string | null
  readonly acknowledgedBy?: string | null
  readonly resolvedAt?: string | null
  readonly resolvedBy?: string | null
  readonly resolutionType?: string | null
  readonly priorIncidentId?: string | null
  readonly lastTurnId?: string | null
  readonly lastDecisionKind?: string | null
  /** Optional display helpers resolved by the page/hook. */
  readonly customerName?: string | null
  readonly customerPhoneMasked?: string | null
}

export interface IncidentTranscriptMessage {
  readonly role: string
  readonly content: string
  readonly sentAt: string
  readonly metadata?: unknown
}

export interface IncidentDetailDrawerProps {
  readonly incident: AdminIncident | null
  readonly open: boolean
  readonly messages?: readonly IncidentTranscriptMessage[]
  readonly onClose: () => void
  readonly onAcknowledge?: (id: string) => Promise<void> | void
  readonly onResolve?: (id: string) => Promise<void> | void
  readonly onEscalate?: (id: string) => Promise<void> | void
  readonly onReply?: (id: string, text: string) => Promise<void> | void
  readonly onNavigatePrior?: (priorIncidentId: string) => void
}

const TERMINAL: ReadonlySet<string> = new Set(['AUTO_RESOLVED', 'RESOLVED'])

/** Short forensic id, e.g. INC-2f9a (matches the §4 mock). */
export function formatIncidentId(id: string): string {
  return `INC-${id.slice(-4)}`
}

function maskHandle(handle: string): string {
  const phone = handle.replace(/^whatsapp:/, '')
  if (phone.length <= 6) return phone
  return `${phone.slice(0, 3)}•••${phone.slice(-4)}`
}

function GapCard({ index, total }: { readonly index?: number; readonly total: number }) {
  const collapsed = index === undefined
  return (
    <div className="rounded-sm border border-dashed border-accent-red px-4 py-3 text-sm text-accent-red">
      <div className="flex items-center justify-between">
        <span className="font-medium">
          {collapsed ? INCIDENT_LABELS.gapCollapsed(total) : INCIDENT_LABELS.gapLine}
        </span>
      </div>
      {!collapsed && (
        <div className="mt-1 text-xs text-accent-red/80">
          {INCIDENT_LABELS.gapDetail} ({INCIDENT_LABELS.dropOfTotal(index!, total)})
        </div>
      )}
    </div>
  )
}

function TranscriptBubble({ message }: { readonly message: IncidentTranscriptMessage }) {
  const isUser = message.role === 'user' || message.role === 'customer'
  const meta = message.metadata as { via?: string } | undefined
  const isTakeover = meta?.via === 'staff_takeover'
  const time = new Date(message.sentAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
  return (
    <div className={`rounded-sm px-4 py-3 text-sm ${isUser ? 'bg-brand-50' : 'bg-smoke-100'}`}>
      <div className="mb-1 flex items-center justify-between text-xs text-smoke-500">
        <span>{isUser ? 'cliente' : 'atendimento'}</span>
        <span className="tabular-nums">{time}</span>
      </div>
      <p className="whitespace-pre-wrap text-charcoal-800">{message.content}</p>
      {!isUser && isTakeover && (
        <div className="mt-1 text-xs font-medium text-accent-green">{INCIDENT_LABELS.deliveredMarker}</div>
      )}
    </div>
  )
}

interface TimelineEntry {
  readonly key: string
  readonly at: string
  readonly label: string
  readonly actor: string
}

function buildTimeline(incident: AdminIncident): TimelineEntry[] {
  const entries: TimelineEntry[] = [
    {
      key: 'opened',
      at: incident.openedAt,
      label: INCIDENT_STATUS_LABELS.OPEN,
      actor: `Sistema · ${INCIDENT_CAUSE_LABELS[incident.cause] ?? incident.cause}`,
    },
  ]
  if (incident.acknowledgedAt) {
    entries.push({
      key: 'ack',
      at: incident.acknowledgedAt,
      label: INCIDENT_STATUS_LABELS.ACKNOWLEDGED,
      actor: incident.acknowledgedBy ?? 'Admin',
    })
  }
  if (incident.resolvedAt) {
    entries.push({
      key: 'resolved',
      at: incident.resolvedAt,
      label: INCIDENT_STATUS_LABELS[incident.status] ?? incident.status,
      actor: incident.resolutionType === 'AUTO' ? 'Sistema' : (incident.resolvedBy ?? 'Admin'),
    })
  }
  return entries
}

export function IncidentDetailDrawer({
  incident,
  open,
  messages = [],
  onClose,
  onAcknowledge,
  onResolve,
  onEscalate,
  onReply,
  onNavigatePrior,
}: IncidentDetailDrawerProps) {
  const overlayRef = useRef<HTMLButtonElement>(null)
  const [reply, setReply] = useState('')
  const [busy, setBusy] = useState(false)
  const [showTech, setShowTech] = useState(false)
  const [confirm, setConfirm] = useState<'resolve' | 'escalate' | null>(null)

  // Close on Escape; reset transient state when the incident changes.
  useEffect(() => {
    if (!open) return
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [open, onClose])

  useEffect(() => {
    setReply('')
    setShowTech(false)
    setConfirm(null)
  }, [incident?.id])

  if (!open || !incident) return null

  const terminal = TERMINAL.has(incident.status)
  const causeLabel = INCIDENT_CAUSE_LABELS[incident.cause] ?? incident.cause
  const causeExplanation = INCIDENT_CAUSE_EXPLANATIONS[incident.cause]
  const dropCount = incident.dropCount

  async function run(fn?: (id: string) => Promise<void> | void) {
    if (!fn || busy || !incident) return
    setBusy(true)
    try {
      await fn(incident.id)
    } finally {
      setBusy(false)
    }
  }

  async function handleReply() {
    if (!onReply || busy || !reply.trim() || !incident) return
    setBusy(true)
    try {
      await onReply(incident.id, reply.trim())
      setReply('')
    } finally {
      setBusy(false)
    }
  }

  const techRows: Array<[string, string | null]> = [
    [INCIDENT_LABELS.fieldTurn, incident.lastTurnId ?? null],
    [INCIDENT_LABELS.fieldDecision, incident.lastDecisionKind ?? null], // rendered only when present
    [INCIDENT_LABELS.fieldDrops, String(dropCount)],
    [INCIDENT_LABELS.fieldChannel, incident.channel],
    [
      INCIDENT_LABELS.fieldCustomer,
      incident.customerName ??
        incident.customerPhoneMasked ??
        (incident.senderRef ? maskHandle(incident.senderRef) : null),
    ],
    [INCIDENT_LABELS.fieldSession, incident.sessionId],
    [INCIDENT_LABELS.fieldOpenedAt, formatDateTime(incident.openedAt)],
  ]

  return (
    <>
      {/* Overlay */}
      <button
        ref={overlayRef}
        type="button"
        aria-label="Fechar"
        className="fixed inset-0 z-40 bg-charcoal-900/30 transition-opacity"
        onClick={onClose}
      />

      {/* Drawer — widened to max-w-xl for the transcript */}
      <div className="fixed inset-y-0 right-0 z-50 flex w-full max-w-xl flex-col bg-white shadow-xl">
        {/* Header */}
        <div className="sticky top-0 flex items-center justify-between border-b border-smoke-200 bg-white px-6 py-4">
          <div className="flex items-center gap-2">
            <h2 className="font-mono text-lg font-bold text-charcoal-900">{formatIncidentId(incident.id)}</h2>
            <Badge variant={incidentStatusVariant(incident.status)} className="text-xs">
              {INCIDENT_STATUS_LABELS[incident.status] ?? incident.status}
            </Badge>
            {incident.priorIncidentId && (
              <Badge variant="warning" className="text-xs">{INCIDENT_LABELS.reopenedTag}</Badge>
            )}
          </div>
          <button
            onClick={onClose}
            className="rounded-sm p-1 text-smoke-400 hover:bg-smoke-100 hover:text-charcoal-900"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 space-y-6 overflow-y-auto px-6 py-5">
          {/* Cause line — leads */}
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-accent-red" />
              <Badge variant="default" className="text-xs">{causeLabel}</Badge>
            </div>
            {causeExplanation && <p className="text-sm text-charcoal-700">{causeExplanation}</p>}
            {incident.priorIncidentId && (
              <button
                onClick={() => onNavigatePrior?.(incident.priorIncidentId!)}
                className="flex items-center gap-1 text-xs text-brand-700 hover:underline"
              >
                <ArrowUp className="h-3 w-3" />
                {INCIDENT_LABELS.reopenedFrom(formatIncidentId(incident.priorIncidentId), '')}
              </button>
            )}
          </div>

          {/* Transcript — the headline section */}
          <div className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-smoke-400">
              {INCIDENT_LABELS.transcriptHeading}
            </h3>
            <div className="space-y-2">
              {messages.map((m, i) => (
                <TranscriptBubble key={`${m.sentAt}-${i}`} message={m} />
              ))}
              {/* The GAP: one card per drop while dropCount ≤ 2, else one collapsed card */}
              {dropCount <= 2
                ? Array.from({ length: dropCount }, (_, i) => (
                    <GapCard key={`gap-${i}`} index={i + 1} total={dropCount} />
                  ))
                : <GapCard total={dropCount} />}
              {terminal && (incident.resolvedAt || incident.lastDropAt) && (
                <div className="flex items-center gap-2 py-1 text-xs text-smoke-400">
                  <span className="h-px flex-1 bg-smoke-200" />
                  {INCIDENT_LABELS.autoResolvedDivider(formatAge(incident.resolvedAt ?? incident.lastDropAt))}
                  <span className="h-px flex-1 bg-smoke-200" />
                </div>
              )}
            </div>
          </div>

          {/* Detalhes técnicos — collapsed by default */}
          <div className="space-y-2">
            <SectionHeader
              title={INCIDENT_LABELS.technicalDetails}
              collapsible
              expanded={showTech}
              onToggle={() => setShowTech((v) => !v)}
            />
            {showTech && (
              <div className="space-y-1 text-sm">
                {techRows
                  .filter(([, value]) => value != null)
                  .map(([label, value]) => (
                    <div key={label} className="flex justify-between gap-4">
                      <span className="text-smoke-400">{label}</span>
                      <span className="truncate text-right font-mono text-charcoal-700">{value}</span>
                    </div>
                  ))}
              </div>
            )}
          </div>

          {/* Histórico */}
          <div className="space-y-3">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-smoke-400">
              {INCIDENT_LABELS.historyHeading}
            </h3>
            <div className="space-y-3">
              {buildTimeline(incident).map((e) => (
                <div key={e.key} className="flex items-start gap-2 text-sm">
                  <Clock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-smoke-400" />
                  <div className="min-w-0">
                    <div className="font-medium text-charcoal-900">{e.label}</div>
                    <div className="mt-0.5 text-xs text-smoke-400">
                      {formatDateTime(e.at)} · {e.actor}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Sticky action bar — only for non-terminal incidents */}
        {!terminal && (onReply || onAcknowledge || onResolve || onEscalate) && (
          <div className="sticky bottom-0 space-y-3 border-t border-smoke-200 bg-white px-6 py-4">
            {onReply && (
              <TextArea
                value={reply}
                onChange={(e) => setReply(e.target.value)}
                placeholder={INCIDENT_LABELS.replyPlaceholder}
                disabled={busy}
                className="min-h-[64px]"
              />
            )}
            <div className="flex flex-wrap items-center gap-2">
              {onAcknowledge && incident.status === 'OPEN' && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => run(onAcknowledge)}
                  className="rounded-sm bg-charcoal-600/10 px-3 py-1.5 text-xs font-medium text-charcoal-600 transition-colors hover:bg-charcoal-600/20 disabled:opacity-50"
                >
                  {ACTION_LABELS.acknowledge}
                </button>
              )}
              {onEscalate && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setConfirm('escalate')}
                  className="rounded-sm bg-accent-amber/10 px-3 py-1.5 text-xs font-medium text-accent-amber transition-colors hover:bg-accent-amber/20 disabled:opacity-50"
                >
                  {ACTION_LABELS.escalateIncident}
                </button>
              )}
              {onReply && (
                <button
                  type="button"
                  disabled={busy || !reply.trim()}
                  onClick={handleReply}
                  className="rounded-sm bg-brand-500/10 px-3 py-1.5 text-xs font-medium text-brand-700 transition-colors hover:bg-brand-500/20 disabled:opacity-50"
                >
                  {ACTION_LABELS.sendReply}
                </button>
              )}
              {onResolve && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setConfirm('resolve')}
                  className="ml-auto rounded-sm bg-accent-green/10 px-3 py-1.5 text-xs font-medium text-accent-green transition-colors hover:bg-accent-green/20 disabled:opacity-50"
                >
                  {ACTION_LABELS.resolve} ✓
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Confirmation modals (Resolver / Escalar are footguns — §4) */}
      <Modal
        isOpen={confirm === 'resolve'}
        title={INCIDENT_CONFIRM.resolveTitle}
        onClose={() => setConfirm(null)}
        footer={
          <div className="flex justify-end gap-2">
            <button
              type="button"
              className="rounded-sm border border-smoke-200 bg-smoke-50 px-4 py-1.5 text-sm text-charcoal-700 hover:bg-smoke-100"
              onClick={() => setConfirm(null)}
            >
              {INCIDENT_CONFIRM.cancel}
            </button>
            <button
              type="button"
              disabled={busy}
              className="rounded-sm bg-accent-green px-4 py-1.5 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50"
              onClick={async () => {
                setConfirm(null)
                await run(onResolve)
              }}
            >
              {INCIDENT_CONFIRM.confirm}
            </button>
          </div>
        }
      >
        <p className="text-sm text-charcoal-700">{INCIDENT_CONFIRM.resolveBody}</p>
      </Modal>

      <Modal
        isOpen={confirm === 'escalate'}
        title={INCIDENT_CONFIRM.escalateTitle}
        onClose={() => setConfirm(null)}
        footer={
          <div className="flex justify-end gap-2">
            <button
              type="button"
              className="rounded-sm border border-smoke-200 bg-smoke-50 px-4 py-1.5 text-sm text-charcoal-700 hover:bg-smoke-100"
              onClick={() => setConfirm(null)}
            >
              {INCIDENT_CONFIRM.cancel}
            </button>
            <button
              type="button"
              disabled={busy}
              className="rounded-sm bg-accent-amber px-4 py-1.5 text-sm font-medium text-white hover:bg-amber-600 disabled:opacity-50"
              onClick={async () => {
                setConfirm(null)
                await run(onEscalate)
              }}
            >
              {INCIDENT_CONFIRM.confirm}
            </button>
          </div>
        }
      >
        <p className="text-sm text-charcoal-700">{INCIDENT_CONFIRM.escalateBody}</p>
      </Modal>
    </>
  )
}
