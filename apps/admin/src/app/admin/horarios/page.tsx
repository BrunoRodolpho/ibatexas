'use client'

import { AdminHorariosPage } from '@ibatexas/ui'
import { getApiBase } from '@ibatexas/tools/api'

export default function HorariosPage() {
  return <AdminHorariosPage apiBase={getApiBase()} />
}
