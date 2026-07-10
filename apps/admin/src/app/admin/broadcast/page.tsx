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

// S5 — a human summary of the filters that were ACTUALLY applied, so the manager
// can confirm the segment matches intent (and notice when a described clause the
// keyword parser doesn't understand was silently dropped).
function specSummary(spec: Record<string, string>): string {
  const parts: string[] = []
  if (spec.orderedFrom || spec.orderedTo)
    parts.push(`pedidos de ${spec.orderedFrom ?? '…'} a ${spec.orderedTo ?? '…'}`)
  if (spec.createdFrom || spec.createdTo)
    parts.push(`cadastro de ${spec.createdFrom ?? '…'} a ${spec.createdTo ?? '…'}`)
  if (spec.source) parts.push(`origem ${spec.source}`)
  return parts.join(' · ')
}

export default function BroadcastPage(): React.JSX.Element {
  const [recipientsText, setRecipientsText] = useState('')
  const [template, setTemplate] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<BroadcastResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [optOutPhone, setOptOutPhone] = useState('')
  const [optOutList, setOptOutList] = useState<OptOutRecipientView[]>([])
  // LGPD consent revocation — the write must never fail silently, or the manager
  // believes a customer was opted out when they were not.
  const [optOutNotice, setOptOutNotice] = useState<{ ok: boolean; text: string } | null>(null)
  // WS3D — audience builder
  const [audienceQuery, setAudienceQuery] = useState('')
  const [audienceSource, setAudienceSource] = useState('')
  const [preview, setPreview] = useState<{ count: number; recipients: string[]; sample: string[] } | null>(null)
  const [previewing, setPreviewing] = useState(false)
  // S5 — the spec that produced the current preview (for the applied-filters line).
  const [appliedSpec, setAppliedSpec] = useState<Record<string, string> | null>(null)

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

  // WS3D — compile the (whitelisted) audience spec. The NL box is parsed for a
  // few common Portuguese windows for v1; a full LLM NL→spec layer can replace
  // this parser and POST the SAME structured spec to the same safe endpoint.
  const buildSpec = useCallback((): Record<string, string> => {
    const q = audienceQuery.toLowerCase()
    const spec: Record<string, string> = {}
    const ymd = (d: Date): string => d.toISOString().slice(0, 10)
    const now = new Date()
    if (q.includes('mês passado') || q.includes('mes passado')) {
      spec.orderedFrom = ymd(new Date(now.getFullYear(), now.getMonth() - 1, 1))
      spec.orderedTo = ymd(new Date(now.getFullYear(), now.getMonth(), 1)) // exclusive
    } else if (q.includes('30 dias') || q.includes('último mês') || q.includes('ultimo mes')) {
      const from = new Date(now)
      from.setDate(now.getDate() - 30)
      const to = new Date(now)
      to.setDate(now.getDate() + 1)
      spec.orderedFrom = ymd(from)
      spec.orderedTo = ymd(to)
    }
    if (audienceSource) spec.source = audienceSource
    return spec
  }, [audienceQuery, audienceSource])

  const previewAudience = useCallback(async () => {
    const spec = buildSpec()
    // S5 — never preview (or load) the ENTIRE base by accident. An empty spec means
    // the described filter wasn't understood (or nothing was specified); tell the
    // manager instead of silently querying everyone.
    if (Object.keys(spec).length === 0) {
      setPreview(null)
      setAppliedSpec(null)
      setError(
        audienceQuery.trim()
          ? 'Não entendi esse filtro. Use “mês passado” ou “últimos 30 dias” (por data do pedido) e/ou selecione uma origem.'
          : 'Descreva um período (ex.: “mês passado”) ou selecione uma origem para montar o público.',
      )
      return
    }
    setPreviewing(true)
    setError(null)
    try {
      const res = (await apiFetch('/api/admin/broadcast/audience/preview', {
        method: 'POST',
        body: JSON.stringify(spec),
      })) as { count: number; recipients: string[]; sample: string[] }
      setPreview(res)
      setAppliedSpec(spec)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao prever o público')
    } finally {
      setPreviewing(false)
    }
  }, [buildSpec, audienceQuery])

  const useAudience = useCallback(() => {
    if (preview) setRecipientsText(preview.recipients.join('\n'))
  }, [preview])

  const addOptOut = useCallback(async () => {
    if (!optOutPhone.trim()) return
    setBusy(true)
    setOptOutNotice(null)
    try {
      const registered = optOutPhone.trim()
      await apiFetch('/api/admin/broadcast/optout', {
        method: 'POST',
        body: JSON.stringify({ recipient: registered }),
      })
      setOptOutPhone('')
      // Keep the opted-out list in sync with the write that just landed.
      await loadOptOutList()
      setOptOutNotice({ ok: true, text: `Opt-out registrado para ${registered}.` })
    } catch {
      // The consent revocation did NOT land — surface it explicitly so the
      // manager does not assume the customer was opted out.
      setOptOutNotice({
        ok: false,
        text: 'Falha ao registrar o opt-out. O cliente NÃO foi removido — tente novamente.',
      })
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

      {/* WS3D — audience builder: describe or filter a segment, preview the
          consent-filtered count, then load it as recipients. */}
      <div className="flex flex-col gap-2 rounded border border-blue-200 bg-blue-50/40 p-3">
        <label htmlFor="audience-query" className="text-sm font-medium">
          Montar público
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <input
            id="audience-query"
            value={audienceQuery}
            onChange={(e) => setAudienceQuery(e.target.value)}
            placeholder="descreva (ex.: clientes que pediram mês passado)"
            className="min-w-[16rem] flex-1 rounded border px-2 py-1 text-sm"
          />
          <select
            value={audienceSource}
            onChange={(e) => setAudienceSource(e.target.value)}
            className="rounded border px-2 py-1 text-sm"
            aria-label="Origem do cliente"
          >
            <option value="">Qualquer origem</option>
            <option value="whatsapp">WhatsApp</option>
            <option value="web">Web</option>
          </select>
          <button
            type="button"
            onClick={() => void previewAudience()}
            disabled={previewing}
            className="rounded bg-blue-700 px-3 py-1 text-sm text-white disabled:opacity-50"
          >
            {previewing ? 'Prevendo…' : 'Prever público'}
          </button>
        </div>
        {preview ? (
          <div className="flex flex-col gap-1 text-xs text-gray-700">
            {appliedSpec ? (
              <span className="text-gray-500">Filtros aplicados: {specSummary(appliedSpec)}</span>
            ) : null}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span>
                {preview.count} destinatário(s) — opt-outs já excluídos
                {preview.sample.length > 0 ? ` · ex.: ${preview.sample.slice(0, 3).join(', ')}` : ''}
              </span>
              <button
                type="button"
                onClick={useAudience}
                disabled={preview.count === 0}
                className="rounded border border-blue-300 px-2 py-1 font-medium text-blue-700 disabled:opacity-50"
              >
                Usar como destinatários →
              </button>
            </div>
          </div>
        ) : (
          <p className="text-xs text-gray-500">
            Entende “mês passado” e “últimos 30 dias” (por data do pedido) + origem. Consulta
            estruturada e parametrizada — nunca SQL livre; opt-outs são sempre removidos.
          </p>
        )}
      </div>

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
          {optOutNotice ? (
            <span
              className={`text-sm ${optOutNotice.ok ? 'text-green-700' : 'text-red-600'}`}
            >
              {optOutNotice.text}
            </span>
          ) : null}
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
