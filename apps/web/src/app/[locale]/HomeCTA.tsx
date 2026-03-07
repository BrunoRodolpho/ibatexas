'use client'

import { useTranslations } from 'next-intl'
import { Button, LinkButton } from '@/components/atoms'
import { useUIStore } from '@/domains/ui'

export default function HomeCTA() {
  const t = useTranslations()
  const setChat = useUIStore((s) => s.setChat)

  return (
    <div className="mt-8 flex flex-col sm:flex-row items-center gap-3">
      <LinkButton href="/search" variant="brand" size="lg">
        {t('home.cta_button_menu')}
      </LinkButton>
      <Button variant="secondary" size="lg" onClick={() => setChat(true)}>
        {t('home.cta_button_ai')}
      </Button>
    </div>
  )
}
