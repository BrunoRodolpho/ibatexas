'use client'

import { useState, useEffect } from 'react'
import { Type, Save, Trash2 } from 'lucide-react'
import { PageHeader } from '../atoms/PageHeader'
import { PageSkeleton } from '../atoms/PageSkeleton'
import { ErrorBanner } from '../atoms/ErrorBanner'
import { PageShell } from '../layouts/PageShell'
import { PAGE_TITLES } from '../constants/admin-labels'

export interface AdminBannerPageProps {
  apiBase: string
}

export function AdminBannerPage({ apiBase }: Readonly<AdminBannerPageProps>) {
  const [text, setText] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const res = await fetch(`${apiBase}/api/admin/banner`, { credentials: 'include' })
        if (!res.ok) throw new Error(`Erro ${res.status}`)
        const data = await res.json() as { text: string | null }
        if (!cancelled) {
          setText(data.text ?? '')
          setLoading(false)
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Erro ao carregar')
          setLoading(false)
        }
      }
    }
    void load()
    return () => { cancelled = true }
  }, [apiBase])

  async function handleSave() {
    if (!text.trim()) return
    setSaving(true)
    setError(null)
    setSuccess(null)
    try {
      const res = await fetch(`${apiBase}/api/admin/banner`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: text.trim() }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string }
        throw new Error(body.error ?? `Erro ${res.status}`)
      }
      setSuccess('Banner atualizado com sucesso!')
      setTimeout(() => setSuccess(null), 3000)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao salvar')
    } finally {
      setSaving(false)
    }
  }

  async function handleClear() {
    setClearing(true)
    setError(null)
    setSuccess(null)
    try {
      const res = await fetch(`${apiBase}/api/admin/banner`, {
        method: 'DELETE',
        credentials: 'include',
      })
      if (!res.ok) throw new Error(`Erro ${res.status}`)
      setText('')
      setSuccess('Banner removido. O texto padrão será exibido.')
      setTimeout(() => setSuccess(null), 3000)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao limpar')
    } finally {
      setClearing(false)
    }
  }

  if (loading) {
    return (
      <PageShell>
        <PageHeader icon={Type} title={PAGE_TITLES.banner} subtitle={PAGE_TITLES.bannerSubtitle} />
        <PageSkeleton variant="list" rows={3} />
      </PageShell>
    )
  }

  return (
    <PageShell>
      <PageHeader icon={Type} title={PAGE_TITLES.banner} subtitle={PAGE_TITLES.bannerSubtitle} />

      {error && <ErrorBanner message={error} />}

      {success && (
        <div className="rounded-sm border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
          {success}
        </div>
      )}

      <div className="mt-6 max-w-xl space-y-4">
        <div>
          <label htmlFor="banner-text" className="block text-sm font-medium text-charcoal-700 mb-1">
            Texto do banner
          </label>
          <textarea
            id="banner-text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={500}
            rows={3}
            placeholder="Ex: DEFUMADO COM LENHA DE VERDADE · DESDE 2024 · IBATÉ SP"
            className="w-full rounded-sm border border-smoke-300 bg-white px-3 py-2 text-sm text-charcoal-900 placeholder:text-smoke-400 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 resize-none"
          />
          <p className="mt-1 text-xs text-smoke-500">
            {text.length}/500 caracteres. O texto será repetido e animado no banner curvado da homepage.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={handleSave}
            disabled={saving || !text.trim()}
            className="inline-flex items-center gap-2 rounded-sm bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            <Save className="h-4 w-4" />
            {saving ? 'Salvando...' : 'Salvar'}
          </button>

          <button
            onClick={handleClear}
            disabled={clearing || !text}
            className="inline-flex items-center gap-2 rounded-sm border border-smoke-300 px-4 py-2 text-sm font-medium text-charcoal-700 hover:bg-smoke-100 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            <Trash2 className="h-4 w-4" />
            {clearing ? 'Limpando...' : 'Limpar'}
          </button>
        </div>

        <div className="rounded-sm border border-smoke-200 bg-smoke-50 p-4 text-xs text-smoke-500">
          <p className="font-medium text-charcoal-700 mb-1">Como funciona</p>
          <ul className="list-disc list-inside space-y-1">
            <li>O texto aparece no banner curvado entre o hero e a seção de produtos</li>
            <li>Use o separador <code className="bg-smoke-200 px-1 rounded">·</code> entre as frases</li>
            <li>Alterações refletem na homepage em até 60 segundos</li>
            <li>Se nenhum texto estiver configurado, o texto padrão será exibido</li>
          </ul>
        </div>
      </div>
    </PageShell>
  )
}
