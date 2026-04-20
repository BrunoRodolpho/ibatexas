'use client'

import { useState, useCallback } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@ibatexas/ui/atoms'
import { apiFetch } from '@/lib/api'

interface Note {
  id: string
  author: string
  authorId?: string | null
  content: string
  createdAt: string
}

interface OrderNotesProps {
  readonly orderId: string
  readonly notes: Note[]
  /** Whether the order is in a state that allows adding notes */
  readonly canAdd: boolean
  /** Called after a note is added so parent can refetch */
  readonly onMutate: () => void
}

export function OrderNotes({ orderId, notes, canAdd, onMutate }: OrderNotesProps) {
  const t = useTranslations('order')
  const [text, setText] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const handleSubmit = useCallback(async () => {
    if (!text.trim()) return
    setSaving(true)
    setError('')
    try {
      await apiFetch(`/api/orders/${orderId}/notes`, {
        method: 'POST',
        body: JSON.stringify({ content: text.trim() }),
      })
      setText('')
      onMutate()
    } catch {
      setError(t('notes_error'))
    } finally {
      setSaving(false)
    }
  }, [orderId, text, onMutate])

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold text-charcoal-900">{t('notes_title')}</h3>

      {notes.length === 0 && !canAdd && (
        <p className="text-xs text-smoke-500">{t('notes_empty')}</p>
      )}

      {notes.length > 0 && (
        <ul className="space-y-2">
          {notes.map((note) => (
            <li key={note.id} className="text-sm text-charcoal-700 bg-smoke-50 rounded-sm px-3 py-2">
              <p>{note.content}</p>
              <p className="text-micro text-smoke-400 mt-1">
                {new Date(note.createdAt).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
              </p>
            </li>
          ))}
        </ul>
      )}

      {canAdd && (
        <div className="flex gap-2">
          <input
            type="text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleSubmit() }}
            placeholder={t('notes_placeholder')}
            maxLength={500}
            className="flex-1 text-sm border border-smoke-200 rounded-sm px-3 py-1.5 bg-white focus:outline-none focus:ring-1 focus:ring-brand-500"
          />
          <Button
            variant="secondary"
            size="sm"
            isLoading={saving}
            disabled={!text.trim()}
            onClick={handleSubmit}
          >
            {t('notes_add')}
          </Button>
        </div>
      )}

      {error && <p className="text-xs text-accent-red">{error}</p>}
    </div>
  )
}
