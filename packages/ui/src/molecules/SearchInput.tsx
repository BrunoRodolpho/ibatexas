'use client'

import React, { useState, useCallback } from 'react'
import clsx from 'clsx'
import { fieldVariants } from '../theme/cva'

interface SearchInputProps {
  readonly placeholder?: string
  readonly onSearch: (query: string) => void
  readonly suggestions?: { id: string; label: string }[]
  readonly isLoading?: boolean
  readonly debounceMs?: number
  readonly variant?: 'card' | 'inline'
  readonly className?: string
}

export const SearchInput: React.FC<SearchInputProps> = ({
  placeholder = 'Buscar produtos...',
  onSearch,
  suggestions = [],
  isLoading = false,
  debounceMs = 300,
  variant = 'card',
  className,
}) => {
  const [query, setQuery] = useState('')
  const [isDropdownOpen, setIsDropdownOpen] = useState(false)
  const [timeoutId, setTimeoutId] = useState<NodeJS.Timeout>()

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = e.target.value
      setQuery(value)

      if (variant === 'card') {
        setIsDropdownOpen(!!value)
      }

      if (timeoutId) clearTimeout(timeoutId)

      const newTimeoutId = setTimeout(() => {
        onSearch(value)
      }, debounceMs)

      setTimeoutId(newTimeoutId)
    },
    [onSearch, debounceMs, timeoutId, variant]
  )

  const handleSuggestionClick = (label: string) => {
    setQuery(label)
    setIsDropdownOpen(false)
    onSearch(label)
  }

  const handleClear = () => {
    setQuery('')
    setIsDropdownOpen(false)
    if (timeoutId) clearTimeout(timeoutId)
    onSearch('')
  }

  const showDropdown =
    variant === 'card' &&
    isDropdownOpen &&
    (suggestions.length > 0 || isLoading)

  return (
    <div className={clsx('relative w-full', variant === 'inline' && 'max-w-xs', className)}>
      <div
        className={clsx(
          'flex items-center gap-3',
          variant === 'card' && 'surface-card rounded-card px-4 py-3',
          variant === 'inline' &&
            fieldVariants({ size: 'md', state: 'default' }) +
            ' flex items-center gap-3 !rounded-sm'
        )}
      >
        {/* Search icon */}
        <svg
          className="h-4 w-4 flex-shrink-0 text-smoke-400"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
          />
        </svg>

        <input
          type="text"
          value={query}
          onChange={handleChange}
          onFocus={() => variant === 'card' && query && setIsDropdownOpen(true)}
          onBlur={() =>
            variant === 'card' &&
            setTimeout(() => setIsDropdownOpen(false), 200)
          }
          placeholder={placeholder}
          className={clsx(
            'w-full bg-transparent border-0 text-charcoal-900 placeholder:text-smoke-400 focus-visible:outline-none',
            variant === 'card' && 'text-base sm:text-sm',
            variant === 'inline' && 'text-sm'
          )}
        />

        {/* Clear button */}
        {query && (
          <button
            type="button"
            onClick={handleClear}
            className="flex-shrink-0 text-smoke-400 hover:text-charcoal-900 transition-colors"
            aria-label="Limpar busca"
          >
            <svg
              className="h-4 w-4"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        )}
      </div>

      {/* Suggestions dropdown — card variant only */}
      {showDropdown && (
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
                    type="button"
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
