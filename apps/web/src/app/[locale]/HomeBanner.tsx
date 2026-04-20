'use client'

import { useBannerText } from '@/domains/banner'
import { CurvedBanner } from '@/components/molecules/CurvedBanner'
import { useTranslations } from 'next-intl'

export function HomeBanner() {
  const { data } = useBannerText()
  const t = useTranslations('home')

  const text = data?.text ?? t('banner_default')

  return <CurvedBanner text={text} />
}
