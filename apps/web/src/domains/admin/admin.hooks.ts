"use client"

import { apiFetch } from "@/lib/api"
import { createAdminHook, createAdminListHook } from './admin.factory'
import { buildAdminHooks } from '@ibatexas/ui'

const hooks = buildAdminHooks(
  createAdminHook,
  createAdminListHook,
  apiFetch as <T>(endpoint: string) => Promise<T>,
)

export const useAdminDashboard = hooks.useAdminDashboard
export const useAdminProducts = hooks.useAdminProducts
export const useAdminProduct = hooks.useAdminProduct
export const useAdminOrders = hooks.useAdminOrders
