import { Suspense } from 'react'
import SearchContent from './SearchContent'
import SearchLoading from './loading'

export default function SearchPage() {
  return (
    <Suspense fallback={<SearchLoading />}>
      <SearchContent />
    </Suspense>
  )
}
