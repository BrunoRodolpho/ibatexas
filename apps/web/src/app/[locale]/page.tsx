'use client'

import { Link } from '@/i18n/navigation'
import { useTranslations } from 'next-intl'
import { Heading, Text, Button } from '@/components/atoms'
import { Card } from '@/components/atoms/Card'
import { ProductGrid } from '@/components/organisms/ProductGrid'
import { CategoryCarousel } from '@/components/molecules/CategoryCarousel'
import { useProducts, useCategories } from '@/hooks/api'
import { useUIStore } from '@/stores/useUIStore'

export default function Home() {
  const t = useTranslations()
  const setChat = useUIStore((s) => s.setChat)

  const { data: productsData, loading: productsLoading } = useProducts(undefined, ['popular'], 6)
  const { data: categories, loading: categoriesLoading } = useCategories()

  const topProducts = productsData?.products ?? []

  const handleAddToCart = (productId: string) => {
    console.log('Add to cart:', productId)
  }

  return (
    <>
      {/* ── Hero ────────────────────────────────────────────────────── */}
      <section className="relative overflow-hidden bg-white section-padding">
        {/* Radial glow background */}
        <div
          className="pointer-events-none absolute inset-0 opacity-[0.04]"
          aria-hidden="true"
          style={{
            backgroundImage:
              'radial-gradient(circle at 20% 60%, #E85D04 0%, transparent 55%), radial-gradient(circle at 80% 30%, #E85D04 0%, transparent 50%)',
          }}
        />

        <div className="relative mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="grid gap-12 lg:grid-cols-2 lg:items-center lg:gap-16">
            {/* Left: Copy + CTAs */}
            <div className="text-center lg:text-left">
              {/* Eyebrow badge */}
              <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-brand-200 bg-brand-50 px-4 py-2">
                <span className="h-2 w-2 rounded-full bg-brand-500 animate-pulse" />
                <span className="text-sm font-semibold text-brand-700 font-display">
                  IA Nativa
                </span>
              </div>

              {/* Main headline */}
              <h1 className="font-display text-display-xl font-extrabold text-slate-900 leading-[1.05] tracking-tight">
                <span className="text-gradient-brand">{t('home.hero_title')}.</span>
                <br />
                Pedido em 3 segundos.
              </h1>

              <Text variant="body" textColor="secondary" className="mx-auto mt-6 max-w-lg text-lg lg:mx-0">
                {t('home.hero_subtitle')}
              </Text>

              {/* CTAs */}
              <div className="mt-10 flex flex-col gap-4 sm:flex-row justify-center lg:justify-start">
                <button
                  onClick={() => setChat(true)}
                  className="inline-flex items-center justify-center gap-3 rounded-xl bg-brand-500 px-8 py-4 text-lg font-semibold text-white shadow-glow-brand hover:bg-brand-600 hover:-translate-y-0.5 hover:shadow-glow-brand-lg transition-all duration-250"
                >
                  <svg className="h-5 w-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                  </svg>
                  Pedir via IA
                </button>
                <Link href={"/search"}>
                  <Button variant="secondary" size="lg" className="w-full sm:w-auto">
                    {t('home.browse_menu')}
                  </Button>
                </Link>
              </div>

              {/* Social proof micro-indicators */}
              <div className="mt-10 flex flex-wrap items-center gap-6 justify-center lg:justify-start">
                <div className="flex items-center gap-3">
                  <div className="flex -space-x-2">
                    {['#E85D04', '#C94E00', '#FF7A33', '#A84000'].map((color, i) => (
                      <div
                        key={i}
                        className="h-8 w-8 rounded-full border-2 border-white"
                        style={{ backgroundColor: color }}
                      />
                    ))}
                  </div>
                  <div>
                    <div className="text-sm font-bold text-slate-900">+2.400 pedidos</div>
                    <div className="text-xs text-slate-500">este mês</div>
                  </div>
                </div>
                <div className="h-6 w-px bg-slate-200 hidden sm:block" />
                <div>
                  <div className="text-sm font-bold text-slate-900">⭐ 4.9</div>
                  <div className="text-xs text-slate-500">avaliação média</div>
                </div>
                <div className="h-6 w-px bg-slate-200 hidden sm:block" />
                <div>
                  <div className="text-sm font-bold text-slate-900">~35 min</div>
                  <div className="text-xs text-slate-500">entrega média</div>
                </div>
              </div>
            </div>

            {/* Right: Static chat preview — AI-first visual anchor */}
            <div className="relative hidden lg:flex lg:justify-center">
              <div className="relative w-[360px]">
                {/* Glow behind card */}
                <div className="absolute inset-0 rounded-3xl bg-gradient-to-br from-brand-500/10 to-brand-300/5 blur-2xl" />

                {/* Chat preview card */}
                <div className="relative rounded-3xl border border-slate-200/80 bg-white shadow-card-lg overflow-hidden">
                  {/* Chat header */}
                  <div className="bg-brand-500 px-5 py-4">
                    <div className="flex items-center gap-3">
                      <div className="h-9 w-9 rounded-full bg-white/20 flex items-center justify-center">
                        <span className="text-white text-sm font-bold font-display">IA</span>
                      </div>
                      <div>
                        <div className="text-sm font-bold text-white font-display">Assistente IbateXas</div>
                        <div className="flex items-center gap-1.5 mt-0.5">
                          <div className="h-1.5 w-1.5 rounded-full bg-green-400" />
                          <span className="text-xs text-brand-100">Online agora</span>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Chat bubbles */}
                  <div className="bg-smoke-50 p-5 space-y-4">
                    <div className="flex justify-start">
                      <div className="max-w-[78%] rounded-2xl rounded-tl-sm bg-white px-4 py-3 text-sm text-slate-800 shadow-card-sm border border-slate-100">
                        Olá! O que você vai querer hoje? 🔥
                      </div>
                    </div>
                    <div className="flex justify-end">
                      <div className="max-w-[78%] rounded-2xl rounded-tr-sm bg-brand-500 px-4 py-3 text-sm text-white">
                        Costela defumada para 2 pessoas
                      </div>
                    </div>
                    <div className="flex justify-start">
                      <div className="max-w-[82%] rounded-2xl rounded-tl-sm bg-white px-4 py-3 text-sm text-slate-800 shadow-card-sm border border-slate-100">
                        Perfeito! Adicionei ao carrinho. Entrega em ~40 min. Confirmar? 🥩
                      </div>
                    </div>
                    {/* Typing indicator */}
                    <div className="flex justify-end">
                      <div className="rounded-2xl rounded-tr-sm bg-brand-500 px-4 py-3">
                        <div className="flex gap-1 items-center">
                          <div className="h-1.5 w-1.5 rounded-full bg-white/70 animate-bounce [animation-delay:0ms]" />
                          <div className="h-1.5 w-1.5 rounded-full bg-white/70 animate-bounce [animation-delay:150ms]" />
                          <div className="h-1.5 w-1.5 rounded-full bg-white/70 animate-bounce [animation-delay:300ms]" />
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Chat input preview */}
                  <div className="border-t border-slate-100 bg-white px-4 py-3">
                    <div className="flex items-center gap-2 rounded-xl border border-slate-200 bg-smoke-50 px-4 py-2.5">
                      <span className="flex-1 text-sm text-slate-400">Pedir, perguntar, reservar...</span>
                      <div className="h-7 w-7 rounded-lg bg-brand-500 flex items-center justify-center">
                        <svg className="h-3.5 w-3.5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
                        </svg>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Featured Products ────────────────────────────────────────── */}
      <section className="section-padding bg-smoke-50">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="mb-12 flex items-end justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-widest text-brand-500 mb-2 font-display">
                {t('home.featured_subtitle')}
              </p>
              <Heading as="h2" variant="h2">
                {t('home.featured_products')}
              </Heading>
            </div>
            <Link
              href={"/search?tags=popular"}
              className="hidden text-sm font-semibold text-brand-500 hover:text-brand-600 transition-colors duration-250 sm:inline-flex items-center gap-1"
            >
              {t('common.view_all')}
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </Link>
          </div>

          <ProductGrid
            products={topProducts}
            columns={3}
            isLoading={productsLoading}
            onAddToCart={handleAddToCart}
          />
        </div>
      </section>

      {/* ── Social Proof Testimonials ────────────────────────────────── */}
      <section className="section-padding bg-white">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-12">
            <p className="text-xs font-semibold uppercase tracking-widest text-brand-500 mb-2 font-display">
              O que nossos clientes dizem
            </p>
            <Heading as="h2" variant="h2">
              Milhares de fãs do churrasco
            </Heading>
          </div>

          <div className="grid gap-6 md:grid-cols-3">
            {[
              {
                name: 'Mariana S.',
                location: 'São Carlos',
                stars: 5,
                text: 'A costela defumada é incrível. Nunca comi churrasco tão bem preparado fora de casa.',
              },
              {
                name: 'Rafael T.',
                location: 'Araraquara',
                stars: 5,
                text: 'Pedi pelo chat da IA em 2 minutos. Chegou em 35 minutos. Experiência perfeita.',
              },
              {
                name: 'Camila R.',
                location: 'Ibaté',
                stars: 5,
                text: 'Já é tradição no nosso final de semana. Qualidade sempre consistente e atendimento excelente.',
              },
            ].map((review, i) => (
              <Card key={i} className="p-8 shadow-card-md">
                <div className="flex gap-0.5 mb-4">
                  {Array.from({ length: review.stars }).map((_, s) => (
                    <span key={s} className="text-brand-500 text-sm">★</span>
                  ))}
                </div>
                <Text variant="body" className="text-slate-700 mb-6">
                  "{review.text}"
                </Text>
                <div className="flex items-center gap-3">
                  <div className="h-10 w-10 rounded-full bg-brand-100 flex items-center justify-center flex-shrink-0">
                    <span className="text-brand-600 font-bold text-sm">{review.name.charAt(0)}</span>
                  </div>
                  <div>
                    <div className="text-sm font-semibold text-slate-900">{review.name}</div>
                    <div className="text-xs text-slate-500">{review.location}</div>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        </div>
      </section>

      {/* ── Categories ───────────────────────────────────────────────── */}
      <section className="section-padding bg-smoke-50">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="mb-12">
            <p className="text-xs font-semibold uppercase tracking-widest text-brand-500 mb-2 font-display">
              Navegue por tipo
            </p>
            <Heading as="h2" variant="h2">
              {t('home.categories')}
            </Heading>
          </div>

          {categoriesLoading ? (
            <div className="flex gap-4 overflow-x-auto pb-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="flex-shrink-0 w-44 h-32 rounded-2xl skeleton" />
              ))}
            </div>
          ) : categories && (categories as any[]).length > 0 ? (
            <CategoryCarousel categories={categories as any[]} />
          ) : (
            <Text textColor="muted">{t('home.no_categories')}</Text>
          )}
        </div>
      </section>

      {/* ── CTA Banner ───────────────────────────────────────────────── */}
      <section className="relative overflow-hidden bg-brand-500">
        <div
          className="pointer-events-none absolute inset-0 opacity-10"
          aria-hidden="true"
          style={{
            backgroundImage:
              'radial-gradient(circle at 10% 50%, white 0%, transparent 50%), radial-gradient(circle at 90% 20%, white 0%, transparent 40%)',
          }}
        />
        <div className="relative section-padding text-center">
          <p className="text-xs font-semibold uppercase tracking-widest text-brand-100 mb-4 font-display">
            Sem espera
          </p>
          <Heading as="h2" variant="h2" className="text-white">
            {t('home.delivery_cta_title')}
          </Heading>
          <Text textColor="secondary" className="mt-4 text-brand-100 text-lg max-w-xl mx-auto">
            {t('home.delivery_cta_subtitle')}
          </Text>
          <Link href={"/search"}>
            <Button
              variant="secondary"
              size="lg"
              className="mt-10 bg-white text-brand-600 hover:bg-smoke-50 border-white shadow-card-lg"
            >
              {t('home.order_now')}
            </Button>
          </Link>
        </div>
      </section>
    </>
  )
}
