// RCA "Turn forensics" workbench — the live-data view. Navigate conversations →
// turns (filterable by time range + channel, or found by message text), then
// render one turn as a preflight strip + tri-state pipeline + the ID-bridge
// dock + deep-links + the merged [ADJ]/[LLM]/[VL] timeline with lane toggles
// and expandable rows + a redacted transcript pane. Read-only.
//
// Deep-linkable: the selection lives in the URL hash (#rca/conv/…/turn/…,
// lib/nav.ts) so investigations are shareable and other surfaces can jump in.
//
// Requires the dev bridge (VITE_QA_CONTROL_BASE/_TOKEN); without it the section
// shows a configuration hint and the viewer stays a pure artifact browser.

import { Fragment, useEffect, useMemo, useState, type KeyboardEvent } from "react"
import { currentRoute, navigate, replaceRoute } from "../lib/nav"
import {
  buildLinks,
  buildWireSections,
  derivePipeline,
  fetchConversations,
  fetchStatus,
  fetchTranscript,
  fetchTurn,
  fetchTurns,
  findMessages,
  mergeTimeline,
  rcaConfigured,
  stageFacts,
  type RcaConversation,
  type RcaFindHit,
  type RcaStatus,
  type RcaTranscript,
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
  live?: boolean
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
  // A deep link (#rca/conv/…/turn/…) outranks the sessionStorage restore —
  // and when the hash carries ANY selection it is authoritative for BOTH
  // fields (a jump to conv X must not inherit a stale saved turn of conv Y).
  const hashRoute = useMemo(() => {
    const r = currentRoute()
    return r?.section === "rca" ? r : null
  }, [])
  const hashHasSel = hashRoute !== null && (hashRoute.conv !== undefined || hashRoute.turn !== undefined)

  // rail filters
  const [q, setQ] = useState(saved.q ?? "")
  const [preset, setPreset] = useState(saved.preset ?? "all")
  const [fromLocal, setFromLocal] = useState(saved.fromLocal ?? "")
  const [toLocal, setToLocal] = useState(saved.toLocal ?? "")
  const [channelSel, setChannelSel] = useState<ReadonlySet<string>>(new Set(saved.channels ?? []))

  // navigation
  const [convs, setConvs] = useState<RcaConversation[]>([])
  const [convErr, setConvErr] = useState<string | null>(null)
  const [selConv, setSelConv] = useState<string | null>(
    hashHasSel ? (hashRoute.conv ?? null) : (saved.selConv ?? null),
  )
  const [turns, setTurns] = useState<RcaTurnSummary[]>([])
  const [turnsErr, setTurnsErr] = useState<string | null>(null)
  const [selTurn, setSelTurn] = useState<string | null>(
    hashHasSel ? (hashRoute.turn ?? null) : (saved.selTurn ?? null),
  )

  // turn detail
  const [detail, setDetail] = useState<RcaTurnDetail | null>(null)
  const [detailErr, setDetailErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [vlWindow, setVlWindow] = useState<string>("auto")
  const [refreshTick, setRefreshTick] = useState(0)
  // live auto-refresh — scoped to the current selection (turn > conv > list)
  const [live, setLive] = useState(saved.live ?? true)

  // timeline view controls
  const [laneOff, setLaneOff] = useState<ReadonlySet<TimelineSource>>(new Set())
  const [evFilter, setEvFilter] = useState("")
  const [absTime, setAbsTime] = useState(false)
  // Expanded rows key by stable event identity (source|ts|text), NOT index —
  // a live re-fetch that inserts rows must not shift which rows stay open.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  // Donut drill-down: the focused pipeline stage (evidence + timeline filter)
  const [selStage, setSelStage] = useState<string | null>(null)

  // preflight store probes (re-run on manual refresh)
  const [status, setStatus] = useState<RcaStatus | null>(null)

  // find-by-text over the audit ledger
  const [findQ, setFindQ] = useState("")
  const [findHits, setFindHits] = useState<RcaFindHit[] | null>(null)
  const [findErr, setFindErr] = useState<string | null>(null)
  const [findBusy, setFindBusy] = useState(false)

  // redacted transcript of the selected conversation (lazy: fetched on open)
  const [transcript, setTranscript] = useState<RcaTranscript | null>(null)
  const [transcriptOpen, setTranscriptOpen] = useState(false)
  const [transcriptErr, setTranscriptErr] = useState<string | null>(null)

  useEffect(() => {
    const s: PersistedState = {
      q,
      fromLocal,
      toLocal,
      preset,
      channels: [...channelSel],
      selConv,
      selTurn,
      live,
    }
    try {
      sessionStorage.setItem(STORE_KEY, JSON.stringify(s))
    } catch {
      /* storage full/blocked — persistence is best-effort */
    }
  }, [q, fromLocal, toLocal, preset, channelSel, selConv, selTurn, live])

  // Deep-link plumbing: reflect the selection into the URL (replace — no
  // history spam; replaceState never fires hashchange, so no listener loop),
  // and follow cross-surface jumps that land while this section is mounted.
  useEffect(() => {
    replaceRoute({
      section: "rca",
      ...(selConv !== null ? { conv: selConv } : {}),
      ...(selTurn !== null ? { turn: selTurn } : {}),
    })
  }, [selConv, selTurn])

  useEffect(() => {
    const onHash = () => {
      const r = currentRoute()
      if (r === null || r.section !== "rca") return
      if (r.conv !== undefined) setSelConv(r.conv)
      if (r.turn !== undefined) {
        setSelTurn(r.turn)
      } else if (r.conv !== undefined) {
        setSelTurn(null)
        setDetail(null)
      }
    }
    window.addEventListener("hashchange", onHash)
    return () => window.removeEventListener("hashchange", onHash)
  }, [])

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

  // Switching turns resets the view state; a background re-fetch of the SAME
  // turn must not (rows the investigator opened stay open across live ticks).
  useEffect(() => {
    setExpanded(new Set())
    setSelStage(null)
  }, [selTurn])

  // detail of the selected turn (re-fetched on window change / manual refresh)
  useEffect(() => {
    if (cfg === null || selTurn === null) return
    setLoading(true)
    setDetailErr(null)
    fetchTurn(cfg, selTurn, vlWindow === "auto" ? null : vlWindow)
      .then(setDetail)
      .catch((e: unknown) => {
        setDetail(null)
        setDetailErr((e as Error).message)
      })
      .finally(() => setLoading(false))
  }, [cfg, selTurn, vlWindow, refreshTick])

  // Live auto-refresh: a 5s tick scoped to the current selection — with a turn
  // open it re-reads only that turn (+ its conversation's turn list); with only
  // a conversation open, only that turn list; with nothing selected, the
  // conversation list. Silent on transient errors (the manual path surfaces
  // them), paused while the tab is hidden.
  useEffect(() => {
    if (cfg === null || !live) return
    const tick = () => {
      if (document.visibilityState !== "visible") return
      if (selTurn !== null) {
        fetchTurn(cfg, selTurn, vlWindow === "auto" ? null : vlWindow)
          .then(setDetail)
          .catch(() => {})
        if (selConv !== null) {
          fetchTurns(cfg, selConv)
            .then(setTurns)
            .catch(() => {})
        }
      } else if (selConv !== null) {
        fetchTurns(cfg, selConv)
          .then(setTurns)
          .catch(() => {})
      } else {
        fetchConversations(cfg, { q, from: fromIso, to: toIso, channels: [...channelSel] })
          .then((c) => {
            setConvs(c)
            setConvErr(null)
          })
          .catch(() => {})
      }
    }
    const t = setInterval(tick, 5_000)
    return () => clearInterval(t)
  }, [cfg, live, selTurn, selConv, vlWindow, q, fromIso, toIso, channelSel])

  // A bare #rca/turn/<id> deep link resolves its conversation from the loaded
  // detail — adopt it so the rail highlights and loads the turn list.
  useEffect(() => {
    if (detail === null) return
    const conv = detail.context.conversationId
    if (conv !== null) setSelConv((prev) => (prev === conv ? prev : conv))
  }, [detail])

  // preflight probes — on mount and on every manual refresh
  useEffect(() => {
    if (cfg === null) return
    fetchStatus(cfg)
      .then(setStatus)
      .catch(() => setStatus(null))
  }, [cfg, refreshTick])

  // transcript resets with the conversation; fetched lazily when opened
  useEffect(() => {
    setTranscript(null)
    setTranscriptErr(null)
  }, [selConv])
  useEffect(() => {
    if (cfg === null || selConv === null || !transcriptOpen || transcript !== null) return
    fetchTranscript(cfg, selConv)
      .then(setTranscript)
      .catch((e: unknown) => setTranscriptErr((e as Error).message))
  }, [cfg, selConv, transcriptOpen, transcript])

  const runFind = () => {
    if (cfg === null || findQ.trim().length < 2) return
    setFindBusy(true)
    setFindErr(null)
    findMessages(cfg, findQ.trim(), { from: fromIso, to: toIso })
      .then(setFindHits)
      .catch((e: unknown) => {
        setFindHits([])
        setFindErr((e as Error).message)
      })
      .finally(() => setFindBusy(false))
  }

  const jumpToHit = (h: RcaFindHit) => {
    if (h.sessionId === null) return
    setSelConv(h.sessionId)
    setTurnsErr(null)
    setSelTurn(h.turnId)
    setDetail(null)
  }

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
  // Stable row identity (before any filtering, so filters can't shift keys);
  // duplicate identities disambiguate by occurrence order.
  const seenKeys = new Map<string, number>()
  const visible = timeline
    .map((e) => {
      const base = `${e.source}|${e.ts}|${e.text}`
      const n = seenKeys.get(base) ?? 0
      seenKeys.set(base, n + 1)
      return { e, k: n === 0 ? base : `${base}#${n}` }
    })
    .filter(({ e }) => !laneOff.has(e.source))
    .filter(({ e }) => selStage === null || e.stage === selStage)
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
      <RailSection title="Find message">
        <div className="find">
          <input
            className="rail__search"
            type="search"
            value={findQ}
            placeholder="text in any message…"
            onChange={(e) => setFindQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") runFind()
            }}
          />
          <button
            type="button"
            className="chip"
            onClick={runFind}
            disabled={findBusy || findQ.trim().length < 2}
          >
            {findBusy ? "…" : "find"}
          </button>
        </div>
        {findErr !== null && <div className="rail__empty">error: {findErr}</div>}
        {findHits !== null && findErr === null && (
          <div className="find__hits">
            {findHits.map((h, i) => (
              <div
                key={i}
                className={`find__hit ${h.turnId === null ? "find__hit--dead" : ""}`}
                role="button"
                tabIndex={0}
                onClick={() => jumpToHit(h)}
                onKeyDown={keyActivate(() => jumpToHit(h))}
                title={
                  h.turnId === null
                    ? "no matching turn — open the conversation"
                    : "jump to this turn"
                }
              >
                <span className="find__meta">
                  {shortDateTime(h.recordedAt)} · {h.role ?? "?"}
                  {h.turnId === null ? " · no turn" : ""}
                </span>
                <span className="find__text">{h.text}</span>
              </div>
            ))}
            {findHits.length === 0 && <div className="rail__empty">no matches in the ledger</div>}
          </div>
        )}
        <p className="rail__note">
          searches archived message content, both roles · honors the time range above
        </p>
      </RailSection>
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

  const turnSpan =
    detail !== null && detail.context.startedAt !== null
      ? {
          s: Date.parse(detail.context.startedAt) - 5_000,
          e: Date.parse(detail.context.endedAt ?? detail.context.startedAt) + 20_000,
        }
      : null

  return (
    <Workbench rail={rail}>
      <div className="rca">
        <div className="rca__toolbar">
          <button
            type="button"
            className={`chip ${live ? "chip--on" : ""}`}
            onClick={() => setLive((v) => !v)}
            title="Auto-refresh every 5s, scoped to the selection (turn ▸ conversation ▸ list) — pauses while the tab is hidden"
          >
            {live ? "● live 5s" : "live off"}
          </button>
          <span className="hint">
            {live
              ? selTurn !== null
                ? "auto-refreshing the selected turn"
                : selConv !== null
                  ? "auto-refreshing the selected conversation"
                  : "auto-refreshing the conversation list"
              : "manual refresh only"}
          </span>
        </div>
        {status !== null && (
          <div className="preflight">
            <span className="preflight__title">preflight</span>
            {(
              [
                ["turnTrace", "turn_trace"],
                ["intentAudit", "intent_audit"],
                ["domain", "domain"],
                ["victoriaLogs", "VictoriaLogs"],
              ] as const
            ).map(([key, label]) => (
              <span
                key={key}
                className={`preflight__item ${
                  status[key].ok ? "preflight__item--ok" : "preflight__item--down"
                }`}
                title={status[key].error ?? `${status[key].latencyMs}ms`}
              >
                <span className="preflight__dot" />
                {label}
              </span>
            ))}
            <span className="preflight__item">
              claims {status.flags.claimsPipeline ? "on (3-call turns)" : "off"}
            </span>
            {!status.flags.redactSecretSet && (
              <span
                className="preflight__item preflight__item--warn"
                title="AUDIT_REDACT_SECRET unset — ADJ bridge arm 2 (session hash) may mismatch the writer"
              >
                ⚠ redact secret unset
              </span>
            )}
          </div>
        )}

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
                  {/* LE2-014 — the catalog version this turn ran under. Read-only,
                      and rendered UNCONDITIONALLY (unlike duration above): when a
                      turn has no stamp, "catalog —" is itself the finding — either
                      the turn predates the stamp or the writer never resolved a
                      catalog. Hiding the chip would make an unreplayable turn look
                      identical to a replayable one. */}
                  <span title="@ibatexas/catalog version this turn ran under (turn_trace.catalog_version)">
                    catalog <b>{detail.context.catalogVersion ?? "—"}</b>
                  </span>
                  {detail.degraded?.adj === true && <span className="degraded-chip">ADJ lane degraded</span>}
                  {detail.degraded?.vl === true && <span className="degraded-chip">VL lane degraded</span>}
                  {detail.degraded?.wire === true && <span className="degraded-chip">WIRE lane degraded</span>}
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

            {(detail.degraded?.adj === true || detail.degraded?.vl === true || detail.degraded?.wire === true) && (
              <div className="callout callout--warn">
                A lane degraded to empty because its store was unreachable — absence is <b>not</b> a
                signal on this view. Retry once the store is back.
              </div>
            )}

            {/* pipeline */}
            <div className="card">
              <div className="card__hd">
                <h2>Execution pipeline</h2>
                <span className="hint">tri-state · derived (absence-is-signal) · click a stage for its evidence</span>
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
                    <div
                      className={`pipe__node pipe__node--${s.state} ${
                        selStage === s.key ? "pipe__node--sel" : ""
                      }`}
                      role="button"
                      tabIndex={0}
                      aria-pressed={selStage === s.key}
                      onClick={() => setSelStage((prev) => (prev === s.key ? null : s.key))}
                      onKeyDown={keyActivate(() => setSelStage((prev) => (prev === s.key ? null : s.key)))}
                      title={selStage === s.key ? "clear stage focus" : `focus ${s.label}: evidence + filtered timeline`}
                    >
                      <div className="pipe__badge">{STAGE_GLYPH[s.state]}</div>
                      <div className="pipe__name">{s.label}</div>
                      <div className="pipe__sub">{s.sub}</div>
                    </div>
                  </div>
                ))}
              </div>
              {selStage !== null && (
                <div className="pipe__evidence">
                  <div className="pipe__evidence-hd">
                    <b>{pipeline.find((s) => s.key === selStage)?.label ?? selStage}</b> — stage evidence
                    <span className="hint">merged timeline below is filtered to this stage</span>
                    <button type="button" className="chip chip--mini" onClick={() => setSelStage(null)}>
                      ✕ clear
                    </button>
                  </div>
                  {stageFacts(detail, selStage).map((f, i) => (
                    <div key={i} className="pipe__evidence-row">
                      {f}
                    </div>
                  ))}
                </div>
              )}
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
                  {selStage !== null && (
                    <button
                      type="button"
                      className="chip chip--on"
                      onClick={() => setSelStage(null)}
                      title="showing only this stage's rows — click to clear"
                    >
                      stage: {selStage} ✕
                    </button>
                  )}
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
                  {visible.map(({ e, k }) => (
                    <Fragment key={k}>
                      <tr
                        className={`${e.gap === true ? "trace-row--gap" : ""} ${
                          e.detail !== undefined ? "trace-row--expandable" : ""
                        }`}
                        onClick={() => {
                          if (e.detail === undefined) return
                          setExpanded((prev) => {
                            const next = new Set(prev)
                            if (next.has(k)) next.delete(k)
                            else next.add(k)
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
                          {e.promptId !== undefined && (
                            <button
                              type="button"
                              className="chip chip--mini"
                              onClick={(ev) => {
                                ev.stopPropagation()
                                const pid = e.promptId
                                if (pid !== undefined) navigate({ section: "prompts", promptId: pid })
                              }}
                              title="Open this persona in the Prompts editor"
                            >
                              prompt ▸
                            </button>
                          )}
                          {e.detail !== undefined && (
                            <span className="expand-hint">{expanded.has(k) ? "▾" : "▸"}</span>
                          )}
                        </td>
                      </tr>
                      {expanded.has(k) && e.detail !== undefined && (
                        <tr className="trace-row--detail">
                          <td colSpan={3}>
                            {e.detail.length > 0 && <pre className="tl-detail">{e.detail}</pre>}
                            {e.source === "LLM" && e.wire === undefined && (
                              <div className="wire-x__head wire-x__head--absent">
                                no wire capture for this call
                                {detail?.degraded?.wire === true
                                  ? " — the wire store was unreachable (retry once it is back)"
                                  : " — the turn predates Wire Truth capture"}
                              </div>
                            )}
                            {e.wire?.map((x) => {
                              const s = buildWireSections(x)
                              return (
                                <div key={x.seq} className="wire-x">
                                  <div className="wire-x__head">
                                    wire seq {x.seq}
                                    {x.requestHash !== null && ` · ${x.requestHash.slice(0, 12)}…`}
                                    {s.truncated.request && " · request TRUNCATED"}
                                    {s.truncated.response && " · response TRUNCATED"}
                                  </div>
                                  <div className="wire-x__params">{s.params}</div>
                                  {s.raw !== undefined && (
                                    <pre className="tl-detail">{s.raw}</pre>
                                  )}
                                  {s.messages.map((m, mi) =>
                                    m.role === "system" ? (
                                      <details key={mi} className="wire-x__block">
                                        <summary>system ({m.content.length} chars)</summary>
                                        <pre className="tl-detail">{m.content}</pre>
                                      </details>
                                    ) : (
                                      <div key={mi} className="wire-x__block">
                                        <span className="wire-x__role">{m.role}</span>
                                        <pre className="tl-detail">{m.content}</pre>
                                      </div>
                                    ),
                                  )}
                                  {s.tools.length > 0 && (
                                    <details className="wire-x__block">
                                      <summary>
                                        tools ({s.tools.map((t) => t.name).join(", ")})
                                      </summary>
                                      {s.tools.map((t) => (
                                        <div key={t.name}>
                                          <span className="wire-x__role">{t.name}</span>
                                          <pre className="tl-detail">{t.schema}</pre>
                                        </div>
                                      ))}
                                    </details>
                                  )}
                                  <details className="wire-x__block" open={s.messages.length === 0}>
                                    <summary>raw response</summary>
                                    <pre className="tl-detail">{s.response}</pre>
                                  </details>
                                </div>
                              )
                            })}
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

        {/* redacted transcript — per conversation, lazy-fetched on open */}
        {selConv !== null && (
          <div className="card">
            <div className="card__hd">
              <h2>Transcript</h2>
              <button
                type="button"
                className="chip"
                onClick={() => setTranscriptOpen((v) => !v)}
              >
                {transcriptOpen ? "hide" : "show"}
              </button>
              <span className="hint">
                archived messages · server-redacted
                {transcript !== null && !transcript.degraded
                  ? ` · ${transcript.messages.length}`
                  : ""}
                {detail !== null ? " · selected turn highlighted" : ""}
              </span>
            </div>
            {transcriptOpen && (
              <div className="transcript">
                {transcriptErr !== null && <div className="rail__empty">error: {transcriptErr}</div>}
                {transcript?.degraded === true && (
                  <div className="callout callout--warn">
                    domain schema unreachable — an empty transcript is <b>not</b> evidence of no
                    messages here.
                  </div>
                )}
                {(transcript?.messages ?? []).map((m, i) => {
                  const at = m.sentAt !== null ? Date.parse(m.sentAt) : Number.NaN
                  const inTurn =
                    turnSpan !== null && Number.isFinite(at) && at >= turnSpan.s && at <= turnSpan.e
                  return (
                    <div
                      key={i}
                      className={`tr-msg ${m.role === "user" ? "tr-msg--user" : "tr-msg--bot"} ${
                        inTurn ? "tr-msg--turn" : ""
                      }`}
                    >
                      <span className="tr-msg__meta">
                        {shortDateTime(m.sentAt)} · {m.role ?? "?"}
                        {inTurn ? " · this turn" : ""}
                      </span>
                      <div className="tr-msg__text">{m.text}</div>
                    </div>
                  )
                })}
                {transcript !== null && !transcript.degraded && transcript.messages.length === 0 && (
                  <div className="rail__empty">
                    no archived messages (ops-plane conversations have no domain row)
                  </div>
                )}
                {transcript === null && transcriptErr === null && (
                  <div className="rail__empty">loading…</div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </Workbench>
  )
}
