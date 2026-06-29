'use client'

import { useState } from 'react'
import { AlertTriangle, ChevronDown } from 'lucide-react'
import { INCIDENT_STORM, INCIDENT_CAUSE_LABELS } from '../constants/admin-labels'

export interface StormDigestBannerProps {
  /** Rolling open-incident count over the window (drives the headline + auto-hide). */
  readonly openCount: number
  /** Window length in minutes (e.g. 8). */
  readonly windowMinutes: number
  /** Dominant cause enum across the open incidents (e.g. 'timeout'). */
  readonly dominantCause: string
  /** Below this rolling count the banner auto-hides (bot is recovering the wave). */
  readonly threshold?: number
  readonly onAcknowledgeAll?: () => void
  readonly onFilterByCause?: (cause: string) => void
}

/**
 * Storm digest banner (§5/§6). Pinned above the StatCards during a model-outage
 * wave. Headline keys off the ROLLING open-count window (NOT the per-poll beep
 * gate), groups by dominant cause, offers bulk acknowledge + jump-to-filter, and
 * auto-dismisses once the rolling count drops below `threshold`.
 */
export function StormDigestBanner({
  openCount,
  windowMinutes,
  dominantCause,
  threshold = 20,
  onAcknowledgeAll,
  onFilterByCause,
}: StormDigestBannerProps) {
  const [expanded, setExpanded] = useState(true)

  if (openCount < threshold) return null

  const causeLabel = INCIDENT_CAUSE_LABELS[dominantCause] ?? dominantCause

  return (
    <div className="rounded-sm border border-smoke-200 border-l-2 border-accent-red bg-accent-red/[0.06] p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-accent-red" />
          <span className="font-semibold text-charcoal-900">{INCIDENT_STORM.headline}</span>
        </div>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex items-center gap-1 text-xs text-smoke-500 hover:text-charcoal-700"
        >
          <ChevronDown className={`h-3.5 w-3.5 transition-transform ${expanded ? '' : '-rotate-90'}`} />
          {INCIDENT_STORM.details}
        </button>
      </div>

      {expanded && (
        <div className="mt-2 space-y-3">
          <p className="text-sm text-charcoal-700">
            {INCIDENT_STORM.summary(openCount, windowMinutes, causeLabel)}
          </p>
          <div className="flex flex-wrap gap-2">
            {onAcknowledgeAll && (
              <button
                type="button"
                onClick={onAcknowledgeAll}
                className="rounded-sm bg-accent-red/10 px-3 py-1.5 text-xs font-medium text-accent-red transition-colors hover:bg-accent-red/20"
              >
                {INCIDENT_STORM.acknowledgeAll(openCount)}
              </button>
            )}
            {onFilterByCause && (
              <button
                type="button"
                onClick={() => onFilterByCause(dominantCause)}
                className="rounded-sm border border-smoke-200 bg-smoke-50 px-3 py-1.5 text-xs font-medium text-charcoal-700 transition-colors hover:bg-smoke-100"
              >
                {INCIDENT_STORM.filterByCause}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
