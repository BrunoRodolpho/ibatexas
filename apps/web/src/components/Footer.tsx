"use client"

import { Link } from "@/i18n/navigation"
import { useTranslations } from "next-intl"
import { Container } from '@/components/atoms'

export function Footer() {
  const t = useTranslations()

  const phone = process.env.NEXT_PUBLIC_PHONE || ''
  const address = process.env.NEXT_PUBLIC_ADDRESS || ''
  const instagramUrl = process.env.NEXT_PUBLIC_INSTAGRAM_URL || ''
  const facebookUrl = process.env.NEXT_PUBLIC_FACEBOOK_URL || ''
  const whatsappUrl = process.env.NEXT_PUBLIC_WHATSAPP_URL || ''
  const hoursWeekday = process.env.NEXT_PUBLIC_HOURS_WEEKDAY || ''
  const hoursSaturday = process.env.NEXT_PUBLIC_HOURS_SATURDAY || ''
  const hoursSunday = process.env.NEXT_PUBLIC_HOURS_SUNDAY || ''

  return (
    <footer className="bg-charcoal-900 text-smoke-300">
      <Container size="xl" className="py-10 lg:py-14">
        {/* 3-column grid (mobile: stacked) */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
          {/* Column 1 — Brand + Social */}
          <div>
            <p className="font-display text-xl font-semibold tracking-display text-smoke-50 mb-3">
              Ibate<span className="text-brand-500">X</span>as
            </p>
            <div className="flex gap-2">
              {instagramUrl && (
                <a href={instagramUrl} target="_blank" rel="noopener noreferrer" className="min-w-[44px] min-h-[44px] flex items-center justify-center text-smoke-500 hover:text-smoke-50 transition-colors duration-[200ms] ease-luxury" aria-label="Instagram">
                  <svg className="h-5 w-5" fill="currentColor" viewBox="0 0 24 24"><path d="M12.315 2c2.43 0 2.784.013 3.808.06 1.064.049 1.791.218 2.427.465a4.902 4.902 0 011.772 1.153 4.902 4.902 0 011.153 1.772c.247.636.416 1.363.465 2.427.048 1.067.06 1.407.06 4.123v.08c0 2.643-.012 2.987-.06 4.043-.049 1.064-.218 1.791-.465 2.427a4.902 4.902 0 01-1.153 1.772 4.902 4.902 0 01-1.772 1.153c-.636.247-1.363.416-2.427.465-1.067.048-1.407.06-4.123.06h-.08c-2.643 0-2.987-.012-4.043-.06-1.064-.049-1.791-.218-2.427-.465a4.902 4.902 0 01-1.772-1.153 4.902 4.902 0 01-1.153-1.772c-.247-.636-.416-1.363-.465-2.427-.047-1.024-.06-1.379-.06-3.808v-.63c0-2.43.013-2.784.06-3.808.049-1.064.218-1.791.465-2.427a4.902 4.902 0 011.153-1.772A4.902 4.902 0 015.45 2.525c.636-.247 1.363-.416 2.427-.465C8.901 2.013 9.256 2 11.685 2h.63zm-.081 1.802h-.468c-2.456 0-2.784.011-3.807.058-.975.045-1.504.207-1.857.344-.467.182-.8.398-1.15.748-.35.35-.566.683-.748 1.15-.137.353-.3.882-.344 1.857-.047 1.023-.058 1.351-.058 3.807v.468c0 2.456.011 2.784.058 3.807.045.975.207 1.504.344 1.857.182.466.399.8.748 1.15.35.35.683.566 1.15.748.353.137.882.3 1.857.344 1.054.048 1.37.058 4.041.058h.08c2.597 0 2.917-.01 3.96-.058.976-.045 1.505-.207 1.858-.344.466-.182.8-.398 1.15-.748.35-.35.566-.683.748-1.15.137-.353.3-.882.344-1.857.048-1.055.058-1.37.058-4.041v-.08c0-2.597-.01-2.917-.058-3.96-.045-.976-.207-1.505-.344-1.858a3.097 3.097 0 00-.748-1.15 3.098 3.098 0 00-1.15-.748c-.353-.137-.882-.3-1.857-.344-1.023-.047-1.351-.058-3.807-.058zM12 6.865a5.135 5.135 0 110 10.27 5.135 5.135 0 010-10.27zm0 1.802a3.333 3.333 0 100 6.666 3.333 3.333 0 000-6.666zm5.338-3.205a1.2 1.2 0 110 2.4 1.2 1.2 0 010-2.4z" /></svg>
                </a>
              )}
              {facebookUrl && (
                <a href={facebookUrl} target="_blank" rel="noopener noreferrer" className="min-w-[44px] min-h-[44px] flex items-center justify-center text-smoke-500 hover:text-smoke-50 transition-colors duration-[200ms] ease-luxury" aria-label="Facebook">
                  <svg className="h-5 w-5" fill="currentColor" viewBox="0 0 24 24"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z" /></svg>
                </a>
              )}
              {whatsappUrl && (
                <a href={whatsappUrl} target="_blank" rel="noopener noreferrer" className="min-w-[44px] min-h-[44px] flex items-center justify-center text-smoke-500 hover:text-smoke-50 transition-colors duration-[200ms] ease-luxury" aria-label="WhatsApp">
                  <svg className="h-5 w-5" fill="currentColor" viewBox="0 0 24 24"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.447-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.67-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.076 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z" /></svg>
                </a>
              )}
            </div>
          </div>

          {/* Column 2 — Info: hours, phone, address */}
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-editorial text-smoke-500 mb-2">
              {t('footer.hours')}
            </h3>
            <div className="space-y-2 text-sm text-smoke-400">
              {hoursWeekday && (
                <p>
                  <span className="text-smoke-300">{t('footer.monday_to_friday')}</span>{' '}
                  {hoursWeekday}
                </p>
              )}
              {hoursSaturday && (
                <p>
                  <span className="text-smoke-300">{t('footer.saturday')}</span>{' '}
                  {hoursSaturday}
                </p>
              )}
              {hoursSunday && (
                <p>
                  <span className="text-smoke-300">{t('footer.sunday')}</span>{' '}
                  {hoursSunday}
                </p>
              )}
              {phone && (
                <p className="pt-1">
                  <a href={`tel:${phone.replaceAll(/\D/g, '')}`} className="hover:text-smoke-50 transition-colors duration-[200ms] ease-luxury">
                    {phone}
                  </a>
                </p>
              )}
              {address && <p>{address}</p>}
            </div>
          </div>

          {/* Column 3 — Navigation */}
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-editorial text-smoke-500 mb-2">
              {t('footer.links')}
            </h3>
            <nav className="flex flex-col gap-2 text-sm">
              <Link href="/search" className="text-smoke-400 hover:text-smoke-50 transition-colors duration-[200ms] ease-luxury">
                {t('nav.shop')}
              </Link>
              <Link href="/loja" className="text-smoke-400 hover:text-smoke-50 transition-colors duration-[200ms] ease-luxury">
                {t('nav.loja')}
              </Link>
              <Link href="/account/reservations" className="text-smoke-400 hover:text-smoke-50 transition-colors duration-[200ms] ease-luxury">
                {t('nav.reservations')}
              </Link>
              <Link href="/account" className="text-smoke-400 hover:text-smoke-50 transition-colors duration-[200ms] ease-luxury">
                {t('nav.account')}
              </Link>
            </nav>
          </div>
        </div>
      </Container>

      {/* Bottom row: Copyright + privacy */}
      <div className="border-t border-smoke-700/50">
        <Container size="xl">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 py-4">
            <span className="text-xs text-smoke-500">
              &copy; {new Date().getFullYear()} IbateXas
            </span>
            <div className="flex gap-4">
              <Link href="/privacidade" className="text-xs text-smoke-500 hover:text-smoke-50 transition-colors duration-[200ms] ease-luxury">
                Política de Privacidade
              </Link>
              <Link href="/termos" className="text-xs text-smoke-500 hover:text-smoke-50 transition-colors duration-[200ms] ease-luxury">
                Termos de Uso
              </Link>
            </div>
          </div>
        </Container>
      </div>
    </footer>
  )
}
