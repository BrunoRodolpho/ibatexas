'use client'

import React, { useState, useMemo } from 'react'
import { Heading, Text, Button, Select, Checkbox, RadioGroup } from '@/components/atoms'
import { SearchInput, FilterChip } from '@/components/molecules'
import { ProductGrid } from '@/components/organisms'
import { useUIStore } from '@/stores'
import { useProducts } from '@/hooks/api'

interface FilterOption {
  id: string
  label: string
}

const TAGS: FilterOption[] = [
  { id: 'novo', label: '🆕 Novo' },
  { id: 'popular', label: '⭐ Popular' },
  { id: 'chef_choice', label: '👨‍🍳 Chef\'s Choice' },
  { id: 'vegetariano', label: '🥬 Vegetariano' },
  { id: 'vegan', label: '🌱 Vegan' },
  { id: 'sem_gluten', label: '🌾 Sem Glúten' },
]

const CATEGORIES: FilterOption[] = [
  { id: 'almoço', label: 'Almoço' },
  { id: 'jantar', label: 'Jantar' },
  { id: 'congelados', label: 'Congelados' },
  { id: 'sobremesas', label: 'Sobremesas' },
  { id: 'bebidas', label: 'Bebidas' },
]

const SORT_OPTIONS = [
  { value: 'relevance', label: 'Relevância' },
  { value: 'price_asc', label: 'Preço: Menor → Maior' },
  { value: 'price_desc', label: 'Preço: Maior → Menor' },
  { value: 'rating', label: 'Melhor Avaliação' },
  { value: 'popular', label: 'Mais Popular' },
]

export default function SearchPage() {
  const [searchQuery, setSearchQuery] = useState('')
  const [isMobileFilterOpen, setIsMobileFilterOpen] = useState(false)

  const { selectedFilters, setFilters, resetFilters } = useUIStore()

  // Merge selected tags from UI store
  const activeTags = useMemo(
    () => (selectedFilters.tags.length > 0 ? selectedFilters.tags : undefined),
    [selectedFilters.tags]
  )

  // Call real API via useProducts hook
  const { data: productsData, loading: isLoading } = useProducts(
    searchQuery || undefined,
    activeTags,
    20
  )

  const products = productsData?.products ?? []
  const totalFound = productsData?.totalFound ?? 0

  const handleSearch = (query: string) => {
    setSearchQuery(query)
  }

  const handleTagToggle = (tagId: string) => {
    const newTags = selectedFilters.tags.includes(tagId)
      ? selectedFilters.tags.filter((t) => t !== tagId)
      : [...selectedFilters.tags, tagId]
    setFilters({ ...selectedFilters, tags: newTags })
  }

  const handleCategoryChange = (categoryId: string) => {
    setFilters({ ...selectedFilters, category: categoryId })
  }

  const handleSortChange = (sortValue: string) => {
    setFilters({ ...selectedFilters, sort: sortValue })
  }

  const handlePriceChange = (minPrice: number, maxPrice: number) => {
    setFilters({ ...selectedFilters, priceRange: [minPrice, maxPrice] })
  }

  const hasActiveFilters = selectedFilters.tags.length > 0 || selectedFilters.category || selectedFilters.priceRange

  return (
    <div className="min-h-screen bg-white">
      {/* Search Header */}
      <div className="sticky top-0 z-30 bg-white border-b border-slate-200 px-4 py-4">
        <div className="max-w-6xl mx-auto">
          <SearchInput
            placeholder="Buscar produtos, marcas, categorias..."
            onSearch={handleSearch}
            isLoading={isLoading}
            debounceMs={300}
          />
        </div>
      </div>

      <div className="max-w-6xl mx-auto px-4 py-6">
        {/* Results Info */}
        <div className="flex items-center justify-between mb-6">
          <Heading as="h1" variant="h3">
            {isLoading
              ? 'Buscando...'
              : totalFound > 0
                ? `${totalFound} resultado${totalFound !== 1 ? 's' : ''}`
                : 'Resultados'}
          </Heading>
          {hasActiveFilters && (
            <button
              onClick={resetFilters}
              className="text-sm text-amber-700 hover:underline font-medium"
            >
              Limpar filtros
            </button>
          )}
        </div>

        <div className="flex gap-6">
          {/* Sidebar Filters (Desktop) */}
          <aside className="hidden lg:block w-64 flex-shrink-0">
            <div className="space-y-6 sticky top-24">
              {/* Category */}
              <div>
                <h3 className="font-bold text-slate-900 mb-3">Categoria</h3>
                <RadioGroup
                  name="category"
                  options={CATEGORIES.map((cat) => ({
                    value: cat.id,
                    label: cat.label,
                  }))}
                  value={selectedFilters.category}
                  onChange={(value) => handleCategoryChange(value as string)}
                  layout="vertical"
                />
              </div>

              {/* Tags */}
              <div>
                <h3 className="font-bold text-slate-900 mb-3">Características</h3>
                <div className="space-y-2">
                  {TAGS.map((tag) => (
                    <Checkbox
                      key={tag.id}
                      label={tag.label}
                      checked={selectedFilters.tags.includes(tag.id)}
                      onChange={() => handleTagToggle(tag.id)}
                    />
                  ))}
                </div>
              </div>

              {/* Price Range */}
              <div>
                <h3 className="font-bold text-slate-900 mb-3">Preço</h3>
                <div className="space-y-3">
                  <input
                    type="range"
                    min="0"
                    max="50000"
                    step="500"
                    value={selectedFilters.priceRange?.[0] || 0}
                    onChange={(e) =>
                      handlePriceChange(
                        parseInt(e.target.value, 10),
                        selectedFilters.priceRange?.[1] || 50000
                      )
                    }
                    className="w-full accent-amber-700"
                  />
                  <div className="flex gap-2">
                    <input
                      type="number"
                      placeholder="Min"
                      value={selectedFilters.priceRange?.[0] || 0}
                      onChange={(e) =>
                        handlePriceChange(
                          parseInt(e.target.value, 10),
                          selectedFilters.priceRange?.[1] || 50000
                        )
                      }
                      className="flex-1 px-3 py-2 border border-slate-300 rounded text-sm"
                    />
                    <span className="text-slate-500 py-2">—</span>
                    <input
                      type="number"
                      placeholder="Max"
                      value={selectedFilters.priceRange?.[1] || 50000}
                      onChange={(e) =>
                        handlePriceChange(
                          selectedFilters.priceRange?.[0] || 0,
                          parseInt(e.target.value, 10)
                        )
                      }
                      className="flex-1 px-3 py-2 border border-slate-300 rounded text-sm"
                    />
                  </div>
                </div>
              </div>
            </div>
          </aside>

          {/* Main Content */}
          <main className="flex-1">
            {/* Sort & Mobile Filter Toggle */}
            <div className="flex gap-3 mb-6">
              <Select
                options={SORT_OPTIONS}
                value={selectedFilters.sort || 'relevance'}
                onChange={(e) => handleSortChange(e.target.value)}
                placeholder="Ordenar por"
                className="flex-1 lg:w-auto"
              />
              <Button
                variant="secondary"
                onClick={() => setIsMobileFilterOpen(!isMobileFilterOpen)}
                className="lg:hidden"
              >
                Filtrar
              </Button>
            </div>

            {/* Mobile Filters */}
            {isMobileFilterOpen && (
              <div className="lg:hidden bg-slate-50 p-4 rounded-lg mb-6 space-y-4">
                <div>
                  <h3 className="font-bold text-slate-900 mb-2">Categoria</h3>
                  <RadioGroup
                    name="category"
                    options={CATEGORIES.map((cat) => ({
                      value: cat.id,
                      label: cat.label,
                    }))}
                    value={selectedFilters.category}
                    onChange={(value) => handleCategoryChange(value as string)}
                    layout="vertical"
                  />
                </div>
                <div>
                  <h3 className="font-bold text-slate-900 mb-2">Características</h3>
                  <div className="space-y-2">
                    {TAGS.map((tag) => (
                      <Checkbox
                        key={tag.id}
                        label={tag.label}
                        checked={selectedFilters.tags.includes(tag.id)}
                        onChange={() => handleTagToggle(tag.id)}
                      />
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* Active Filters Display */}
            {hasActiveFilters && (
              <div className="mb-6 flex flex-wrap gap-2">
                {selectedFilters.tags.map((tagId) => {
                  const tag = TAGS.find((t) => t.id === tagId)
                  return (
                    <FilterChip
                      key={tagId}
                      id={tagId}
                      label={tag?.label || tagId}
                      selected={true}
                      onToggle={() => handleTagToggle(tagId)}
                      removable
                      onRemove={() => handleTagToggle(tagId)}
                    />
                  )
                })}
                {selectedFilters.category && (
                  <FilterChip
                    id={selectedFilters.category}
                    label={CATEGORIES.find((c) => c.id === selectedFilters.category)?.label || ''}
                    selected={true}
                    onToggle={() => handleCategoryChange('')}
                    removable
                    onRemove={() => handleCategoryChange('')}
                  />
                )}
              </div>
            )}

            {/* Product Grid */}
            <ProductGrid
              products={products}
              isLoading={isLoading}
              isEmpty={!isLoading && products.length === 0}
              emptyMessage={
                searchQuery
                  ? `Nenhum produto encontrado para "${searchQuery}"`
                  : 'Digite algo para começar a buscar ou selecione uma categoria'
              }
              onAddToCart={(productId) => {
                console.log('Add to cart:', productId)
              }}
            />
          </main>
        </div>
      </div>
    </div>
  )
}
