'use client'

// Canal Operacional — the manager/owner ↔ ops-actor chat surface (BKL-087), the
// human face of the NEW-032 AI-manager channel over POST /api/admin/ops/chat.
// A chat-style thread with a per-turn assistant bubble that surfaces the kernel
// DECISION (pt-BR badge, colored per kind), an "executado" chip when a mutation
// actually committed, and the proposed intent kinds as monospace chips. A failed
// turn renders an HONEST error bubble (the server's pt-BR text), never fake
// success. All non-trivial logic (labels, variants, entry/error shaping, the
// composer gate) lives in the PURE ops-chat.mappers module; thread state lives in
// the useOpsChat hook. pt-BR throughout (Hard Rule #4).
//
// The thread PERSISTS server-side (BKL-084) and rehydrates on reload (BKL-091):
// useOpsChat fetches GET /api/admin/ops/chat/history on mount and seeds the
// transcript. Rehydrated assistant turns are badge-less (the persisted thread
// kept no kernel decision metadata) and a "histórico carregado" divider marks the
// boundary with the live session.

import { useEffect, useRef, useState } from 'react'
import { BotMessageSquare, Send } from 'lucide-react'
import { Badge } from '@ibatexas/ui'
import { useOpsChat } from '@/domains/admin/admin.hooks'
import {
  canSend,
  decisionBadgeVariant,
  decisionLabel,
  MAX_OPS_CHAT_MESSAGE,
  type AssistantEntry,
  type OpsThreadEntry,
} from '@/domains/admin/ops-chat.mappers'

const STATELESS_CAPTION =
  'O histórico desta conversa fica salvo e é recarregado quando você reabre a tela.'

const EMPTY_HINT = 'Envie um comando para começar. Ex.: “Qual a situação da cozinha agora?”'

// ── Bubbles ──────────────────────────────────────────────────────────────────

function UserBubble({ text }: Readonly<{ text: string }>): React.JSX.Element {
  return (
    <div className="flex justify-end">
      <div className="max-w-[80%] whitespace-pre-wrap break-words rounded-sm bg-charcoal-900 px-3 py-2 text-sm text-white">
        {text}
      </div>
    </div>
  )
}

/** Small monospace chip for a proposed intent kind (e.g. order.status.transition). */
function KindChip({ kind }: Readonly<{ kind: string }>): React.JSX.Element {
  return (
    <span className="rounded-sm border border-smoke-200 bg-smoke-100 px-1.5 py-0.5 font-mono text-[11px] text-charcoal-700">
      {kind}
    </span>
  )
}

function AssistantBubble({ entry }: Readonly<{ entry: AssistantEntry }>): React.JSX.Element {
  return (
    <div className="flex justify-start">
      <div className="flex max-w-[80%] flex-col gap-2 rounded-sm border border-smoke-200 bg-white px-3 py-2">
        <p className="whitespace-pre-wrap break-words text-sm text-charcoal-900">
          {entry.reply || '(sem texto)'}
        </p>
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant={decisionBadgeVariant(entry.decision)}>{decisionLabel(entry.decision)}</Badge>
          {entry.executed ? <Badge variant="success">executado</Badge> : null}
          {entry.proposedKinds.map((kind, i) => (
            <KindChip key={`${kind}-${i}`} kind={kind} />
          ))}
        </div>
      </div>
    </div>
  )
}

function ErrorBubble({ text }: Readonly<{ text: string }>): React.JSX.Element {
  return (
    <div className="flex justify-start">
      <div className="max-w-[80%] whitespace-pre-wrap break-words rounded-sm border border-smoke-200 bg-brand-50 px-3 py-2 text-sm text-accent-red">
        {text}
      </div>
    </div>
  )
}

/**
 * A REHYDRATED assistant turn (BKL-091) — same bubble as a live one but WITHOUT
 * the badge row: the persisted thread kept no kernel decision metadata, so we
 * never fabricate a badge for it.
 */
function HistoryAssistantBubble({ text }: Readonly<{ text: string }>): React.JSX.Element {
  return (
    <div className="flex justify-start">
      <div className="max-w-[80%] whitespace-pre-wrap break-words rounded-sm border border-smoke-200 bg-white px-3 py-2 text-sm text-charcoal-900">
        {text || '(sem texto)'}
      </div>
    </div>
  )
}

/** Subtle "histórico carregado" separator between the reloaded thread and the live session. */
function HistoryDivider(): React.JSX.Element {
  return (
    <div className="flex items-center gap-2 py-1" role="separator" aria-label="Histórico carregado">
      <span className="h-px flex-1 bg-smoke-200" />
      <span className="text-[11px] uppercase tracking-wide text-smoke-400">histórico carregado</span>
      <span className="h-px flex-1 bg-smoke-200" />
    </div>
  )
}

function ThreadEntryView({ entry }: Readonly<{ entry: OpsThreadEntry }>): React.JSX.Element | null {
  switch (entry.role) {
    case 'user':
      return <UserBubble text={entry.text} />
    case 'assistant':
      return <AssistantBubble entry={entry} />
    case 'error':
      return <ErrorBubble text={entry.text} />
    case 'history-assistant':
      return <HistoryAssistantBubble text={entry.reply} />
    case 'history-divider':
      return <HistoryDivider />
    default:
      return null
  }
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function CanalOperacionalPage(): React.JSX.Element {
  const { entries, inFlight, send } = useOpsChat()
  const [draft, setDraft] = useState('')
  const threadEndRef = useRef<HTMLDivElement | null>(null)

  // Keep the newest turn (and the in-flight indicator) in view.
  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [entries, inFlight])

  const sendable = canSend(draft, inFlight)

  async function submit(): Promise<void> {
    if (!sendable) return
    const text = draft
    setDraft('')
    await send(text)
  }

  return (
    <div className="flex h-full flex-col gap-4 p-4">
      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <div className="flex items-start gap-2.5">
        <BotMessageSquare className="mt-0.5 h-5 w-5 text-charcoal-700" aria-hidden />
        <div>
          <h1 className="text-lg font-semibold text-charcoal-900">Canal Operacional</h1>
          <p className="text-sm text-smoke-500">
            Comande a operação por mensagem — fale com o agente de operações.
          </p>
          <p className="mt-1 text-xs text-smoke-400">{STATELESS_CAPTION}</p>
        </div>
      </div>

      {/* ── Thread ──────────────────────────────────────────────────────────── */}
      <div className="flex flex-1 flex-col gap-2 overflow-y-auto rounded-sm border border-smoke-200 bg-smoke-100/40 p-4">
        {entries.length === 0 ? (
          <div className="m-auto max-w-sm text-center text-sm text-smoke-400">{EMPTY_HINT}</div>
        ) : (
          entries.map((entry) => <ThreadEntryView key={entry.id} entry={entry} />)
        )}
        {inFlight ? (
          <div className="flex justify-start">
            <div className="rounded-sm border border-smoke-200 bg-white px-3 py-2 text-sm text-smoke-400">
              Processando…
            </div>
          </div>
        ) : null}
        <div ref={threadEndRef} />
      </div>

      {/* ── Composer ────────────────────────────────────────────────────────── */}
      <form
        className="flex items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <div className="flex flex-1 flex-col gap-1">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // Enter sends; Shift+Enter inserts a newline.
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void submit()
              }
            }}
            maxLength={MAX_OPS_CHAT_MESSAGE}
            rows={2}
            disabled={inFlight}
            placeholder="Escreva um comando… (Enter envia, Shift+Enter quebra linha)"
            aria-label="Mensagem para o agente de operações"
            className="w-full resize-none rounded-sm border border-smoke-200 bg-white px-3 py-2 text-sm text-charcoal-900 placeholder:text-smoke-400 focus:border-charcoal-700 focus:outline-none disabled:opacity-50"
          />
          <span className="self-end text-[11px] tabular-nums text-smoke-400">
            {draft.length}/{MAX_OPS_CHAT_MESSAGE}
          </span>
        </div>
        <button
          type="submit"
          disabled={!sendable}
          className="flex items-center gap-1.5 rounded-sm bg-charcoal-900 px-3 py-2 text-sm font-medium text-white hover:bg-charcoal-700 disabled:opacity-50"
        >
          <Send className="h-3.5 w-3.5" />
          Enviar
        </button>
      </form>
    </div>
  )
}
