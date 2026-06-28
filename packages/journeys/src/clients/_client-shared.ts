// _client-shared.ts — shared helpers for the journeys live-contract clients.
//
// Parsing the `.env.test` fixture (parseEnv) and required-key access (need) are
// byte-identical across the client scripts, so they live here as the single
// source of truth (eliminates the cross-file CPD duplication between
// db-verify.ts and chat-adversarial-matrix.ts). Behaviour is unchanged.

/** Parse a dotenv-style fixture into a flat record (skips blanks/comments, strips surrounding quotes). */
export function parseEnv(raw: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of raw.split("\n")) {
    const t = line.trim(); if (!t || t.startsWith("#")) continue
    const eq = t.indexOf("="); if (eq <= 0) continue
    let v = t.slice(eq + 1).trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    out[t.slice(0, eq).trim()] = v
  }
  return out
}

/** Read a required key from a parsed env record; throws the uniform `.env.test missing X` error when absent. */
export const need = (e: Record<string, string>, k: string) => { const v = e[k]; if (!v) { throw new Error(`.env.test missing ${k}`) } return v }
