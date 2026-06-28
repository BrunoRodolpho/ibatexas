'use client'

// Admin conversation history + search + correlate (responder-trace-admin D1).
//
// Staff-authed (the proxy adds x-admin-key; the API enforces the DOM-001 guard).
// Search a customer's conversations by sessionId / customerId / phone, read the
// (un-redacted, staff-only) transcript, and cross-link to the customer's orders.

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { apiFetch } from '@/lib/api'

interface ConversationSummary {
  id: string
  sessionId: string
  customerId: string | null
  channel: string
  messageCount: number
  lastMessageAt: string | null
}

interface TranscriptMessage {
  role: string
  content: string
  sentAt: string
  metadata?: unknown
}

interface Transcript {
  sessionId: string
  customerId: string | null
  channel: string | null
  messages: TranscriptMessage[]
}

type SearchField = 'customerId' | 'phone' | 'sessionId'

export default function ConversasPage(): React.JSX.Element {
  const [field, setField] = useState<SearchField>('customerId')
  const [value, setValue] = useState('')
  const [conversations, setConversations] = useState<ConversationSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [transcript, setTranscript] = useState<Transcript | null>(null)

  const search = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const qs = new URLSearchParams()
      if (value.trim()) qs.set(field, value.trim())
      const data = (await apiFetch(`/api/admin/conversations?${qs.toString()}`)) as {
        conversations: ConversationSummary[]
      }
      setConversations(data.conversations ?? [])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erro ao buscar conversas')
    } finally {
      setLoading(false)
    }
  }, [field, value])

  // Initial load: recent conversations.
  useEffect(() => {
    void search()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once on mount
  }, [])

  useEffect(() => {
    if (!selected) {
      setTranscript(null)
      return
    }
    let cancelled = false
    apiFetch(`/api/admin/conversations/${encodeURIComponent(selected)}`)
      .then((data: unknown) => {
        if (!cancelled) setTranscript(data as Transcript)
      })
      .catch(() => {
        if (!cancelled) setTranscript(null)
      })
    return () => {
      cancelled = true
    }
  }, [selected])

  return (
    <div className="flex h-full gap-4 p-4">
      {/* List + search */}
      <div className="flex w-1/2 flex-col gap-3">
        <h1 className="text-lg font-semibold">Conversas</h1>
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            void search()
          }}
        >
          <select
            value={field}
            onChange={(e) => setField(e.target.value as SearchField)}
            className="rounded border px-2 py-1 text-sm"
          >
            <option value="customerId">Cliente (ID)</option>
            <option value="phone">Telefone</option>
            <option value="sessionId">Sessão</option>
          </select>
          <input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="buscar…"
            className="flex-1 rounded border px-2 py-1 text-sm"
          />
          <button type="submit" className="rounded bg-gray-800 px-3 py-1 text-sm text-white">
            Buscar
          </button>
        </form>

        {error ? <p className="text-sm text-red-600">{error}</p> : null}
        {loading ? <p className="text-sm text-gray-500">Carregando…</p> : null}

        <ul className="flex flex-col gap-1 overflow-y-auto">
          {conversations.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => setSelected(c.sessionId)}
                className={`w-full rounded border px-3 py-2 text-left text-sm hover:bg-gray-50 ${
                  selected === c.sessionId ? 'border-gray-800 bg-gray-50' : ''
                }`}
              >
                <div className="flex justify-between">
                  <span className="font-mono text-xs">{c.sessionId.slice(0, 24)}</span>
                  <span className="text-xs text-gray-500">{c.channel}</span>
                </div>
                <div className="text-xs text-gray-500">
                  {c.messageCount} msgs ·{' '}
                  {c.lastMessageAt ? new Date(c.lastMessageAt).toLocaleString('pt-BR') : '—'}
                </div>
              </button>
            </li>
          ))}
          {!loading && conversations.length === 0 ? (
            <li className="text-sm text-gray-500">Nenhuma conversa encontrada.</li>
          ) : null}
        </ul>
      </div>

      {/* Transcript */}
      <div className="flex w-1/2 flex-col gap-3 overflow-y-auto">
        {transcript ? (
          <>
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold">Transcrição</h2>
              {transcript.customerId ? (
                <Link
                  href={`/admin/pedidos?customerId=${encodeURIComponent(transcript.customerId)}`}
                  className="text-xs text-blue-600 underline"
                >
                  Ver pedidos do cliente →
                </Link>
              ) : (
                <span className="text-xs italic text-gray-400">cliente não identificado</span>
              )}
            </div>
            <div className="flex flex-col gap-2">
              {transcript.messages.map((m, i) => (
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
              {transcript.messages.length === 0 ? (
                <p className="text-sm text-gray-500">Sem mensagens.</p>
              ) : null}
            </div>
          </>
        ) : (
          <p className="text-sm text-gray-500">Selecione uma conversa para ver a transcrição.</p>
        )}
      </div>
    </div>
  )
}
