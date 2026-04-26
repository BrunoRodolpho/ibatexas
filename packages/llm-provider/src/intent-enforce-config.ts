// Per-intent enforcement + shadow configuration.
//
// IBX-IGE v2.0 mandates that the kernel-vs-legacy authority flip happen
// per-intent class, not globally. A single `IBX_KERNEL_ENFORCE=true` would
// be the highest-risk production cutover in the framework's lifecycle —
// blast radius spans every mutating intent at once. Per-intent rollout
// stages high-risk intents (financial reversals) behind low-risk ones
// (read-like mutations), each with its own 7-day shadow soak.
//
// Env vars:
//   IBX_KERNEL_SHADOW  — comma-separated list of intent kinds (or "*")
//                        that run adjudicate() alongside legacy. Logs
//                        divergences but legacy stays authoritative.
//   IBX_KERNEL_ENFORCE — comma-separated list (or "*") where adjudicate()
//                        IS authoritative. Bypasses the legacy boolean path.

const WILDCARD = "*"

function parseList(raw: string | undefined): { wildcard: boolean; kinds: ReadonlySet<string> } {
  if (!raw) return { wildcard: false, kinds: new Set() }
  const parts = raw
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
  if (parts.includes(WILDCARD)) {
    return { wildcard: true, kinds: new Set(parts.filter((p) => p !== WILDCARD)) }
  }
  return { wildcard: false, kinds: new Set(parts) }
}

let _shadow: { wildcard: boolean; kinds: ReadonlySet<string> } | null = null
let _enforce: { wildcard: boolean; kinds: ReadonlySet<string> } | null = null
let _envSnapshot: { shadow: string | undefined; enforce: string | undefined } | null = null

function ensureLoaded(env: NodeJS.ProcessEnv): void {
  const shadow = env["IBX_KERNEL_SHADOW"]
  const enforce = env["IBX_KERNEL_ENFORCE"]
  if (
    _envSnapshot &&
    _envSnapshot.shadow === shadow &&
    _envSnapshot.enforce === enforce
  ) {
    return
  }
  _shadow = parseList(shadow)
  _enforce = parseList(enforce)
  _envSnapshot = { shadow, enforce }
}

/** Is this intent kind covered by `IBX_KERNEL_SHADOW`? */
export function isShadowed(intentKind: string, env: NodeJS.ProcessEnv = process.env): boolean {
  ensureLoaded(env)
  return _shadow!.wildcard || _shadow!.kinds.has(intentKind)
}

/** Is this intent kind covered by `IBX_KERNEL_ENFORCE`? */
export function isEnforced(intentKind: string, env: NodeJS.ProcessEnv = process.env): boolean {
  ensureLoaded(env)
  return _enforce!.wildcard || _enforce!.kinds.has(intentKind)
}

/** @internal — reset the cached env snapshot (for tests). */
export function _resetEnforceConfig(): void {
  _shadow = null
  _enforce = null
  _envSnapshot = null
}
