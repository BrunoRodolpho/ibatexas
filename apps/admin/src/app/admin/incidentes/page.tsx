import { AlertTriangle } from 'lucide-react'
import { PageShell, PageHeader } from '@ibatexas/ui'

// Minimal stub so the Incidentes nav badge is clickable (not a 404). A later
// wave replaces this with the full no-reply incident inbox.
export default function IncidentesPage(): React.JSX.Element {
  return (
    <PageShell>
      <PageHeader
        icon={AlertTriangle}
        title="Incidentes"
        subtitle="Atendimentos sem resposta"
      />
      <p className="text-sm text-[var(--color-text-secondary)]">Lista completa em breve.</p>
    </PageShell>
  )
}
