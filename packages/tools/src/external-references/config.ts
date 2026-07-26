// EXTERNAL-REFERENCE KEYS — the config half of a declared reference (LE2-018).
//
// `@ibatexas/catalog` declares WHICH environment variable names a reference's
// key; this module reads it. The split is CLAUDE.md rule 3 ("config: always
// from process.env — never hardcode values in code") applied to a value that
// used to be a string literal in three files.
//
// # Why there is no default and no fallback
//
// `requireExternalReferenceKey` throws when the variable is unset, with no
// "…?? 'BEMVINDO15'" safety net. A fallback here would defeat the entire
// ticket: the literal would be back in the code, one layer down, and the boot
// gate would happily verify a coupon nobody configured.
//
// The throw is also not a runtime risk, because of the ordering LE2
// Implementation Decision 16 buys. The api's boot gate reconciles every
// declared reference BEFORE the server accepts a request, and an unset
// variable is one of the misses it refuses to start on. By the time any
// consumer calls this function, the process is proof that the variable is set
// — so this throw is the assertion that the gate ran, not an error path
// anybody is expected to hit.

import {
  EXTERNAL_REFERENCES,
  type ExternalReferenceDeclaration,
} from "@ibatexas/catalog"

/** A readable environment — `process.env`, or a fake in a test. */
export type EnvLike = Readonly<Record<string, string | undefined>>

/** Thrown when a declared reference's config variable is unset or blank. */
export class ExternalReferenceConfigError extends Error {
  readonly referenceId: string
  readonly keyFrom: string

  constructor(referenceId: string, keyFrom: string, detail: string) {
    super(
      `[external-references] ${referenceId}: ${detail} ` +
        `Set ${keyFrom} (see .env.example) — the catalog declares the variable, ` +
        "the environment supplies the value.",
    )
    this.name = "ExternalReferenceConfigError"
    this.referenceId = referenceId
    this.keyFrom = keyFrom
  }
}

/** The declaration with this id, or `undefined`. */
export function findExternalReference(
  id: string,
  declarations: readonly ExternalReferenceDeclaration[] = EXTERNAL_REFERENCES,
): ExternalReferenceDeclaration | undefined {
  return declarations.find((declaration) => declaration.id === id)
}

/**
 * The configured key for a declared reference, or `null` when the variable is
 * unset or blank. The non-throwing form — the reconciler uses it, because an
 * unset variable is a MISS it must report beside the others, not an exception
 * that ends the report early.
 */
export function externalReferenceKey(
  id: string,
  options: {
    readonly declarations?: readonly ExternalReferenceDeclaration[]
    readonly env?: EnvLike
  } = {},
): string | null {
  const declaration = findExternalReference(id, options.declarations)
  if (declaration === undefined) return null
  const raw = (options.env ?? process.env)[declaration.keyFrom]
  const value = typeof raw === "string" ? raw.trim() : ""
  return value === "" ? null : value
}

/**
 * The configured key for a declared reference, or throw.
 *
 * This is what CONSUMERS call — the replacement for the string literals that
 * used to sit in `session.ts`, `get-loyalty-balance.ts` and
 * `cart-intelligence.ts`. Unreachable in a booted process; see the module doc.
 */
export function requireExternalReferenceKey(
  id: string,
  options: {
    readonly declarations?: readonly ExternalReferenceDeclaration[]
    readonly env?: EnvLike
  } = {},
): string {
  const declaration = findExternalReference(id, options.declarations)
  if (declaration === undefined) {
    throw new ExternalReferenceConfigError(
      id,
      "(unknown)",
      "no such external reference is declared in @ibatexas/catalog's " +
        "src/external-references.ts.",
    )
  }
  const key = externalReferenceKey(id, options)
  if (key === null) {
    throw new ExternalReferenceConfigError(
      id,
      declaration.keyFrom,
      `${declaration.keyFrom} is unset or blank.`,
    )
  }
  return key
}
