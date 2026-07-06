'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { MapPin, Trash2 } from 'lucide-react'
import {
  listAddresses,
  addAddress,
  removeAddress,
  isCompleteAddress,
  type SavedAddress,
  type NewAddress,
} from '@/domains/account/addresses'

/**
 * CUS-063 (web view) — saved-addresses book. Lists the customer's addresses and
 * lets them add / remove through the governed /api/me/addresses routes (removal
 * ownership-scoped server-side). The submit is gated on isCompleteAddress so the
 * customer never hits the server 400.
 */
const EMPTY_FORM: NewAddress = {
  street: '',
  number: '',
  complement: '',
  neighborhood: '',
  city: '',
  state: '',
  zip: '',
}

export function AddressBookCard(): React.JSX.Element {
  const t = useTranslations('account')
  const [addresses, setAddresses] = useState<SavedAddress[] | null>(null)
  const [form, setForm] = useState<NewAddress>(EMPTY_FORM)
  const [adding, setAdding] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    listAddresses().then((a) => {
      if (alive) setAddresses(a)
    })
    return () => {
      alive = false
    }
  }, [])

  function patch(p: Partial<NewAddress>): void {
    setError(null)
    setForm((prev) => ({ ...prev, ...p }))
  }

  async function handleAdd(): Promise<void> {
    if (!isCompleteAddress(form)) {
      setError(t('address_book.incomplete'))
      return
    }
    setBusy(true)
    setError(null)
    try {
      const created = await addAddress(form)
      setAddresses((prev) => [...(prev ?? []), created])
      setForm(EMPTY_FORM)
      setAdding(false)
    } catch {
      setError(t('address_book.error'))
    } finally {
      setBusy(false)
    }
  }

  async function handleRemove(id: string): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      await removeAddress(id)
      setAddresses((prev) => (prev ?? []).filter((a) => a.id !== id))
    } catch {
      setError(t('address_book.error'))
    } finally {
      setBusy(false)
    }
  }

  const field = (
    key: keyof NewAddress,
    label: string,
    extra?: { maxLength?: number; className?: string },
  ) => (
    <label className="flex flex-col gap-1 text-sm text-charcoal-700">
      {label}
      <input
        type="text"
        value={(form[key] as string) ?? ''}
        disabled={busy}
        maxLength={extra?.maxLength}
        onChange={(e) => patch({ [key]: e.target.value } as Partial<NewAddress>)}
        className={`rounded-sm border border-smoke-200 bg-white p-2 text-sm disabled:opacity-50 ${extra?.className ?? ''}`}
      />
    </label>
  )

  return (
    <div className="rounded-sm shadow-card border border-smoke-200/40 bg-smoke-50 p-5 hover:shadow-card-hover hover:-translate-y-0.5 transition-premium md:col-span-2">
      <div className="flex items-center gap-2">
        <MapPin className="w-4 h-4 text-smoke-400" />
        <h2 className="text-micro font-semibold uppercase tracking-editorial text-smoke-400">
          {t('address_book.title')}
        </h2>
      </div>
      <p className="mt-3 text-sm text-smoke-400">{t('address_book.description')}</p>

      {addresses !== null && addresses.length === 0 && !adding && (
        <p className="mt-3 text-sm text-smoke-400">{t('address_book.empty')}</p>
      )}

      {addresses !== null && addresses.length > 0 && (
        <ul className="mt-3 space-y-2">
          {addresses.map((a) => (
            <li key={a.id} className="flex items-start justify-between gap-3 text-sm text-charcoal-700">
              <span>
                {a.street}, {a.number}
                {a.complement ? ` — ${a.complement}` : ''} · {a.district} · {a.city}/{a.state} · {a.cep}
                {a.isDefault && (
                  <span className="ml-2 text-micro uppercase tracking-editorial text-brand-600">
                    {t('address_book.default_badge')}
                  </span>
                )}
              </span>
              <button
                type="button"
                onClick={() => handleRemove(a.id)}
                disabled={busy}
                aria-label={t('address_book.remove')}
                className="text-accent-red hover:text-accent-red/80 transition-micro disabled:opacity-50 flex-shrink-0"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </li>
          ))}
        </ul>
      )}

      {adding ? (
        <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
          {field('street', t('address_book.street'), { maxLength: 200 })}
          {field('number', t('address_book.number'), { maxLength: 20 })}
          {field('complement', t('address_book.complement'), { maxLength: 100 })}
          {field('neighborhood', t('address_book.neighborhood'), { maxLength: 120 })}
          {field('city', t('address_book.city'), { maxLength: 120 })}
          {field('state', t('address_book.state'), { maxLength: 2 })}
          {field('zip', t('address_book.zip'), { maxLength: 9 })}
          <label className="flex items-center gap-2 text-sm text-charcoal-700 sm:col-span-2">
            <input
              type="checkbox"
              checked={form.isDefault ?? false}
              disabled={busy}
              onChange={(e) => patch({ isDefault: e.target.checked })}
            />
            {t('address_book.set_default')}
          </label>
          <div className="flex gap-4 sm:col-span-2">
            <button
              type="button"
              onClick={handleAdd}
              disabled={busy}
              className="text-sm text-charcoal-700 hover:text-charcoal-900 font-medium transition-micro disabled:opacity-50"
            >
              {busy ? t('address_book.adding') : `${t('address_book.save')} →`}
            </button>
            <button
              type="button"
              onClick={() => {
                setAdding(false)
                setForm(EMPTY_FORM)
                setError(null)
              }}
              disabled={busy}
              className="text-sm text-smoke-400 hover:text-charcoal-700 transition-micro disabled:opacity-50"
            >
              {t('address_book.cancel')}
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          disabled={addresses === null}
          className="mt-3 inline-block text-sm text-charcoal-700 hover:text-charcoal-900 font-medium transition-micro disabled:opacity-50"
        >
          {`${t('address_book.add')} →`}
        </button>
      )}

      {error && <p className="mt-2 text-sm text-accent-red">{error}</p>}
    </div>
  )
}
