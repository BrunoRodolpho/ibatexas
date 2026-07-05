'use client'

// Admin take-over queue (responder-trace-admin D2). Staff see open escalations,
// read the transcript, reply (delivered live on WhatsApp, recorded for web),
// and resolve — which un-pauses the bot for that session.

import { useCallback, useEffect, useState } from 'react'
import { apiFetch } from '@/lib/api'

interface PendingIntent {
  token: string
  intentKind: string
  intentHash: string
  summaryPtBr: string
  requestedAt: string
  status: 'pending' | 'approved' | 'rejected' | 'denied_by_kernel' | 'expired'
  resolvedBy?: string
}

interface Escalation {
  sessionId: string
  customerId: string | null
  reason: string | null
  channel: string | null
  handoffAt: string
  status: 'open' | 'resolved'
  pendingIntents?: PendingIntent[]
}

interface TranscriptMessage {
  role: string
  content: string
  sentAt: string
}

export default function EscalacoesPage(): React.JSX.Element {
  const [queue, setQueue] = useState<Escalation[]>([])
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [messages, setMessages] = useState<TranscriptMessage[]>([])
  const [reply, setReply] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const loadQueue = useCallback(async () => {
    setLoading(true)
    try {
      const data = (await apiFetch('/api/admin/escalations')) as { escalations: Escalation[] }
      setQueue(data.escalations ?? [])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadQueue()
  }, [loadQueue])

  const loadTranscript = useCallback(async (sessionId: string) => {
    const data = (await apiFetch(
      `/api/admin/conversations/${encodeURIComponent(sessionId)}`,
    )) as { messages: TranscriptMessage[] }
    setMessages(data.messages ?? [])
  }, [])

  useEffect(() => {
    if (selected) void loadTranscript(selected)
    else setMessages([])
  }, [selected, loadTranscript])

  const sendReply = useCallback(async () => {
    if (!selected || !reply.trim()) return
    setBusy(true)
    setNotice(null)
    try {
      const res = (await apiFetch(`/api/admin/escalations/${encodeURIComponent(selected)}/reply`, {
        method: 'POST',
        body: JSON.stringify({ text: reply.trim() }),
      })) as { delivered: boolean; channel: string | null }
      setReply('')
      setNotice(res.delivered ? 'Enviado ao cliente.' : 'Registrado (não entregue ao vivo).')
      await loadTranscript(selected)
    } catch {
      setNotice('Falha ao enviar a resposta.')
    } finally {
      setBusy(false)
    }
  }, [selected, reply, loadTranscript])

  const resolve = useCallback(async () => {
    if (!selected) return
    setBusy(true)
    try {
      await apiFetch(`/api/admin/escalations/${encodeURIComponent(selected)}/resolve`, {
        method: 'POST',
      })
      setSelected(null)
      await loadQueue()
    } finally {
      setBusy(false)
    }
  }, [selected, loadQueue])

  // AUT-017 — OWNER approves/rejects a parked escalated money intent. On approval
  // the API re-adjudicates the parked envelope and, on EXECUTE, runs the refund.
  const resolveIntent = useCallback(
    async (token: string, accept: boolean) => {
      if (!selected) return
      setBusy(true)
      setNotice(null)
      try {
        const res = (await apiFetch(
          `/api/admin/escalations/${encodeURIComponent(selected)}/intents/${encodeURIComponent(token)}/resolve`,
          { method: 'POST', body: JSON.stringify({ accept }) },
        )) as { status?: string; refusalPtBr?: string }
        if (res.status === 'approved') setNotice('Ação aprovada e executada.')
        else if (res.status === 'rejected') setNotice('Ação recusada.')
        else setNotice(res.refusalPtBr ?? 'Aprovação não pôde ser aplicada.')
      } catch {
        setNotice('Falha ao processar a aprovação.')
      } finally {
        setBusy(false)
        await loadQueue()
      }
    },
    [selected, loadQueue],
  )

  const selectedRec = queue.find((e) => e.sessionId === selected)
  const pendingIntents = (selectedRec?.pendingIntents ?? []).filter(
    (p) => p.status === 'pending',
  )

  return (
    <div className="flex h-full gap-4 p-4">
      <div className="flex w-1/2 flex-col gap-3">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-semibold">Escalações (take-over)</h1>
          <button
            type="button"
            onClick={() => void loadQueue()}
            className="rounded border px-2 py-1 text-xs"
          >
            Atualizar
          </button>
        </div>
        {loading ? <p className="text-sm text-gray-500">Carregando…</p> : null}
        <ul className="flex flex-col gap-1 overflow-y-auto">
          {queue.map((e) => (
            <li key={e.sessionId}>
              <button
                type="button"
                onClick={() => setSelected(e.sessionId)}
                className={`w-full rounded border px-3 py-2 text-left text-sm hover:bg-gray-50 ${
                  selected === e.sessionId ? 'border-gray-800 bg-gray-50' : ''
                }`}
              >
                <div className="flex justify-between">
                  <span className="font-mono text-xs">{e.sessionId.slice(0, 24)}</span>
                  <span className="text-xs text-gray-500">{e.channel ?? '—'}</span>
                </div>
                <div className="text-xs text-gray-500">
                  {e.reason ?? 'sem motivo'} · {new Date(e.handoffAt).toLocaleString('pt-BR')}
                </div>
              </button>
            </li>
          ))}
          {!loading && queue.length === 0 ? (
            <li className="text-sm text-gray-500">Nenhuma escalação aberta. 🎉</li>
          ) : null}
        </ul>
      </div>

      <div className="flex w-1/2 flex-col gap-3 overflow-y-auto">
        {selected ? (
          <>
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold">Transcrição</h2>
              <button
                type="button"
                onClick={() => void resolve()}
                disabled={busy}
                className="rounded bg-green-700 px-3 py-1 text-xs text-white disabled:opacity-50"
              >
                Resolver (reativar bot)
              </button>
            </div>
            {pendingIntents.length > 0 ? (
              <div className="flex flex-col gap-2">
                {pendingIntents.map((p) => (
                  <div
                    key={p.token}
                    className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm"
                  >
                    <div className="mb-1 font-semibold text-amber-900">
                      ⚠️ Pendente de aprovação (OWNER)
                    </div>
                    <div className="mb-2 text-amber-900">{p.summaryPtBr}</div>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => void resolveIntent(p.token, true)}
                        disabled={busy}
                        className="rounded bg-green-700 px-3 py-1 text-xs text-white disabled:opacity-50"
                      >
                        Aprovar e executar
                      </button>
                      <button
                        type="button"
                        onClick={() => void resolveIntent(p.token, false)}
                        disabled={busy}
                        className="rounded border border-gray-400 px-3 py-1 text-xs disabled:opacity-50"
                      >
                        Recusar
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
            <div className="flex flex-1 flex-col gap-2">
              {messages.map((m, i) => (
                <div
                  key={i}
                  className={`rounded border px-3 py-2 text-sm ${
                    m.role === 'user' ? 'bg-blue-50' : 'bg-gray-50'
                  }`}
                >
                  <div className="mb-1 flex justify-between text-xs text-gray-500">
                    <span>{m.role}</span>
                    <span>{new Date(m.sentAt).toLocaleString('pt-BR')}</span>
                  </div>
                  <div className="whitespace-pre-wrap break-words">{m.content}</div>
                </div>
              ))}
            </div>
            {notice ? <p className="text-xs text-gray-600">{notice}</p> : null}
            <form
              className="flex items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault()
                void sendReply()
              }}
            >
              <input
                value={reply}
                onChange={(e) => setReply(e.target.value)}
                placeholder="responder ao cliente…"
                className="flex-1 rounded border px-2 py-1 text-sm"
                disabled={busy}
              />
              <button
                type="submit"
                disabled={busy || !reply.trim()}
                className="rounded bg-gray-800 px-3 py-1 text-sm text-white disabled:opacity-50"
              >
                Enviar
              </button>
            </form>
          </>
        ) : (
          <p className="text-sm text-gray-500">Selecione uma escalação para responder.</p>
        )}
      </div>
    </div>
  )
}
