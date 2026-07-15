// Hash deep links + cross-surface jumps. The workbench is a single-page app
// whose sections unmount on switch; the URL hash is the one shared address
// space, so every investigation surface is linkable/shareable and every
// cross-surface jump (run trace → RCA conversation, LLM call → prompt editor)
// is just a hash write. Pure parse/build helpers here are unit-tested; the
// two writers differ on history: navigate() pushes (browser back returns to
// the previous surface), replaceRoute() reflects in-section selection state
// without history spam.
//
// Grammar (all segments beyond the section optional):
//   #qa[/<tab>]                        #qa/run-explorer
//   #rca[/conv/<sessionId>][/turn/<turnId>]
//   #prompts[/<promptId>]              prompt ids contain "/" — rest-of-hash
//
// Ids are written raw: conv/turn ids are the API's SAFE_ID charset
// ([A-Za-z0-9:._-]) and prompt ids are catalog ids ([a-z/.-]) — both are
// hash-safe without escaping.

export interface HashRoute {
  section: "qa" | "rca" | "prompts"
  /** qa only */
  tab?: string
  /** rca only */
  conv?: string
  turn?: string
  /** prompts only */
  promptId?: string
}

export function parseHash(raw: string): HashRoute | null {
  const h = raw.startsWith("#") ? raw.slice(1) : raw
  if (h.length === 0) return null
  const [head, ...rest] = h.split("/")
  if (head === "qa") {
    return rest.length > 0 ? { section: "qa", tab: rest.join("/") } : { section: "qa" }
  }
  if (head === "prompts") {
    return rest.length > 0 ? { section: "prompts", promptId: rest.join("/") } : { section: "prompts" }
  }
  if (head === "rca") {
    const out: HashRoute = { section: "rca" }
    for (let i = 0; i + 1 < rest.length; i += 2) {
      const key = rest[i]
      const value = rest[i + 1]
      if (value === undefined || value.length === 0) continue
      if (key === "conv") out.conv = value
      if (key === "turn") out.turn = value
    }
    return out
  }
  return null
}

export function buildHash(route: HashRoute): string {
  switch (route.section) {
    case "qa":
      return `#qa${route.tab !== undefined ? `/${route.tab}` : ""}`
    case "prompts":
      return `#prompts${route.promptId !== undefined ? `/${route.promptId}` : ""}`
    case "rca": {
      let h = "#rca"
      if (route.conv !== undefined) h += `/conv/${route.conv}`
      if (route.turn !== undefined) h += `/turn/${route.turn}`
      return h
    }
  }
}

export function currentRoute(): HashRoute | null {
  return parseHash(window.location.hash)
}

/** Jump to another surface (pushes history — back returns you here). */
export function navigate(route: HashRoute): void {
  window.location.hash = buildHash(route)
}

/** Reflect in-section selection into the URL without history spam. Does NOT
 *  fire hashchange (replaceState), so writers never loop with listeners. */
export function replaceRoute(route: HashRoute): void {
  history.replaceState(null, "", buildHash(route))
}
