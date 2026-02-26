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
      <input
        type="text"
        value={query}
        onChange={handleChange}
        onFocus={() => query && setIsDropdownOpen(true)}
        onBlur={() => setTimeout(() => setIsDropdownOpen(false), 200)}
        placeholder={placeholder}
        className="w-full px-0 py-2 bg-transparent border-0 border-b border-smoke-200 text-charcoal-900 placeholder:text-smoke-400 focus-visible:outline-none focus-visible:border-charcoal-900 transition-colors duration-500 ease-[cubic-bezier(0.16,1,0.3,1)] text-sm"
      />

      {isDropdownOpen && (suggestions.length > 0 || isLoading) && (
        <div className="absolute top-full left-0 right-0 mt-1 bg-smoke-50 border border-smoke-200 rounded-sm shadow-md z-10 max-h-60 overflow-y-auto">
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
                    className="w-full px-4 py-2 text-left text-sm text-charcoal-900 hover:bg-smoke-100 focus-visible:bg-smoke-100 outline-none transition-colors duration-300"
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
