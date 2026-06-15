// Artifact loading — static GET fetches only (the app's entire I/O surface).
// Defaults to the committed fixtures served at `<BASE_URL>artifacts/` by the
// qa-artifacts vite plugin (dev server AND build output). Point the viewer at
// another statically served artifact tree (e.g. a nightly-run download) with
// `VITE_QA_ARTIFACTS_BASE=https://…/artifacts pnpm dev`.

export function artifactsBase(): string {
  const configured = import.meta.env.VITE_QA_ARTIFACTS_BASE
  const base =
    typeof configured === "string" && configured.length > 0
      ? configured
      : `${import.meta.env.BASE_URL}artifacts`
  return base.endsWith("/") ? base.slice(0, -1) : base
}

export async function fetchArtifactText(path: string): Promise<string> {
  const url = `${artifactsBase()}/${path}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`)
  return res.text()
}

export async function fetchArtifactJson<T>(path: string): Promise<T> {
  return JSON.parse(await fetchArtifactText(path)) as T
}

/** Loading-state wrapper used by App for every artifact fetch. */
export type ArtifactState<T> =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: T }
