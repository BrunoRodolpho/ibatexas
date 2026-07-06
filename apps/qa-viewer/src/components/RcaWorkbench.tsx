// RCA "Turn forensics" workbench — the live-data view. Navigate conversations →
// turns, then render one turn as a tri-state pipeline + the ID-bridge dock +
// deep-links + the merged [ADJ]/[LLM]/[VL] timeline. Read-only.
//
// Requires the dev bridge (VITE_QA_CONTROL_BASE/_TOKEN); without it the section
// shows a configuration hint and the viewer stays a pure artifact browser.

import { useEffect, useMemo, useState } from "react"
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
} from "../lib/rcaClient"
import { RailSearch, RailSection, Workbench } from "./FilterRail"

const STAGE_GLYPH: Record<StageState, string> = {
  ok: "✓",
  warn: "!",
  fail: "✗",
  silent: "◌",
  off: "–",
}

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

export function RcaWorkbench() {
  const cfg = useMemo(() => rcaConfigured(), [])
  const [q, setQ] = useState("")
  const [convs, setConvs] = useState<RcaConversation[]>([])
  const [convErr, setConvErr] = useState<string | null>(null)
  const [selConv, setSelConv] = useState<string | null>(null)
  const [turns, setTurns] = useState<RcaTurnSummary[]>([])
  const [selTurn, setSelTurn] = useState<string | null>(null)
  const [detail, setDetail] = useState<RcaTurnDetail | null>(null)
  const [detailErr, setDetailErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  // conversations (debounced on q)
  useEffect(() => {
    if (cfg === null) return
    const t = setTimeout(() => {
      fetchConversations(cfg, q)
        .then((c) => {
          setConvs(c)
          setConvErr(null)
        })
        .catch((e: unknown) => setConvErr((e as Error).message))
    }, 200)
    return () => clearTimeout(t)
  }, [cfg, q])

  // turns of the selected conversation
  useEffect(() => {
    if (cfg === null || selConv === null) return
    fetchTurns(cfg, selConv)
      .then(setTurns)
      .catch(() => setTurns([]))
  }, [cfg, selConv])

  // detail of the selected turn
  useEffect(() => {
    if (cfg === null || selTurn === null) return
    setLoading(true)
    setDetailErr(null)
    fetchTurn(cfg, selTurn)
      .then((d) => setDetail(d))
      .catch((e: unknown) => {
        setDetail(null)
        setDetailErr((e as Error).message)
      })
      .finally(() => setLoading(false))
  }, [cfg, selTurn])

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

  const rail = (
    <>
      <RailSearch value={q} onChange={setQ} placeholder="filter conversations…" />
      <RailSection title="Conversations">
        {convErr !== null && <div className="rail__empty">error: {convErr}</div>}
        <div className="conv-tree">
          {convs.map((c) => (
            <div key={c.sessionId}>
              <div
                className="conv-tree__conv"
                onClick={() => {
                  setSelConv(c.sessionId)
                  setSelTurn(null)
                  setDetail(null)
                }}
                style={{ cursor: "pointer" }}
              >
                <b>{c.channel}</b> · {c.turnCount} turn(s)
                <div className="mono" style={{ fontSize: 10, opacity: 0.7 }}>
                  {c.sessionId.slice(0, 20)}…
                </div>
              </div>
              {selConv === c.sessionId &&
                turns.map((t) => (
                  <div
                    key={t.turnId}
                    className={`conv-tree__turn ${selTurn === t.turnId ? "conv-tree__turn--sel" : ""}`}
                    onClick={() => setSelTurn(t.turnId)}
                  >
                    <span
                      className="conv-tree__dot"
                      style={{
                        background: t.responderEmpty ? "var(--warn)" : "var(--ok)",
                      }}
                    />
                    <span className="conv-tree__label">
                      <span className="tid">{t.turnId.slice(0, 12)}</span>
                      <span className="txt">{t.callCount} call(s)</span>
                    </span>
                    <span className="conv-tree__time">
                      {t.startedAt !== null ? t.startedAt.slice(11, 19) : ""}
                    </span>
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
                </div>
              </div>
            </div>

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
                    <b>Bridge:</b> <span className="mono">audit sess</span> is hashed — join
                    Postgres by <span className="mono">nonce</span>, logs by{" "}
                    <span className="mono">correlationId</span> (== turn id).
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
                          <small>correlationId + 1h</small>
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
              <div className="card__hd">
                <h2>Merged timeline</h2>
                <span className="hint">[ADJ] kernel · [LLM] model · [VL] logs · [GAP] absence</span>
              </div>
              <table className="trace-table">
                <thead>
                  <tr>
                    <th style={{ width: 70 }}>t+ms</th>
                    <th style={{ width: 54 }}>src</th>
                    <th>event</th>
                  </tr>
                </thead>
                <tbody>
                  {timeline.map((e, i) => (
                    <tr key={i} className={e.gap === true ? "trace-row--gap" : ""}>
                      <td className="trace-table__ts">{relTime(e.tMs, firstMs)}</td>
                      <td>
                        <span className={`tl-src tl-src--${e.source}`}>{e.source}</span>
                      </td>
                      <td className="trace-table__detail">
                        {e.text}
                        {e.empty === true && <span className="empty-chip">empty</span>}
                      </td>
                    </tr>
                  ))}
                  {timeline.length === 0 && (
                    <tr>
                      <td colSpan={3} className="pending">
                        no events for this turn
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
