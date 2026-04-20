import { redirect } from '@/i18n/navigation'

/**
 * Legacy PDP route — kept only as a redirect to the canonical
 * `/loja/produto/[id]` route. The full implementation lived here historically
 * and was duplicated by `loja/produto/[id]/PDPContent.tsx`. We deleted the
 * duplicate page and now bounce direct hits to the canonical route so:
 *   - bookmarks and external links keep working
 *   - there's no risk of the two PDPs diverging again
 *
 * `redirect()` from next-intl's createNavigation needs `{ href, locale }`
 * so the locale segment (`/pt-BR/...`) is preserved on the way out.
 */
export default async function LegacyProductRedirect({
  params,
}: {
  params: Promise<{ locale: string; id: string }>
}) {
  const { locale, id } = await params
  redirect({ href: `/loja/produto/${id}`, locale })
}
