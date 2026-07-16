// Prompts workbench — navigate + edit EVERY ibatexas prompt. The rail lists all
// prompts grouped by pipeline stage; the main pane is an editor over the
// effective text with save (write override) / revert (restore compiled-in
// default). Read-only prompts (not runtime-wired) show but disable editing.
//
// Requires the dev bridge (VITE_QA_CONTROL_BASE/_TOKEN). Overrides are stored in
// the prompt_override table and take effect on the next turn (fail-safe to the
// compiled-in default when absent).

import { useEffect, useMemo, useState, type KeyboardEvent } from "react"
import { currentRoute, replaceRoute } from "../lib/nav"
import {
  fetchPrompt,
  fetchPrompts,
  promptsConfigured,
  revertPrompt,
  savePrompt,
  type PromptDetail,
  type PromptStage,
  type PromptSummary,
} from "../lib/promptsClient"
import { RailSearch, RailSection, Workbench } from "./FilterRail"

/** S13 — make a non-semantic clickable row keyboard-operable (Enter/Space) so the
 *  prompt rail is navigable without a mouse and announces as a button to AT. */
function keyActivate(fn: () => void): (e: KeyboardEvent) => void {
  return (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault()
      fn()
    }
  }
}

const STAGE_ORDER: PromptStage[] = ["planner", "claims", "responder", "ops", "capability"]
const STAGE_LABEL: Record<PromptStage, string> = {
  planner: "Planner",
  claims: "Claims",
  responder: "Responder",
  ops: "Ops (staff)",
  capability: "Capabilities",
}

export function PromptsWorkbench() {
  const cfg = useMemo(() => promptsConfigured(), [])
  const [prompts, setPrompts] = useState<PromptSummary[]>([])
  const [listErr, setListErr] = useState<string | null>(null)
  const [q, setQ] = useState("")
  // Deep-linkable: #prompts/<id> selects a prompt (RCA's LLM rows jump here).
  const [selId, setSelId] = useState<string | null>(() => {
    const r = currentRoute()
    return r?.section === "prompts" && r.promptId !== undefined ? r.promptId : null
  })
  useEffect(() => {
    replaceRoute({ section: "prompts", ...(selId !== null ? { promptId: selId } : {}) })
  }, [selId])
  useEffect(() => {
    const onHash = () => {
      const r = currentRoute()
      if (r?.section === "prompts" && r.promptId !== undefined) setSelId(r.promptId)
    }
    window.addEventListener("hashchange", onHash)
    return () => window.removeEventListener("hashchange", onHash)
  }, [])
  const [detail, setDetail] = useState<PromptDetail | null>(null)
  const [text, setText] = useState("")
  const [status, setStatus] = useState<{ kind: "ok" | "err" | "info"; msg: string } | null>(null)
  const [busy, setBusy] = useState(false)

  const loadList = useMemo(
    () => () => {
      if (cfg === null) return
      fetchPrompts(cfg)
        .then((p) => {
          setPrompts(p)
          setListErr(null)
        })
        .catch((e: unknown) => setListErr((e as Error).message))
    },
    [cfg],
  )

  useEffect(() => {
    loadList()
  }, [loadList])

  useEffect(() => {
    if (cfg === null || selId === null) return
    fetchPrompt(cfg, selId)
      .then((d) => {
        setDetail(d)
        setText(d.effective)
        setStatus(null)
      })
      .catch((e: unknown) => setStatus({ kind: "err", msg: (e as Error).message }))
  }, [cfg, selId])

  if (cfg === null) {
    return (
      <div className="prompts">
        <div className="callout callout--warn">
          <b>Prompt editing is not configured.</b> Set <code>VITE_QA_CONTROL_BASE</code> and{" "}
          <code>VITE_QA_CONTROL_TOKEN</code> (with apps/api dev bridge enabled) to navigate and
          edit prompts.
        </div>
      </div>
    )
  }

  const filtered = prompts.filter(
    (p) =>
      q.trim().length === 0 ||
      p.name.toLowerCase().includes(q.toLowerCase()) ||
      p.id.toLowerCase().includes(q.toLowerCase()),
  )
  const dirty = detail !== null && text !== detail.effective
  const canEdit = detail !== null && detail.editable

  const onSave = () => {
    if (cfg === null || detail === null) return
    setBusy(true)
    savePrompt(cfg, detail.id, text)
      .then(() => {
        setStatus({ kind: "ok", msg: "Saved — takes effect next turn." })
        setSelId(detail.id)
        loadList()
        return fetchPrompt(cfg, detail.id).then((d) => {
          setDetail(d)
          setText(d.effective)
        })
      })
      .catch((e: unknown) => setStatus({ kind: "err", msg: (e as Error).message }))
      .finally(() => setBusy(false))
  }

  const onRevert = () => {
    if (cfg === null || detail === null) return
    setBusy(true)
    revertPrompt(cfg, detail.id)
      .then(() => {
        setStatus({ kind: "info", msg: "Reverted to compiled-in default." })
        loadList()
        return fetchPrompt(cfg, detail.id).then((d) => {
          setDetail(d)
          setText(d.effective)
        })
      })
      .catch((e: unknown) => setStatus({ kind: "err", msg: (e as Error).message }))
      .finally(() => setBusy(false))
  }

  const rail = (
    <>
      <RailSearch value={q} onChange={setQ} placeholder="filter prompts…" />
      {listErr !== null && <div className="rail__empty">error: {listErr}</div>}
      {STAGE_ORDER.map((stage) => {
        const items = filtered.filter((p) => p.stage === stage)
        if (items.length === 0) return null
        return (
          <RailSection key={stage} title={STAGE_LABEL[stage]}>
            <div className="prompt-list">
              {items.map((p) => (
                <div
                  key={p.id}
                  className={`prompt-list__item ${selId === p.id ? "prompt-list__item--sel" : ""}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => setSelId(p.id)}
                  onKeyDown={keyActivate(() => setSelId(p.id))}
                >
                  <span className="prompt-list__name" title={p.id}>
                    {p.name}
                  </span>
                  <span className="prompt-list__meta">
                    {p.hasOverride && <span className="dot-override" title="has override" />}
                    <span className="stage-chip">{p.kind}</span>
                  </span>
                </div>
              ))}
            </div>
          </RailSection>
        )
      })}
    </>
  )

  return (
    <Workbench rail={rail}>
      <div className="prompts">
        {detail === null ? (
          <div className="rca__empty">Select a prompt to view and edit.</div>
        ) : (
          <div className="prompt-editor">
            <div className="prompt-editor__hd">
              <div>
                <h2 className="prompt-editor__title">{detail.name}</h2>
                <div className="prompt-editor__path mono">
                  {detail.id} · {detail.path}
                </div>
              </div>
              <div className="prompt-editor__badges">
                {detail.hasOverride && <span className="badge-override">OVERRIDDEN</span>}
                {!detail.editable && <span className="badge-ro">READ-ONLY</span>}
              </div>
            </div>

            {!detail.editable && (
              <div className="callout callout--warn">
                This prompt is not runtime-wired yet — shown for reference; edits are disabled.
              </div>
            )}

            <textarea
              className="prompt-editor__area"
              value={text}
              disabled={!canEdit || busy}
              spellCheck={false}
              onChange={(e) => setText(e.target.value)}
            />

            <div className="prompt-editor__bar">
              <button
                type="button"
                className="btn btn--primary"
                disabled={!canEdit || !dirty || busy || text.trim().length === 0}
                onClick={onSave}
              >
                Save override
              </button>
              <button
                type="button"
                className="btn"
                disabled={!dirty || busy}
                onClick={() => setText(detail.effective)}
              >
                Reset edits
              </button>
              <button
                type="button"
                className="btn btn--danger"
                disabled={!detail.hasOverride || busy}
                onClick={onRevert}
              >
                Revert to default
              </button>
              <span className="grow" />
              {status !== null && (
                <span
                  className={`prompt-editor__status ${
                    status.kind === "ok"
                      ? "prompt-editor__status--ok"
                      : status.kind === "err"
                        ? "prompt-editor__status--err"
                        : ""
                  }`}
                >
                  {status.msg}
                </span>
              )}
              {dirty && status === null && (
                <span className="prompt-editor__status">unsaved changes</span>
              )}
            </div>
          </div>
        )}
      </div>
    </Workbench>
  )
}
