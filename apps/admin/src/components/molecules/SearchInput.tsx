'use client'

import { useState, useCallback } from 'react'

interface SearchInputProps {
  readonly placeholder?: string
  readonly onSearch: (query: string) => void
  readonly debounceMs?: number
}

export function SearchInput({
  placeholder = 'Buscar produtos...',
  onSearch,
  debounceMs = 300,
}: SearchInputProps) {
  const [query, setQuery] = useState('')
  const [timeoutId, setTimeoutId] = useState<NodeJS.Timeout>()

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = e.target.value
      setQuery(value)
      if (timeoutId) clearTimeout(timeoutId)
      const newTimeoutId = setTimeout(() => {
        onSearch(value)
      }, debounceMs)
      setTimeoutId(newTimeoutId)
    },
    [onSearch, debounceMs, timeoutId]
  )

  return (
    <div className="relative w-full max-w-xs">
      <div className="flex items-center gap-3 rounded-sm border border-smoke-200 bg-smoke-50 px-3 py-2">
        <svg className="h-4 w-4 flex-shrink-0 text-smoke-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
        <input
          type="text"
          value={query}
          onChange={handleChange}
          placeholder={placeholder}
          className="w-full bg-transparent border-0 text-charcoal-900 placeholder:text-smoke-400 focus-visible:outline-none text-sm"
        />
      </div>
    </div>
  )
}
