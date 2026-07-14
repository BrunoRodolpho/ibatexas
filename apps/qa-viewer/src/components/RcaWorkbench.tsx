// RCA "Turn forensics" workbench — the live-data view. Navigate conversations →
// turns (filterable by time range + channel), then render one turn as a
// tri-state pipeline + the ID-bridge dock + deep-links + the merged
// [ADJ]/[LLM]/[VL] timeline with lane toggles and expandable rows. Read-only.
//
// Requires the dev bridge (VITE_QA_CONTROL_BASE/_TOKEN); without it the section
// shows a configuration hint and the viewer stays a pure artifact browser.

import { Fragment, useEffect, useMemo, useState, type KeyboardEvent } from "react"
import {
  buildLinks,
  derivePipeline,
  fetchConversations,
  fetchTurn,
  fetchTurns,
  mergeTimeline,
  rcaConfigured,
  type RcaConversation,
  type RcaTurnDetail,
  type RcaTurnSummary,
  type StageState,
  type TimelineSource,
} from "../lib/rcaClient"
import { RailGroup, RailSearch, RailSection, Workbench } from "./FilterRail"

/** S13 — make a non-semantic clickable row keyboard-operable (Enter/Space) so the
 *  RCA rail is navigable without a mouse and announces as a button to AT. */
function keyActivate(fn: () => void): (e: KeyboardEvent) => void {
  return (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault()
      fn()
    }
  }
}

const STAGE_GLYPH: Record<StageState, string> = {
  ok: "✓",
  warn: "!",
  fail: "✗",
  silent: "◌",
  off: "–",
}

const LANES: TimelineSource[] = ["ADJ", "LLM", "VL", "GAP"]

const TIME_PRESETS = [
  { id: "all", label: "all", ms: null },
  { id: "1h", label: "1h", ms: 3_600_000 },
  { id: "6h", label: "6h", ms: 21_600_000 },
  { id: "24h", label: "24h", ms: 86_400_000 },
  { id: "7d", label: "7d", ms: 604_800_000 },
  { id: "30d", label: "30d", ms: 2_592_000_000 },
] as const

const VL_WINDOWS = ["auto", "1h", "6h", "24h", "7d", "30d"] as const

function CopyId({ value }: { value: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      type="button"
      className={`copy-btn ${done ? "copy-btn--done" : ""}`}
      onClick={() => {
        navigator.clipboard?.writeText(value).catch(() => {})
        setDone(true)
        setTimeout(() => setDone(false), 1100)
      }}
    >
      {done ? "copied" : "copy"}
    </button>
  )
}

function relTime(tMs: number, first: number): string {
  if (!Number.isFinite(tMs) || !Number.isFinite(first)) return "—"
  return `+${tMs - first}`
}

/** "07-11 01:03:29" — date-qualified so multi-day lists stay unambiguous. */
function shortDateTime(iso: string | null | undefined): string {
  if (iso == null) return ""
  return `${iso.slice(5, 10)} ${iso.slice(11, 19)}`
}

/** `<input type="datetime-local">` value → ISO (local tz), or null. */
function dtLocalToIso(v: string): string | null {
  if (v === "") return null
  const t = Date.parse(v)
  return Number.isFinite(t) ? new Date(t).toISOString() : null
}

// Investigation state survives a tab switch / reload (App unmounts sections).
const STORE_KEY = "rca-workbench-v1"
interface PersistedState {
  q?: string
  fromLocal?: string
  toLocal?: string
  preset?: string
  channels?: string[]
  selConv?: string | null
  selTurn?: string | null
}
function loadPersisted(): PersistedState {
  try {
    return JSON.parse(sessionStorage.getItem(STORE_KEY) ?? "{}") as PersistedState
  } catch {
    return {}
  }
}

export function RcaWorkbench() {
  const cfg = useMemo(() => rcaConfigured(), [])
  const saved = useMemo(loadPersisted, [])

  // rail filters
  const [q, setQ] = useState(saved.q ?? "")
  const [preset, setPreset] = useState(saved.preset ?? "all")
  const [fromLocal, setFromLocal] = useState(saved.fromLocal ?? "")
  const [toLocal, setToLocal] = useState(saved.toLocal ?? "")
  const [channelSel, setChannelSel] = useState<ReadonlySet<string>>(new Set(saved.channels ?? []))

  // navigation
  const [convs, setConvs] = useState<RcaConversation[]>([])
  const [convErr, setConvErr] = useState<string | null>(null)
  const [selConv, setSelConv] = useState<string | null>(saved.selConv ?? null)
  const [turns, setTurns] = useState<RcaTurnSummary[]>([])
  const [turnsErr, setTurnsErr] = useState<string | null>(null)
  const [selTurn, setSelTurn] = useState<string | null>(saved.selTurn ?? null)

  // turn detail
  const [detail, setDetail] = useState<RcaTurnDetail | null>(null)
  const [detailErr, setDetailErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [vlWindow, setVlWindow] = useState<string>("auto")
  const [refreshTick, setRefreshTick] = useState(0)

  // timeline view controls
  const [laneOff, setLaneOff] = useState<ReadonlySet<TimelineSource>>(new Set())
  const [evFilter, setEvFilter] = useState("")
  const [absTime, setAbsTime] = useState(false)
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set())

  useEffect(() => {
    const s: PersistedState = {
      q,
      fromLocal,
      toLocal,
      preset,
      channels: [...channelSel],
      selConv,
      selTurn,
    }
    try {
      sessionStorage.setItem(STORE_KEY, JSON.stringify(s))
    } catch {
      /* storage full/blocked — persistence is best-effort */
    }
  }, [q, fromLocal, toLocal, preset, channelSel, selConv, selTurn])

  const fromIso = useMemo(() => {
    if (preset !== "custom") {
      const p = TIME_PRESETS.find((x) => x.id === preset)
      return p?.ms != null ? new Date(Date.now() - p.ms).toISOString() : null
    }
    return dtLocalToIso(fromLocal)
  }, [preset, fromLocal])
  const toIso = useMemo(() => (preset === "custom" ? dtLocalToIso(toLocal) : null), [preset, toLocal])

  // conversations (debounced on filters)
  useEffect(() => {
    if (cfg === null) return
    const t = setTimeout(() => {
      fetchConversations(cfg, { q, from: fromIso, to: toIso, channels: [...channelSel] })
        .then((c) => {
          setConvs(c)
          setConvErr(null)
        })
        .catch((e: unknown) => setConvErr((e as Error).message))
    }, 200)
    return () => clearTimeout(t)
  }, [cfg, q, fromIso, toIso, channelSel])

  // turns of the selected conversation — errors surface, not swallow
  useEffect(() => {
    if (cfg === null || selConv === null) return
    setTurnsErr(null)
    fetchTurns(cfg, selConv)
      .then(setTurns)
      .catch((e: unknown) => {
        setTurns([])
        setTurnsErr((e as Error).message)
      })
  }, [cfg, selConv])

  // detail of the selected turn (re-fetched on window change / manual refresh)
  useEffect(() => {
    if (cfg === null || selTurn === null) return
    setLoading(true)
    setDetailErr(null)
    fetchTurn(cfg, selTurn, vlWindow === "auto" ? null : vlWindow)
      .then((d) => {
        setDetail(d)
        setExpanded(new Set())
      })
      .catch((e: unknown) => {
        setDetail(null)
        setDetailErr((e as Error).message)
      })
      .finally(() => setLoading(false))
  }, [cfg, selTurn, vlWindow, refreshTick])

  if (cfg === null) {
    return (
      <div className="rca">
        <div className="callout callout--warn">
          <b>Live RCA reads are not configured.</b> Set <code>VITE_QA_CONTROL_BASE</code> and{" "}
          <code>VITE_QA_CONTROL_TOKEN</code> (and run apps/api with{" "}
          <code>IBX_QA_CONTROL_ENABLED=1</code> + a matching{" "}
          <code>IBX_QA_CONTROL_TOKEN</code>) to browse live turn forensics.
        </div>
      </div>
    )
  }

  const timeline = detail !== null ? mergeTimeline(detail) : []
  const pipeline = detail !== null ? derivePipeline(detail) : []
  const links = detail !== null ? buildLinks(detail.context) : null
  const firstMs = timeline.find((e) => Number.isFinite(e.tMs))?.tMs ?? Number.NaN

  const laneCounts = new Map<TimelineSource, number>()
  for (const e of timeline) laneCounts.set(e.source, (laneCounts.get(e.source) ?? 0) + 1)
  const evNeedle = evFilter.trim().toLowerCase()
  const visible = timeline
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => !laneOff.has(e.source))
    .filter(({ e }) => evNeedle === "" || e.text.toLowerCase().includes(evNeedle))

  const channelItems = (() => {
    const counts = new Map<string, number>()
    for (const c of convs) counts.set(c.channel, (counts.get(c.channel) ?? 0) + 1)
    for (const ch of channelSel) if (!counts.has(ch)) counts.set(ch, 0)
    return [...counts.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([id, count]) => ({ id, label: id, count }))
  })()

  const selectConv = (sessionId: string) => {
    setSelConv(sessionId)
    setSelTurn(null)
    setDetail(null)
    setTurnsErr(null)
  }

  const rail = (
    <>
      <RailSearch value={q} onChange={setQ} placeholder="filter conversations…" />
      <RailSection title="Time range">
        <div className="chips">
          {TIME_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              className={`chip ${preset === p.id ? "chip--on" : ""}`}
              onClick={() => setPreset(p.id)}
            >
              {p.label}
            </button>
          ))}
          <button
            type="button"
            className={`chip ${preset === "custom" ? "chip--on" : ""}`}
            onClick={() => setPreset("custom")}
          >
            custom
          </button>
        </div>
        {preset === "custom" && (
          <div className="rail__dt">
            <label>
              from
              <input type="datetime-local" value={fromLocal} onChange={(e) => setFromLocal(e.target.value)} />
            </label>
            <label>
              to
              <input type="datetime-local" value={toLocal} onChange={(e) => setToLocal(e.target.value)} />
            </label>
          </div>
        )}
      </RailSection>
      <RailGroup
        title="Channels"
        items={channelItems}
        selected={channelSel}
        onToggle={(id) =>
          setChannelSel((prev) => {
            const next = new Set(prev)
            if (next.has(id)) next.delete(id)
            else next.add(id)
            return next
          })
        }
        onNone={() => setChannelSel(new Set())}
        emptyHint="no conversations loaded"
      />
      <RailSection title="Conversations">
        {convErr !== null && <div className="rail__empty">error: {convErr}</div>}
        <div className="conv-tree">
          {convs.map((c) => (
            <div key={c.sessionId}>
              <div
                className={`conv-tree__conv ${selConv === c.sessionId ? "conv-tree__conv--sel" : ""}`}
                role="button"
                tabIndex={0}
                onClick={() => selectConv(c.sessionId)}
                onKeyDown={keyActivate(() => selectConv(c.sessionId))}
                style={{ cursor: "pointer" }}
              >
                <div className="conv-tree__head">
                  <b>{c.channel}</b> · {c.turnCount} turn(s)
                  <span className="conv-tree__time">{shortDateTime(c.lastAt)}</span>
                </div>
                <div className="mono" style={{ fontSize: 10, opacity: 0.7 }}>
                  {c.sessionId.slice(0, 20)}…
                </div>
                {c.lastText != null && (
                  <div className="conv-tree__preview" title={c.lastText}>
                    {c.lastRole !== null ? `${c.lastRole}: ` : ""}
                    {c.lastText}
                  </div>
                )}
              </div>
              {selConv === c.sessionId && turnsErr !== null && (
                <div className="rail__empty">turns error: {turnsErr}</div>
              )}
              {selConv === c.sessionId &&
                turns.map((t) => (
                  <div
                    key={t.turnId}
                    className={`conv-tree__turn ${selTurn === t.turnId ? "conv-tree__turn--sel" : ""}`}
                    role="button"
                    tabIndex={0}
                    onClick={() => setSelTurn(t.turnId)}
                    onKeyDown={keyActivate(() => setSelTurn(t.turnId))}
                  >
                    <span
                      className="conv-tree__dot"
                      style={{
                        background: t.responderEmpty ? "var(--warn)" : "var(--ok)",
                      }}
                    />
                    <span className="conv-tree__label">
                      <span className="tid">
                        {t.turnId.slice(0, 12)}
                        {t.decision != null && (
                          <span className={`dec-chip dec-chip--${t.decision}`}>{t.decision}</span>
                        )}
                      </span>
                      <span className="txt" title={t.userText ?? undefined}>
                        {t.userText ?? `${t.callCount} call(s)`}
                      </span>
                    </span>
                    <span className="conv-tree__time">{shortDateTime(t.startedAt)}</span>
                  </div>
                ))}
            </div>
          ))}
          {convs.length === 0 && convErr === null && (
            <div className="rail__empty">no conversations</div>
          )}
        </div>
      </RailSection>
    </>
  )

  return (
    <Workbench rail={rail}>
      <div className="rca">
        {detail === null && !loading && (
          <div className="rca__empty">Select a conversation, then a turn to inspect.</div>
        )}
        {loading && <div className="rca__empty">Loading turn…</div>}
        {detailErr !== null && <div className="callout callout--warn">error: {detailErr}</div>}

        {detail !== null && (
          <>
            <div className="turn-hd">
              <div>
                <span className="turn-hd__id">{detail.context.turnId.slice(0, 16)}…</span>
                <div className="turn-hd__meta">
                  <span>
                    <b>{detail.context.channel ?? "?"}</b>
                  </span>
                  <span>
                    calls <b>{detail.llm.length}</b>
                  </span>
                  <span>
                    decisions <b>{detail.adj.length}</b>
                  </span>
                  <span>
                    logs <b>{detail.vl.length}</b>
                  </span>
                  {detail.context.durationMs !== null && (
                    <span>
                      duration <b>{detail.context.durationMs}ms</b>
                    </span>
                  )}
                  {detail.degraded?.adj === true && <span className="degraded-chip">ADJ lane degraded</span>}
                  {detail.degraded?.vl === true && <span className="degraded-chip">VL lane degraded</span>}
                </div>
              </div>
              <button
                type="button"
                className="chip"
                onClick={() => setRefreshTick((n) => n + 1)}
                title="Re-fetch this turn"
              >
                ↻ refresh
              </button>
            </div>

            {(detail.degraded?.adj === true || detail.degraded?.vl === true) && (
              <div className="callout callout--warn">
                A lane degraded to empty because its store was unreachable — absence is <b>not</b> a
                signal on this view. Retry once the store is back.
              </div>
            )}

            {/* pipeline */}
            <div className="card">
              <div className="card__hd">
                <h2>Execution pipeline</h2>
                <span className="hint">tri-state · derived (absence-is-signal)</span>
              </div>
              <div className="pipe">
                {pipeline.map((s, i) => (
                  <div key={s.key} style={{ display: "contents" }}>
                    {i > 0 && (
                      <div
                        className={`pipe__conn ${
                          s.state === "silent" || s.state === "off" ? "pipe__conn--dim" : ""
                        }`}
                      />
                    )}
                    <div className={`pipe__node pipe__node--${s.state}`}>
                      <div className="pipe__badge">{STAGE_GLYPH[s.state]}</div>
                      <div className="pipe__name">{s.label}</div>
                      <div className="pipe__sub">{s.sub}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* identifiers + deep-links */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
              <div className="card">
                <div className="card__hd">
                  <h2>Investigation context</h2>
                </div>
                <div className="card__body">
                  <div className="ids">
                    <div className="ids__row">
                      <span className="ids__k">turn / corr</span>
                      <span className="ids__v">{detail.context.turnId}</span>
                      <CopyId value={detail.context.turnId} />
                    </div>
                    <div className="ids__row">
                      <span className="ids__k">conv uuid</span>
                      <span className="ids__v">{detail.context.conversationId ?? "—"}</span>
                      {detail.context.conversationId !== null && (
                        <CopyId value={detail.context.conversationId} />
                      )}
                    </div>
                    <div className="ids__row">
                      <span className="ids__k">nonce pfx</span>
                      <span className="ids__v">{detail.context.noncePrefix ?? "—"}</span>
                      {detail.context.noncePrefix !== null && (
                        <CopyId value={detail.context.noncePrefix} />
                      )}
                    </div>
                    <div className="ids__row">
                      <span className="ids__k">chat cuid</span>
                      <span className="ids__v">{detail.context.chatCuid ?? "—"}</span>
                    </div>
                    <div className="ids__row">
                      <span className="ids__k">audit sess</span>
                      <span className="ids__v ids__v--hash">
                        {detail.context.sessionHashed ?? "—"}
                      </span>
                    </div>
                  </div>
                  <p className="bridge-note">
                    <b>Bridge:</b> <span className="mono">audit sess</span> is hashed — the API
                    recomputes it (and matches <span className="mono">nonce</span> +{" "}
                    <span className="mono">intent_hash</span>); logs join by{" "}
                    <span className="mono">correlationId/turnId</span> (== turn id).
                  </p>
                </div>
              </div>

              {links !== null && (
                <div className="card">
                  <div className="card__hd">
                    <h2>Launch, already scoped</h2>
                  </div>
                  <div className="card__body">
                    <div className="launch">
                      <a
                        className="launch__btn"
                        href={links.victoriaLogs}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        <span className="launch__ic">{"▣"}</span>
                        <span className="launch__t">
                          <b>Open in VictoriaLogs</b>
                          <small>correlationId + turnId · 1h</small>
                        </span>
                        <span className="launch__tag launch__tag--live">LIVE</span>
                      </a>
                      {links.adjConsole !== null && (
                        <a
                          className="launch__btn"
                          href={links.adjConsole}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          <span className="launch__ic">{"▤"}</span>
                          <span className="launch__t">
                            <b>Adjudicate console</b>
                            <small>/turn-trace/[conv]</small>
                          </span>
                          <span className="launch__tag launch__tag--cli">DEV</span>
                        </a>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* merged timeline */}
            <div className="card">
              <div className="card__hd card__hd--wrap">
                <h2>Merged timeline</h2>
                <div className="chips">
                  {LANES.map((lane) => (
                    <button
                      key={lane}
                      type="button"
                      className={`chip tl-src tl-src--${lane} ${laneOff.has(lane) ? "chip--dim" : ""}`}
                      onClick={() =>
                        setLaneOff((prev) => {
                          const next = new Set(prev)
                          if (next.has(lane)) next.delete(lane)
                          else next.add(lane)
                          return next
                        })
                      }
                      title={laneOff.has(lane) ? `show ${lane} rows` : `hide ${lane} rows`}
                    >
                      {lane} {laneCounts.get(lane) ?? 0}
                    </button>
                  ))}
                  <button
                    type="button"
                    className={`chip ${absTime ? "chip--on" : ""}`}
                    onClick={() => setAbsTime((v) => !v)}
                    title="Toggle relative offsets vs absolute times"
                  >
                    {absTime ? "abs" : "t+ms"}
                  </button>
                  <select
                    className="chip chip--select"
                    value={vlWindow}
                    onChange={(e) => setVlWindow(e.target.value)}
                    title="VL search window (auto = anchored to the turn's own span)"
                  >
                    {VL_WINDOWS.map((w) => (
                      <option key={w} value={w}>
                        VL {w}
                      </option>
                    ))}
                  </select>
                </div>
                <input
                  className="rail__search rail__search--inline"
                  type="search"
                  value={evFilter}
                  placeholder="filter events…"
                  onChange={(e) => setEvFilter(e.target.value)}
                />
                <span className="hint">
                  {visible.length} of {timeline.length} · click a row to expand
                </span>
              </div>
              <table className="trace-table">
                <thead>
                  <tr>
                    <th style={{ width: absTime ? 110 : 70 }}>{absTime ? "time" : "t+ms"}</th>
                    <th style={{ width: 54 }}>src</th>
                    <th>event</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map(({ e, i }) => (
                    <Fragment key={i}>
                      <tr
                        className={`${e.gap === true ? "trace-row--gap" : ""} ${
                          e.detail !== undefined ? "trace-row--expandable" : ""
                        }`}
                        onClick={() => {
                          if (e.detail === undefined) return
                          setExpanded((prev) => {
                            const next = new Set(prev)
                            if (next.has(i)) next.delete(i)
                            else next.add(i)
                            return next
                          })
                        }}
                      >
                        <td className="trace-table__ts">
                          {absTime ? e.ts.slice(11, 23) : relTime(e.tMs, firstMs)}
                        </td>
                        <td>
                          <span className={`tl-src tl-src--${e.source}`}>{e.source}</span>
                        </td>
                        <td className="trace-table__detail">
                          {e.text}
                          {e.empty === true && <span className="empty-chip">empty</span>}
                          {e.detail !== undefined && (
                            <span className="expand-hint">{expanded.has(i) ? "▾" : "▸"}</span>
                          )}
                        </td>
                      </tr>
                      {expanded.has(i) && e.detail !== undefined && (
                        <tr className="trace-row--detail">
                          <td colSpan={3}>
                            <pre className="tl-detail">{e.detail}</pre>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                  {visible.length === 0 && (
                    <tr>
                      <td colSpan={3} className="pending">
                        {timeline.length === 0 ? "no events for this turn" : "no events match the filters"}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </Workbench>
  )
}
