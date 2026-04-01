'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { useShippingEstimate } from '@/domains/shipping'
import { formatBRL } from '@/lib/format'
import { Button, TextField, Text } from '../atoms'

export const ShippingEstimate = () => {
  const t = useTranslations()
  const [cepInput, setCepInput] = useState('')
  const [formattedCep, setFormattedCep] = useState('')
  
  // Only query when we have 8 digits
  const cleanCep = cepInput.replaceAll(/\D/g, '')
  const { data, loading, error } = useShippingEstimate(
    cleanCep.length === 8 ? cleanCep : undefined
  )

  // Format CEP mask: 00000-000
  const handleCepChange = (value: string) => {
    const numbers = value.replaceAll(/\D/g, '').slice(0, 8)
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

  return (
    <div className="border border-smoke-200 rounded-sm p-4 bg-smoke-50">
      <Text className="font-medium text-charcoal-900 mb-3">
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
          <Text variant="small" className="text-accent-red">
            {error.message}
          </Text>
        )}
        
        {data?.options && (
          <div className="space-y-3">
            <Text className="font-medium text-charcoal-900">
              {t('shop.shipping.options')}
            </Text>
            
            <div className="space-y-2">
              {data.options.map((option) => (
                <div 
                  key={option.service} 
                  className="flex items-center justify-between p-3 bg-smoke-100 rounded-sm border border-smoke-200"
                >
                  <div>
                    <Text className="font-medium">
                      {option.service === 'PAC' ? t('shop.shipping.pac') : t('shop.shipping.sedex')}
                    </Text>
                    <Text variant="small" className="text-[var(--color-text-secondary)]">
                      {option.estimatedDays} {t('shop.shipping.business_days')}
                    </Text>
                  </div>
                  <Text className="font-bold text-charcoal-900">
                    {formatBRL(option.price)}
                  </Text>
                </div>
              ))}
            </div>
            
            <Text variant="xs" className="text-[var(--color-text-secondary)]">
              ✓ {t('shop.shipping.info')} • {t('shop.shipping.origin')}
            </Text>
          </div>
        )}
      </div>
    </div>
  )
}