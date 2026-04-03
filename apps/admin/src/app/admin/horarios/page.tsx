'use client'

import { AdminHorariosPage } from '@ibatexas/ui'
import { getApiBase } from '@ibatexas/tools/api'

export default function HorariosPage(): React.JSX.Element {
  return <AdminHorariosPage apiBase={getApiBase()} />
}
