// Left filter rail primitives — search + multi-select groups shared by every
// view (graphs, coverage, run explorer). Read-only by construction: the rail
// only narrows what the main pane renders, it never mutates an artifact.
// Default selection is "all" (an empty selection set means "show everything"),
// so the rail is additive over the pre-existing render-everything behavior.

import { type ReactNode } from "react"

export interface RailItem {
  id: string
  label: string
  /** optional right-aligned count badge */
  count?: number
  /** optional CSS class applied to a leading swatch (decision/state tints) */
  tone?: string
}

/** Two-pane layout: fixed-width rail on the left, the view fills the rest. */
export function Workbench({ rail, children }: { rail: ReactNode; children: ReactNode }) {
  return (
    <div className="workbench">
      <aside className="rail" aria-label="filters">
        {rail}
      </aside>
      <div className="workbench__main">{children}</div>
    </div>
  )
}

export function RailSearch({
  value,
  onChange,
  placeholder,
}: {
  value: string
  onChange: (next: string) => void
  placeholder?: string
}) {
  return (
    <input
      className="rail__search"
      type="search"
      value={value}
      placeholder={placeholder ?? "search…"}
      onChange={(e) => onChange(e.target.value)}
    />
  )
}

/**
 * A titled, multi-select group. `selected` carries which ids are checked.
 * When `swatch` is set, each item shows a leading color swatch tinted by its
 * `tone` class (reusing the decision/coverage cell palettes).
 */
export function RailGroup({
  title,
  items,
  selected,
  onToggle,
  onAll,
  onNone,
  swatch,
  emptyHint,
}: {
  title: string
  items: RailItem[]
  selected: ReadonlySet<string>
  onToggle: (id: string) => void
  onAll?: () => void
  onNone?: () => void
  swatch?: boolean
  emptyHint?: string
}) {
  return (
    <section className="rail__group">
      <div className="rail__group-head">
        <span className="rail__group-title">{title}</span>
        <span className="rail__group-actions">
          {onAll !== undefined && (
            <button type="button" className="rail__link" onClick={onAll}>
              all
            </button>
          )}
          {onNone !== undefined && (
            <button type="button" className="rail__link" onClick={onNone}>
              none
            </button>
          )}
        </span>
      </div>
      <ul className="rail__list">
        {items.map((it) => (
          <li key={it.id}>
            <label className={`rail__item ${selected.has(it.id) ? "rail__item--on" : ""}`}>
              <input
                type="checkbox"
                checked={selected.has(it.id)}
                onChange={() => onToggle(it.id)}
              />
              {swatch === true && <span className={`rail__swatch ${it.tone ?? ""}`} />}
              <span className="rail__item-label" title={it.label}>
                {it.label}
              </span>
              {it.count !== undefined && <span className="rail__item-count">{it.count}</span>}
            </label>
          </li>
        ))}
        {items.length === 0 && (
          <li className="rail__empty">{emptyHint ?? "no matches"}</li>
        )}
      </ul>
    </section>
  )
}

/** A free-form rail section (headings, buttons, run controls). */
export function RailSection({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="rail__group">
      {title !== undefined && (
        <div className="rail__group-head">
          <span className="rail__group-title">{title}</span>
        </div>
      )}
      {children}
    </section>
  )
}
