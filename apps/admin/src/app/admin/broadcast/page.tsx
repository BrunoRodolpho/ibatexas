'use client'

// Admin broadcast / blast (responder-trace-admin D3). Manager-only: paste a
// recipient segment (one phone per line, E.164), a pre-approved template, send,
// and see per-recipient status. Opted-out numbers are skipped server-side.

import { useCallback, useEffect, useState } from 'react'
import { apiFetch } from '@/lib/api'
import {
  mapOptOutRecipients,
  type BroadcastOptOutResponse,
  type OptOutRecipientView,
} from '@/domains/admin/broadcast.mappers'

interface RecipientResult {
  recipient: string
  status: 'sent' | 'skipped_opted_out' | 'failed'
  error?: string
}

interface BroadcastResult {
  total: number
  sent: number
  skipped: number
  failed: number
  results: RecipientResult[]
}

function statusColor(status: RecipientResult['status']): string {
  if (status === 'sent') return 'text-green-700'
  if (status === 'failed') return 'text-red-600'
  return 'text-gray-500'
}

export default function BroadcastPage(): React.JSX.Element {
  const [recipientsText, setRecipientsText] = useState('')
  const [template, setTemplate] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<BroadcastResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [optOutPhone, setOptOutPhone] = useState('')
  const [optOutList, setOptOutList] = useState<OptOutRecipientView[]>([])

  // Load the READ-ONLY opted-out recipient list (OPS-032). Silent on failure —
  // an unavailable read hides the section rather than toast-spamming a page load.
  const loadOptOutList = useCallback(async () => {
    try {
      const res = (await apiFetch('/api/admin/broadcast/optout')) as BroadcastOptOutResponse
      setOptOutList(mapOptOutRecipients(res))
    } catch {
      setOptOutList([])
    }
  }, [])

  useEffect(() => {
    void loadOptOutList()
  }, [loadOptOutList])

  const send = useCallback(async () => {
    const recipients = recipientsText
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
    if (recipients.length === 0 || !template.trim()) return
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const res = (await apiFetch('/api/admin/broadcast', {
        method: 'POST',
        body: JSON.stringify({ recipients, template: template.trim() }),
      })) as BroadcastResult
      setResult(res)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha no disparo')
    } finally {
      setBusy(false)
    }
  }, [recipientsText, template])

  const addOptOut = useCallback(async () => {
    if (!optOutPhone.trim()) return
    setBusy(true)
    try {
      await apiFetch('/api/admin/broadcast/optout', {
        method: 'POST',
        body: JSON.stringify({ recipient: optOutPhone.trim() }),
      })
      setOptOutPhone('')
      // Keep the opted-out list in sync with the write that just landed.
      await loadOptOutList()
    } finally {
      setBusy(false)
    }
  }, [optOutPhone, loadOptOutList])

  return (
    <div className="flex flex-col gap-4 p-4">
      <h1 className="text-lg font-semibold">Disparo em massa (WhatsApp)</h1>
      <p className="max-w-prose text-xs text-gray-500">
        Use apenas templates aprovados / dentro da janela de 24h. Destinatários que
        optaram por não receber são ignorados automaticamente.
      </p>

      <div className="flex gap-4">
        <div className="flex w-1/2 flex-col gap-2">
          <label htmlFor="broadcast-recipients" className="text-sm font-medium">
            Destinatários (um por linha, E.164)
          </label>
          <textarea
            id="broadcast-recipients"
            value={recipientsText}
            onChange={(e) => setRecipientsText(e.target.value)}
            rows={8}
            placeholder={'+5511999990000\n+5511988880000'}
            className="rounded border px-2 py-1 font-mono text-xs"
          />
        </div>
        <div className="flex w-1/2 flex-col gap-2">
          <label htmlFor="broadcast-template" className="text-sm font-medium">
            Mensagem (template)
          </label>
          <textarea
            id="broadcast-template"
            value={template}
            onChange={(e) => setTemplate(e.target.value)}
            rows={8}
            placeholder="Olá! Temos uma novidade…"
            className="rounded border px-2 py-1 text-sm"
          />
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => void send()}
          disabled={busy || !template.trim() || !recipientsText.trim()}
          className="rounded bg-gray-800 px-4 py-2 text-sm text-white disabled:opacity-50"
        >
          {busy ? 'Enviando…' : 'Disparar'}
        </button>
        {error ? <span className="text-sm text-red-600">{error}</span> : null}
      </div>

      {result ? (
        <div className="flex flex-col gap-2">
          <div className="text-sm">
            Total {result.total} · enviados {result.sent} · ignorados {result.skipped} ·
            falhas {result.failed}
          </div>
          <ul className="flex max-h-64 flex-col gap-1 overflow-y-auto text-xs">
            {result.results.map((r) => (
              <li key={r.recipient} className="flex justify-between rounded border px-2 py-1">
                <span className="font-mono">{r.recipient}</span>
                <span className={statusColor(r.status)}>
                  {r.status}
                  {r.error ? ` (${r.error})` : ''}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="mt-4 flex flex-col gap-2 border-t pt-4">
        <label htmlFor="broadcast-optout" className="text-sm font-medium">
          Registrar opt-out
        </label>
        <div className="flex items-center gap-2">
          <input
            id="broadcast-optout"
            value={optOutPhone}
            onChange={(e) => setOptOutPhone(e.target.value)}
            placeholder="+5511999990000"
            className="w-64 rounded border px-2 py-1 font-mono text-xs"
          />
          <button
            type="button"
            onClick={() => void addOptOut()}
            disabled={busy || !optOutPhone.trim()}
            className="rounded border px-3 py-1 text-sm disabled:opacity-50"
          >
            Opt-out
          </button>
        </div>
      </div>

      {/* OPS-032 — READ-ONLY view of the opted-out recipients (manager-only). */}
      <div className="mt-4 flex flex-col gap-2 border-t pt-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium">
            Recipientes que optaram por não receber
          </h2>
          <span className="text-xs text-gray-500">{optOutList.length}</span>
        </div>
        {optOutList.length === 0 ? (
          <p className="text-xs text-gray-500">Nenhum destinatário optou por não receber.</p>
        ) : (
          <ul className="flex max-h-64 flex-col gap-1 overflow-y-auto text-xs">
            {optOutList.map((r) => (
              <li key={r.recipient} className="rounded border px-2 py-1 font-mono">
                {r.display}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
