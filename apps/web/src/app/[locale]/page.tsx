import { getTranslations } from 'next-intl/server'
import dynamic from 'next/dynamic'
import { Heading, Text, HeroVideo, ScrollReveal } from '@/components/atoms'
import { Beef, Flame, Package, Truck } from 'lucide-react'
import HomeCarousel from './HomeCarousel'
import HomeCTA from './HomeCTA'
import { HomeFavorites } from './HomeFavorites'
import { ReorderCard } from '@/components/molecules/ReorderCard'
import { FirstVisitBanner } from '@/components/molecules/FirstVisitBanner'
import { StoryBlock } from '@/components/molecules/StoryBlock'

// Phase 2 — personalization islands (client-only, no SSR)
const HomeRecommendations = dynamic(() => import('./HomeRecommendations').then((m) => m.HomeRecommendations), { ssr: false })
const HomeReviews = dynamic(() => import('./HomeReviews').then((m) => m.HomeReviews), { ssr: false })
const RecentlyViewedCarousel = dynamic(
  () => import('@/components/organisms/RecentlyViewedCarousel').then((m) => m.RecentlyViewedCarousel),
  { ssr: false }
)

/** Revalidate homepage every hour — balances freshness with traffic-spike resilience */
export const revalidate = 3600

export default async function Home() {
  const t = await getTranslations()

  const stats = [
    { value: t('home.stats_hours_value'), label: t('home.stats_hours_label') },
    { value: t('home.stats_ingredients_value'), label: t('home.stats_ingredients_label') },
    { value: t('home.stats_deliveries_value'), label: t('home.stats_deliveries_label') },
    { value: t('home.stats_rating_value'), label: t('home.stats_rating_label') },
  ]

  const steps = [
    { icon: Beef, title: t('home.process_step1_title'), desc: t('home.process_step1_desc') },
    { icon: Flame, title: t('home.process_step2_title'), desc: t('home.process_step2_desc') },
    { icon: Package, title: t('home.process_step3_title'), desc: t('home.process_step3_desc') },
    { icon: Truck, title: t('home.process_step4_title'), desc: t('home.process_step4_desc') },
  ]

  return (
    <>
      {/* ═══════════════════════════════════════════════════════════════
          SECTION 1 — Hero (layered composition, not grid)
          ═══════════════════════════════════════════════════════════════ */}
      <section className="relative bg-smoke-50 overflow-hidden" data-hero>

        {/* Video — positioned as backdrop on the left (desktop only) */}
        <div className="hidden lg:block absolute top-4 bottom-0 left-[2%] w-[52%] pointer-events-none">
          <HeroVideo
            src="/videos/pitmaster-hero.mp4"
            poster="/videos/pitmaster-hero-placeholder.png"
            className="h-full w-full"
          />
        </div>

        {/* White gradient — fades video into white on the right */}
        <div className="hidden lg:block absolute inset-y-0 left-[34%] w-[28%] bg-gradient-to-r from-transparent to-smoke-50 pointer-events-none" />

        {/* Content layer */}
        <div className="relative mx-auto max-w-[1280px] px-6 lg:px-8 py-32 lg:pt-32 lg:pb-40 lg:min-h-[420px] lg:flex lg:items-start">

          {/* Mobile — video fills full width, bleeds past container padding */}
          <div className="lg:hidden -mx-6 mb-2">
            <HeroVideo
              src="/videos/pitmaster-hero.mp4"
              poster="/videos/pitmaster-hero-placeholder.png"
              className="w-full"
            />
          </div>

          {/* Text — centered on desktop, overlaps video edge */}
          <div className="text-center lg:text-left lg:ml-[46%] lg:max-w-[600px] animate-reveal">
            <Heading as="h1" className="font-display text-display-md sm:text-display-lg lg:text-display-xl font-bold text-brand-500 leading-[1.02] tracking-display">
              {t('home.hero_title')}
            </Heading>
            <Text className="mt-4 lg:mt-6 font-display italic text-xl sm:text-2xl text-smoke-400 leading-relaxed mx-auto lg:mx-0">
              {t('home.hero_subtitle')}
            </Text>

            {/* Hero CTAs */}
            <HomeCTA />
          </div>

        </div>

      </section>

      {/* ── Phase 1+2: Personalization strip ─────────────────────── */}
      <div className="mx-auto max-w-[1280px] px-6 lg:px-8 pt-6 pb-2">
        <FirstVisitBanner />
      </div>
      <ReorderCard />

      {/* ── Customer reviews — social proof early in the page ───── */}
      <HomeReviews />

      {/* ── Phase 2: Personalized recommendations ────────────────── */}
      <HomeRecommendations />

      {/* ═══════════════════════════════════════════════════════════════
          SECTION 2 — Bold statement + infinite product carousel
          ═══════════════════════════════════════════════════════════════ */}
      {/* ── Brand highlight — bold orange statement ──────────────── */}
      <section className="relative bg-brand-500 overflow-hidden">
        {/* Subtle radial glow */}
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,_rgba(255,255,255,0.15)_0%,_transparent_70%)] pointer-events-none" />
        {/* Diagonal texture lines */}
        <div className="absolute inset-0 opacity-[0.03] pointer-events-none" style={{ backgroundImage: 'repeating-linear-gradient(135deg, white 0px, white 1px, transparent 1px, transparent 12px)' }} />

        <div className="relative mx-auto max-w-[1280px] px-6 lg:px-8 py-24 lg:py-32 text-center">
          {/* Decorative top */}
          <ScrollReveal animation="fade-up" delay={100}>
            <div className="flex items-center justify-center gap-4 mb-6">
              <div className="h-px w-12 sm:w-20 bg-white/30" />
              <Flame className="w-5 h-5 text-white/70" strokeWidth={1.5} />
              <div className="h-px w-12 sm:w-20 bg-white/30" />
            </div>
          </ScrollReveal>

          {/* Heading — dramatic scale entrance */}
          <ScrollReveal animation="scale-up" delay={300}>
            <Heading as="h2" className="font-display text-display-sm sm:text-display-md lg:text-display-lg font-bold text-white leading-[1.05] tracking-display max-w-[700px] mx-auto">
              {t('home.our_menu')}
            </Heading>
          </ScrollReveal>

          {/* Subtitle — fades in after heading */}
          <ScrollReveal animation="fade-up" delay={600}>
            <Text className="mt-4 sm:mt-5 text-base sm:text-lg text-white/85 leading-relaxed font-display italic max-w-[520px] mx-auto">
              {t('home.our_menu_subtitle')}
            </Text>
          </ScrollReveal>

          {/* Decorative bottom */}
          <ScrollReveal animation="fade-up" delay={900}>
            <div className="flex items-center justify-center gap-4 mt-6">
              <div className="h-px w-12 sm:w-20 bg-white/30" />
              <div className="w-1.5 h-1.5 rounded-full bg-white/50" />
              <div className="h-px w-12 sm:w-20 bg-white/30" />
            </div>
          </ScrollReveal>
        </div>
      </section>

      {/* ── Product carousel ─────────────────────────────────────── */}
      <section className="bg-smoke-50">
        <div className="py-24 lg:py-32">
          <HomeCarousel />
        </div>
      </section>

      {/* ═══════════════════════════════════════════════════════════════
          SECTION 3 — Story + Process + Stats (unified dark section)
          ═══════════════════════════════════════════════════════════════ */}
      <section className="bg-charcoal-900 grain-overlay">
        <div className="mx-auto max-w-[1280px] px-6 lg:px-8 py-24 lg:py-32">
          {/* Brand narrative */}
          <ScrollReveal animation="fade-up" delay={0}>
            <StoryBlock compact />
          </ScrollReveal>

          {/* Divider */}
          <ScrollReveal animation="fade-up" delay={200}>
            <div className="flex items-center justify-center gap-4 my-6 lg:my-8">
              <div className="h-px flex-1 bg-smoke-600/30" />
              <span className="text-[10px] uppercase tracking-editorial text-smoke-500 font-medium">
                {t('home.process_title')}
              </span>
              <div className="h-px flex-1 bg-smoke-600/30" />
            </div>
          </ScrollReveal>

          {/* Process steps */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-8 lg:gap-6">
            {steps.map((step, i) => (
              <ScrollReveal key={i} animation="fade-up" delay={300 + i * 150}>
                <div className="flex flex-col items-center text-center">
                  <div className="w-11 h-11 rounded-full bg-smoke-700/50 flex items-center justify-center mb-4">
                    <step.icon className="w-5 h-5 text-smoke-100" strokeWidth={1.5} />
                  </div>
                  <h3 className="font-display text-sm font-semibold text-smoke-50 tracking-tight">
                    {step.title}
                  </h3>
                  <p className="mt-1.5 text-xs text-smoke-400 leading-relaxed max-w-[200px]">
                    {step.desc}
                  </p>
                </div>
              </ScrollReveal>
            ))}
          </div>

          {/* Stats — integrated into same dark section */}
          <div className="mt-24 lg:mt-32 pt-24 border-t border-smoke-600/20">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-8 sm:gap-4">
              {stats.map((stat, i) => (
                <ScrollReveal key={i} animation="scale-up" delay={i * 150}>
                  <div className="flex flex-col items-center text-center">
                    <span className="font-display text-display-sm sm:text-display-md font-bold text-white tabular-nums">{stat.value}</span>
                    <span className="mt-2 text-xs text-smoke-300/60">{stat.label}</span>
                  </div>
                </ScrollReveal>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ═══════════════════════════════════════════════════════════════
          SECTION 4 — Favorites (for returning users with wishlist)
          ═══════════════════════════════════════════════════════════════ */}
      <HomeFavorites />

      {/* ── Phase 2: Recently viewed (returning users) ───────────── */}
      <RecentlyViewedCarousel />

      {/* ═══════════════════════════════════════════════════════════════
          SECTION 5 — Closing CTA (quiet authority)
          ═══════════════════════════════════════════════════════════════ */}
      <section className="bg-smoke-100">
        <div className="mx-auto max-w-[1280px] px-6 lg:px-8 py-32 lg:py-40">
          <div className="max-w-xl mx-auto text-center">
            <ScrollReveal animation="scale-up" delay={0}>
              <Heading as="h2" className="font-display text-display-sm sm:text-display-md font-semibold text-charcoal-900 leading-tight tracking-display">
                {t('home.cta_title')}
              </Heading>
            </ScrollReveal>
            <ScrollReveal animation="fade-up" delay={200}>
              <Text className="mt-4 text-sm text-smoke-400 leading-relaxed measure-reading mx-auto">
                {t('home.cta_subtitle')}
              </Text>
            </ScrollReveal>
            <ScrollReveal animation="fade-up" delay={400}>
              <HomeCTA />
            </ScrollReveal>
          </div>
        </div>
      </section>
    </>
  )
}
