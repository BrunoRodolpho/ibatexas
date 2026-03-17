'use client'

import { AdminZonasPage } from '@ibatexas/ui'
import { getApiBase } from '@ibatexas/tools'

export default function ZonasPage() {
  return <AdminZonasPage apiBase={getApiBase()} />
}
