// M1 — reading a production Lua script's TEXT out of the site that runs it.
//
// See docs/architecture/redis-lua-testing-decision.md, qualification Q2: each
// script SHAPE gets ONE contract suite, and the call sites "inherit the shape's
// invariant from the contract suite".
//
// That inheritance is only real if the contract suite runs the SAME BYTES the
// call site runs. A shape suite that retypes the Lua into the test file proves
// something about the test file: a site could drop `== ARGV[1]` tomorrow and
// every shape assertion would stay green, which is the same green-lie shape the
// ruling exists to remove — one layer further out.
//
// So the shape suites do not retype anything. They read the script out of the
// production source and hand it to a real Redis. Corrupt a production script and
// the shape suite goes red, because the corrupted text is what gets EVAL'd.
//
// WHY SOURCE TEXT AND NOT AN IMPORT
// ---------------------------------
// Only 3 of the 20+ script constants are exported (`COMPARE_AND_DELETE_SCRIPT`,
// `EVAL_INCR_CHECK_SCRIPT`, `TRIGGER_DEDUP_COMPARE_AND_DELETE_SCRIPT`); the rest
// are module-private, and two sites (`jobs/outbox-retry.ts`,
// `jobs/anonymize-medusa-retry.ts`) have no constant at all — the Lua is an
// inline literal in the `eval()` call. Exporting fifteen constants to make them
// testable would be a production edit in service of a test, and it would still
// not cover the two inline ones. Reading the source covers every site uniformly
// and adds no production surface.
//
// The obvious objection — "your extractor could be lying" — is answered by a
// control rather than by assertion: `lua-shape-cad-contract.test.ts`, in the
// case named "the extractor agrees with ground truth where ground truth
// exists", extracts all three EXPORTED constants by this path and requires the
// result to be byte-identical to the imported value. Ground truth exists for
// exactly those three, so the extractor is measured against it wherever it can
// be measured at all.
//
// EVERY FAILURE HERE THROWS
// -------------------------
// An extractor that returns `""` or `undefined` on a miss would hand the shape
// suites an empty script, and `EVAL ""` against Redis returns nil without error
// — a whole suite could pass while testing nothing. So every path below throws
// with the site named. There is no soft failure mode.

import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

/** <repo>/apps/api/src/__tests__/helpers → <repo> */
const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "..",
)

/**
 * Pull the template literal that follows `anchor` in `repoRelativeFile`.
 *
 * `anchor` must occur EXACTLY ONCE in the file. That is not tidiness — an
 * anchor matching twice means the extractor is guessing which site it read,
 * and a shape suite that quietly tests the wrong script is worse than one that
 * fails. Ambiguity throws.
 */
export function extractLuaAfter(repoRelativeFile: string, anchor: string): string {
  const abs = path.join(REPO_ROOT, repoRelativeFile)
  let src: string
  try {
    src = readFileSync(abs, "utf8")
  } catch (err) {
    throw new Error(
      `[lua-script-sources] cannot read ${repoRelativeFile} (resolved ${abs}). ` +
        `If the site moved, update the shape suite's hand-written site table. ` +
        `Underlying: ${String(err)}`,
    )
  }

  const first = src.indexOf(anchor)
  if (first === -1) {
    throw new Error(
      `[lua-script-sources] anchor not found in ${repoRelativeFile}: ${JSON.stringify(anchor)}. ` +
        `The Lua site was renamed, moved or deleted — update the site table deliberately.`,
    )
  }
  if (src.indexOf(anchor, first + 1) !== -1) {
    throw new Error(
      `[lua-script-sources] anchor is AMBIGUOUS in ${repoRelativeFile} (matches more than once): ` +
        `${JSON.stringify(anchor)}. Narrow it — an extractor that guesses which site it read ` +
        `can silently test the wrong script.`,
    )
  }

  const open = src.indexOf("`", first + anchor.length)
  if (open === -1) {
    throw new Error(
      `[lua-script-sources] no template literal follows the anchor in ${repoRelativeFile}: ` +
        `${JSON.stringify(anchor)}`,
    )
  }
  const close = src.indexOf("`", open + 1)
  if (close === -1) {
    throw new Error(
      `[lua-script-sources] unterminated template literal after the anchor in ` +
        `${repoRelativeFile}: ${JSON.stringify(anchor)}`,
    )
  }

  const script = src.slice(open + 1, close)

  // A Lua script that calls nothing is not a Lua script. This catches an anchor
  // that landed on some neighbouring string literal.
  if (!script.includes("redis.call")) {
    throw new Error(
      `[lua-script-sources] the literal after ${JSON.stringify(anchor)} in ${repoRelativeFile} ` +
        `contains no redis.call — the anchor matched the wrong literal. Got: ` +
        `${JSON.stringify(script.slice(0, 120))}`,
    )
  }
  // Interpolation would mean the running script is not the source text, so the
  // whole premise of reading source is void for that site.
  if (script.includes("${")) {
    throw new Error(
      `[lua-script-sources] the script after ${JSON.stringify(anchor)} in ${repoRelativeFile} ` +
        `INTERPOLATES (\${...}). The source text is not what runs, so it cannot be pinned ` +
        `this way — that site needs a different seam.`,
    )
  }

  return script
}
