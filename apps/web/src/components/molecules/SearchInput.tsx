import React, { useState, useCallback } from 'react'
import { TextField, Button } from '../atoms'
import clsx from 'clsx'

interface SearchInputProps {
  placeholder?: string
  onSearch: (query: string) => void
  suggestions?: { id: string; label: string }[]
  isLoading?: boolean
  debounceMs?: number
}

export const SearchInput: React.FC<SearchInputProps> = ({
  placeholder = 'Buscar produtos...',
  onSearch,
  suggestions = [],
  isLoading = false,
  debounceMs = 300,
}) => {
  const [query, setQuery] = useState('')
  const [isDropdownOpen, setIsDropdownOpen] = useState(false)
  const [timeoutId, setTimeoutId] = useState<NodeJS.Timeout>()

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = e.target.value
      setQuery(value)
      setIsDropdownOpen(!!value)

      if (timeoutId) clearTimeout(timeoutId)

      const newTimeoutId = setTimeout(() => {
        onSearch(value)
      }, debounceMs)

      setTimeoutId(newTimeoutId)
    },
    [onSearch, debounceMs, timeoutId]
  )

  const handleSuggestionClick = (suggestion: string) => {
    setQuery(suggestion)
    setIsDropdownOpen(false)
    onSearch(suggestion)
  }

  return (
    <div className="relative w-full">
      <div className="surface-card rounded-card flex items-center gap-3 px-4 py-3">
        <svg className="h-4 w-4 flex-shrink-0 text-smoke-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
        <input
          type="text"
          value={query}
          onChange={handleChange}
          onFocus={() => query && setIsDropdownOpen(true)}
          onBlur={() => setTimeout(() => setIsDropdownOpen(false), 200)}
          placeholder={placeholder}
          className="w-full bg-transparent border-0 text-charcoal-900 placeholder:text-smoke-400 focus-visible:outline-none text-base sm:text-sm"
        />
      </div>

      {isDropdownOpen && (suggestions.length > 0 || isLoading) && (
        <div className="absolute top-full left-0 right-0 mt-2 bg-smoke-50 border border-smoke-200 rounded-card shadow-lg z-10 max-h-60 overflow-y-auto animate-slide-up">
          {isLoading && (
            <div className="px-4 py-3 text-center text-smoke-400 text-sm">
              Carregando...
            </div>
          )}
          {suggestions.length > 0 && (
            <ul>
              {suggestions.map((suggestion) => (
                <li key={suggestion.id}>
                  <button
                    onClick={() => handleSuggestionClick(suggestion.label)}
                    className="w-full px-4 py-3 text-left text-sm text-charcoal-900 hover:bg-smoke-100 focus-visible:bg-smoke-100 outline-none transition-colors duration-300"
                  >
                    {suggestion.label}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
