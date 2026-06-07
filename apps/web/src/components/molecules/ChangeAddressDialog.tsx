'use client'

import { useState, useCallback } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@ibatexas/ui/atoms'
import { Modal } from '@ibatexas/ui/molecules'
import { apiFetch } from '@/lib/api'

interface ChangeAddressDialogProps {
  readonly orderId: string
  readonly isOpen: boolean
  readonly onClose: () => void
  readonly onMutate: () => void
}

type ActionState = 'idle' | 'loading' | 'success' | 'error'

export function ChangeAddressDialog({ orderId, isOpen, onClose, onMutate }: ChangeAddressDialogProps) {
  const t = useTranslations('order')
  const [actionState, setActionState] = useState<ActionState>('idle')
  const [errorMsg, setErrorMsg] = useState('')
  const [address, setAddress] = useState({
    address1: '',
    address2: '',
    city: '',
    state: '',
    postalCode: '',
    neighborhood: '',
  })

  const handleChange = useCallback((field: string, value: string) => {
    setAddress((prev) => ({ ...prev, [field]: value }))
  }, [])

  const handleSubmit = useCallback(async () => {
    setActionState('loading')
    setErrorMsg('')
    try {
      await apiFetch(`/api/orders/${orderId}/address`, {
        method: 'PATCH',
        body: JSON.stringify({ address }),
      })
      setActionState('success')
      onMutate()
      onClose()
    } catch {
      setActionState('error')
      setErrorMsg(t('change_address_error'))
    }
  }, [orderId, address, onMutate, onClose, t])

  const isValid = address.address1 && address.city && address.state && address.postalCode

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={t('change_address')}>
      {actionState === 'error' && errorMsg && (
        <p className="text-xs text-accent-red mb-3">{errorMsg}</p>
      )}

      <div className="space-y-3">
        <div className="flex flex-col gap-0.5">
          <label htmlFor="change-address-address1" className="text-xs font-medium text-[var(--color-text-secondary)]">Endereço</label>
          <input
            id="change-address-address1"
            type="text"
            placeholder="Endereço"
            value={address.address1}
            onChange={(e) => handleChange('address1', e.target.value)}
            className="w-full px-3 py-2 border border-smoke-300 rounded-md text-sm"
          />
        </div>
        <div className="flex flex-col gap-0.5">
          <label htmlFor="change-address-address2" className="text-xs font-medium text-[var(--color-text-secondary)]">Complemento (opcional)</label>
          <input
            id="change-address-address2"
            type="text"
            placeholder="Complemento (opcional)"
            value={address.address2}
            onChange={(e) => handleChange('address2', e.target.value)}
            className="w-full px-3 py-2 border border-smoke-300 rounded-md text-sm"
          />
        </div>
        <div className="flex flex-col gap-0.5">
          <label htmlFor="change-address-neighborhood" className="text-xs font-medium text-[var(--color-text-secondary)]">Bairro</label>
          <input
            id="change-address-neighborhood"
            type="text"
            placeholder="Bairro"
            value={address.neighborhood}
            onChange={(e) => handleChange('neighborhood', e.target.value)}
            className="w-full px-3 py-2 border border-smoke-300 rounded-md text-sm"
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-0.5">
            <label htmlFor="change-address-city" className="text-xs font-medium text-[var(--color-text-secondary)]">Cidade</label>
            <input
              id="change-address-city"
              type="text"
              placeholder="Cidade"
              value={address.city}
              onChange={(e) => handleChange('city', e.target.value)}
              className="w-full px-3 py-2 border border-smoke-300 rounded-md text-sm"
            />
          </div>
          <div className="flex flex-col gap-0.5">
            <label htmlFor="change-address-state" className="text-xs font-medium text-[var(--color-text-secondary)]">UF</label>
            <input
              id="change-address-state"
              type="text"
              placeholder="UF"
              maxLength={2}
              value={address.state}
              onChange={(e) => handleChange('state', e.target.value.toUpperCase())}
              className="w-full px-3 py-2 border border-smoke-300 rounded-md text-sm"
            />
          </div>
        </div>
        <div className="flex flex-col gap-0.5">
          <label htmlFor="change-address-postalcode" className="text-xs font-medium text-[var(--color-text-secondary)]">CEP</label>
          <input
            id="change-address-postalcode"
            type="text"
            placeholder="CEP"
            maxLength={9}
            value={address.postalCode}
            onChange={(e) => handleChange('postalCode', e.target.value)}
            className="w-full px-3 py-2 border border-smoke-300 rounded-md text-sm"
          />
        </div>
      </div>

      <div className="flex gap-2 justify-end mt-4">
        <Button variant="secondary" size="sm" onClick={onClose}>
          Voltar
        </Button>
        <Button
          variant="primary"
          size="sm"
          isLoading={actionState === 'loading'}
          disabled={!isValid}
          onClick={handleSubmit}
        >
          Salvar
        </Button>
      </div>
    </Modal>
  )
}
