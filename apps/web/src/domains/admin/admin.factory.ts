'use client'

import { apiFetch } from '@/lib/api'
import { createAdminHookFactory } from '@ibatexas/ui'
import type { AdminHookResult, AdminListResult, CreateAdminHookOptions, FilterableOptions } from '@ibatexas/ui'

const factory = createAdminHookFactory(
  apiFetch as <T>(endpoint: string) => Promise<T>,
)

export const createAdminHook: {
  <T>(endpoint: string): () => AdminHookResult<T | null>
  <T, TRaw>(endpoint: string, options: CreateAdminHookOptions<TRaw, T>): () => AdminHookResult<T | null>
} = factory.createAdminHook

export const createAdminListHook: <TFilters, TRaw, T>(
  baseEndpoint: string,
  options: FilterableOptions<TFilters, TRaw, T>,
) => (filters: TFilters) => AdminListResult<T> = factory.createAdminListHook

export type { AdminHookResult, AdminListResult } from '@ibatexas/ui'
