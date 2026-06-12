/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Override the artifact tree the viewer fetches from (default: committed fixtures at `<BASE_URL>artifacts`). */
  readonly VITE_QA_ARTIFACTS_BASE?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
