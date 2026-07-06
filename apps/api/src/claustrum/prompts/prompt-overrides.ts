// Prompt override store — the mechanism behind the qa-viewer "Prompts" editor.
//
// Prompt CONTENT is compiled-in TS constants (personas.ts). To let an operator
// EDIT a prompt without a source rewrite/rebuild (and have it work in prod on a
// read-only filesystem), overrides live in a durable Postgres table and are
// consulted at assembly time with the compiled-in constant as fallback:
//
//     resolvePrompt(id, CONST)  ===  override(id) ?? CONST
//
// FAIL-SAFE BY CONSTRUCTION: the hot path (resolvePrompt) reads an in-memory
// snapshot only — never the DB. When no override exists, or the store never
// loaded, or anything errors, it returns the compiled-in constant UNCHANGED, so
// the default runtime is byte-identical to today and the golden-surface +
// prompt-drift guards stay green. Persistence (load at boot, write on edit) is
// best-effort and off the turn path.
//
// COHERENCE: the snapshot Map is process-global — the write endpoint and the
// composer import the SAME module, so an edit is visible to the next turn in
// this process immediately. (Multi-instance prod needs cross-process
// invalidation — e.g. a Redis pubsub bump — noted for the prod admin route.)

import { createHash } from "node:crypto";
import { Pool } from "pg";
import { logger } from "../../lib/logger.js";

/** The compiled-in ids that map to a persona/fragment (see prompt-catalog.ts). */
const snapshot = new Map<string, string>();

/** Read the effective prompt text: override if present, else the constant.
 *  SYNC + never-throws — safe to call on every compose. */
export function resolvePrompt(id: string, fallback: string): string {
  const override = snapshot.get(id);
  return override !== undefined ? override : fallback;
}

export function hasOverride(id: string): boolean {
  return snapshot.has(id);
}

export function overrideText(id: string): string | null {
  return snapshot.get(id) ?? null;
}

export function overriddenIds(): string[] {
  return [...snapshot.keys()];
}

// ── Persistence (best-effort, off the hot path) ─────────────────────────────

let pool: Pool | null = null;
function getPool(): Pool {
  if (pool === null) pool = new Pool({ connectionString: process.env.DATABASE_URL });
  return pool;
}

const DDL = `
  CREATE TABLE IF NOT EXISTS prompt_override (
    prompt_id    TEXT PRIMARY KEY,
    content      TEXT NOT NULL,
    content_hash TEXT,
    updated_by   TEXT,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
  );
`;

function sha(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 12);
}

/** Create the table if absent (idempotent). Best-effort — swallows errors so a
 *  store outage degrades to "no overrides" rather than blocking boot. */
export async function ensurePromptOverrideTable(): Promise<void> {
  try {
    await getPool().query(DDL);
  } catch (err) {
    logger.warn(
      { component: "prompt-overrides", err: (err as Error).message },
      "prompt_override ensureTable failed (swallowed — overrides disabled)",
    );
  }
}

/** Load all overrides into the in-memory snapshot. Call once at boot (after
 *  ensureTable). Best-effort: on failure the snapshot stays empty (source-only). */
export async function loadPromptOverrides(): Promise<void> {
  try {
    const { rows } = await getPool().query(`SELECT prompt_id, content FROM prompt_override`);
    snapshot.clear();
    for (const r of rows as Array<{ prompt_id: string; content: string }>) {
      if (typeof r.prompt_id === "string" && typeof r.content === "string") {
        snapshot.set(r.prompt_id, r.content);
      }
    }
    logger.info(
      { component: "prompt-overrides", count: snapshot.size },
      "prompt overrides loaded",
    );
  } catch (err) {
    logger.warn(
      { component: "prompt-overrides", err: (err as Error).message },
      "prompt override load failed (swallowed — using compiled-in prompts)",
    );
  }
}

/** Upsert an override and refresh the snapshot. Throws on DB failure so the
 *  caller (the dev-gated write endpoint) can report it. */
export async function setPromptOverride(id: string, content: string, updatedBy: string): Promise<void> {
  await getPool().query(
    `INSERT INTO prompt_override (prompt_id, content, content_hash, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (prompt_id) DO UPDATE SET
       content = EXCLUDED.content,
       content_hash = EXCLUDED.content_hash,
       updated_by = EXCLUDED.updated_by,
       updated_at = now()`,
    [id, content, sha(content), updatedBy],
  );
  snapshot.set(id, content);
}

/** Delete an override (revert to the compiled-in constant) and refresh. */
export async function deletePromptOverride(id: string): Promise<void> {
  await getPool().query(`DELETE FROM prompt_override WHERE prompt_id = $1`, [id]);
  snapshot.delete(id);
}
