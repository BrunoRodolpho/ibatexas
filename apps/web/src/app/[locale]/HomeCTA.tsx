'use client'

import { useTranslations } from 'next-intl'
import { Button } from '@/components/atoms'
import { useUIStore } from '@/stores/useUIStore'

export default function HomeCTA() {
  const t = useTranslations()
  const setChat = useUIStore((s) => s.setChat)

  return (
    <Button variant="brand" size="lg" onClick={() => setChat(true)}>
      {t('home.cta_button_ai')}
    </Button>
  )
}
