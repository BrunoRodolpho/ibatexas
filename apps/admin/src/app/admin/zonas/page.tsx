'use client'

import { AdminZonasPage } from '@ibatexas/ui'
import { getApiBase } from '@ibatexas/tools/api'

export default function ZonasPage(): React.JSX.Element {
  return <AdminZonasPage apiBase={getApiBase()} />
}
