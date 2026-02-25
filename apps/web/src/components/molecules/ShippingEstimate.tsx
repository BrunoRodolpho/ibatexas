'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { useShippingEstimate } from '@/hooks/api'
import { Button, TextField, Text } from '../atoms'

export const ShippingEstimate = () => {
  const t = useTranslations()
  const [cepInput, setCepInput] = useState('')
  const [formattedCep, setFormattedCep] = useState('')
  
  // Only query when we have 8 digits
  const cleanCep = cepInput.replace(/\D/g, '')
  const { data, loading, error } = useShippingEstimate(
    cleanCep.length === 8 ? cleanCep : undefined
  )

  // Format CEP mask: 00000-000
  const handleCepChange = (value: string) => {
    const numbers = value.replace(/\D/g, '').slice(0, 8)
    setCepInput(numbers)
    
    if (numbers.length >= 5) {
      setFormattedCep(`${numbers.slice(0, 5)}-${numbers.slice(5)}`)
    } else {
      setFormattedCep(numbers)
    }
  }

  const handleCalculate = () => {
    // Input is already updating the query via the hook
    // This could trigger additional validation if needed
  }

  const formatCurrency = (amount: number): string => {
    return amount.toLocaleString('pt-BR', {
      style: 'currency',
      currency: 'BRL',
    })
  }

  return (
    <div className="border rounded-lg p-4 bg-slate-50">
      <Text className="font-medium text-slate-900 mb-3">
        {t('shop.shipping.title')}
      </Text>
      
      <div className="space-y-4">
        <div className="flex gap-3">
          <div className="flex-1">
            <TextField
              placeholder={t('shop.shipping.cep_placeholder')}
              value={formattedCep}
              onChange={(e) => handleCepChange(e.target.value)}
              maxLength={9}
              className="font-mono"
            />
          </div>
          <Button
            variant="secondary"
            size="sm"
            onClick={handleCalculate}
            disabled={cleanCep.length !== 8 || loading}
          >
            {loading ? t('common.loading') : t('shop.shipping.calculate')}
          </Button>
        </div>
        
        {error && (
          <Text variant="small" className="text-red-600">
            {error.message}
          </Text>
        )}
        
        {data?.options && (
          <div className="space-y-3">
            <Text className="font-medium text-slate-900">
              {t('shop.shipping.options')}
            </Text>
            
            <div className="space-y-2">
              {data.options.map((option) => (
                <div 
                  key={option.service} 
                  className="flex items-center justify-between p-3 bg-white rounded border"
                >
                  <div>
                    <Text className="font-medium">
                      {option.service === 'PAC' ? t('shop.shipping.pac') : t('shop.shipping.sedex')}
                    </Text>
                    <Text variant="small" className="text-slate-600">
                      {option.estimatedDays} {t('shop.shipping.business_days')}
                    </Text>
                  </div>
                  <Text className="font-bold text-slate-900">
                    {formatCurrency(option.price / 100)}
                  </Text>
                </div>
              ))}
            </div>
            
            <Text variant="xs" className="text-slate-500">
              ✓ {t('shop.shipping.info')} • {t('shop.shipping.origin')}
            </Text>
          </div>
        )}
      </div>
    </div>
  )
}