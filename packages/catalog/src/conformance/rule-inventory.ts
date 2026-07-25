// The RULE-ID INVENTORY — read out of the compiler's own source (LE2-017).
//
// The conformance suite's standing promise is "no new rejection class lands
// without a fixture". A promise like that is only worth the mechanism behind
// it, and a HAND-MAINTAINED list of rule ids is not a mechanism: it is a
// second place to forget. So the meta-gate does not keep a list — it PARSES
// `src/compiler/` and reads the rule ids the passes can actually emit.
//
// # What it reads, and what it refuses to guess
//
// A diagnostic's rule id reaches its object literal three ways in the four
// passes as written, and the scanner resolves exactly those three plus the
// obvious neighbours:
//
//   rule: "unknown-slot"                     a string literal
//   rule: known ? "a" : "b"                  a conditional over literals
//   rule: danglingRuleFor(d.field)           a local function returning them
//   { pass: PASS, rule, … }                  the `rule` PARAMETER of a local
//                                            diagnostic helper — resolved by
//                                            reading that helper's call sites
//
// Anything else — a rule id built by concatenation, read from an imported
// table, or computed at runtime — makes the scan THROW rather than silently
// return a short list. That is the important half: a meta-gate that quietly
// finds no rules would pass vacuously forever. A pass author who needs a shape
// this scanner cannot read must extend it, and the failure says so by file and
// line.
//
// The same reasoning applies to attribution: a file that builds diagnostics
// but declares no `const PASS = "<pass id>" as const` throws, because there
// would be no way to say WHICH pass owes a fixture for the rule.
//
// # Why a parser and not the type system
//
// Rule ids are `string` on `CatalogDiagnostic` by deliberate design (a union
// would have to be widened by every pass, in a file no pass owns). Nothing in
// the type system can therefore enumerate them, and nothing at runtime can
// either: a pass only emits a rule id when data trips it, which is precisely
// what the fixtures exist to arrange. Reading the source is the only way to
// know what SHOULD have a fixture without asking a human to remember.
//
// Reads files; that is the point. Nothing else here has any IO, and this
// module is test/tooling support — no production path imports it.

import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import ts from "typescript"

/** Where the compiler's sources live, relative to this module. */
const COMPILER_DIR = fileURLToPath(new URL("../compiler/", import.meta.url))

/** Directories inside `src/compiler/` that hold no pass source. */
const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set(["__tests__", "__golden__"])

/** Raised when the compiler's source cannot be read as a rule inventory. */
export class ConformanceScanError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ConformanceScanError"
  }
}

/** One registered pass and every rule id its source can emit. */
export interface PassRuleInventory {
  /** The pass id its source declares (`const PASS = …`). */
  readonly pass: string
  /** The file(s) that declare it, relative to `src/compiler/`. */
  readonly sources: readonly string[]
  /** Every rule id found, sorted. */
  readonly rules: readonly string[]
}

type FunctionLike = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction

interface FileIndex {
  readonly file: string
  readonly root: string
  readonly source: ts.SourceFile
  readonly functions: ReadonlyMap<string, FunctionLike>
  readonly constants: ReadonlyMap<string, ts.Expression>
}

function relativeSource(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join("/")
}

function where(index: FileIndex, node: ts.Node): string {
  const { line, character } = index.source.getLineAndCharacterOfPosition(node.getStart(index.source))
  return `${relativeSource(index.root, index.file)}:${line + 1}:${character + 1}`
}

/** Every `.ts` source under `dir`, recursively, in a deterministic order. */
function listSources(dir: string): readonly string[] {
  const entries = [...readdirSync(dir, { withFileTypes: true })].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  )
  const files: string[] = []
  for (const entry of entries) {
    if (SKIPPED_DIRECTORIES.has(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) files.push(...listSources(full))
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) files.push(full)
  }
  return files
}

function isFunctionLike(node: ts.Node): node is FunctionLike {
  return ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)
}

/** Strip `as`/`satisfies`/parens/`!` so the expression underneath is visible. */
function unwrap(node: ts.Expression): ts.Expression {
  if (
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isParenthesizedExpression(node) ||
    ts.isNonNullExpression(node)
  ) {
    return unwrap(node.expression)
  }
  return node
}

function propertyKey(name: ts.PropertyName): string | undefined {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined
}

function indexFile(root: string, file: string): FileIndex {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.ES2022,
    /* setParentNodes */ true,
  )
  const functions = new Map<string, FunctionLike>()
  const constants = new Map<string, ts.Expression>()
  const walk = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name !== undefined) {
      functions.set(node.name.text, node)
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined) {
      const initializer = unwrap(node.initializer)
      if (isFunctionLike(initializer)) functions.set(node.name.text, initializer)
      else constants.set(node.name.text, node.initializer)
    }
    node.forEachChild(walk)
  }
  source.forEachChild(walk)
  return { file, root, source, functions, constants }
}

/** The pass id a source declares as `const PASS = "<id>" as const`. */
function declaredPassId(index: FileIndex): string | undefined {
  const declared = index.constants.get("PASS")
  if (declared === undefined) return undefined
  const value = unwrap(declared)
  return ts.isStringLiteral(value) ? value.text : undefined
}

/** Every `return` expression of `fn`, ignoring nested functions' returns. */
function returnExpressions(fn: FunctionLike): readonly ts.Expression[] {
  const body = fn.body
  if (body === undefined) return []
  if (!ts.isBlock(body)) return [body]
  const out: ts.Expression[] = []
  const walk = (node: ts.Node): void => {
    if (isFunctionLike(node)) return
    if (ts.isReturnStatement(node) && node.expression !== undefined) out.push(node.expression)
    node.forEachChild(walk)
  }
  body.forEachChild(walk)
  return out
}

/** Resolve one rule-id expression to the literal(s) it can evaluate to. */
function resolveLiterals(
  expression: ts.Expression,
  index: FileIndex,
  seen: Set<ts.Node>,
): readonly string[] {
  const node = unwrap(expression)
  if (seen.has(node)) return []
  seen.add(node)

  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return [node.text]
  }
  if (ts.isConditionalExpression(node)) {
    return [
      ...resolveLiterals(node.whenTrue, index, seen),
      ...resolveLiterals(node.whenFalse, index, seen),
    ]
  }
  if (ts.isIdentifier(node)) {
    const constant = index.constants.get(node.text)
    if (constant !== undefined) return resolveLiterals(constant, index, seen)
  }
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
    const callee = index.functions.get(node.expression.text)
    if (callee !== undefined) {
      return returnExpressions(callee).flatMap((e) => resolveLiterals(e, index, seen))
    }
  }
  throw new ConformanceScanError(
    `${where(index, node)}: a diagnostic's rule id is built with a ` +
      `${ts.SyntaxKind[node.kind]} the conformance scanner cannot statically ` +
      "resolve. The rule inventory is what proves every rejection class has a " +
      "conformance fixture, so it never guesses: either spell the rule id as a " +
      "literal (or a conditional/local function over literals), or teach " +
      "`src/conformance/rule-inventory.ts` the new shape in the same change.",
  )
}

/** A local diagnostic helper that takes the rule id as a parameter. */
interface RuleParameterHelper {
  readonly name: string
  readonly index: number
}

/** Find the named enclosing function whose parameter list contains `rule`. */
function enclosingRuleParameter(node: ts.Node): RuleParameterHelper | undefined {
  for (let current: ts.Node | undefined = node; current !== undefined; current = current.parent) {
    if (!isFunctionLike(current)) continue
    const index = current.parameters.findIndex(
      (p) => ts.isIdentifier(p.name) && p.name.text === "rule",
    )
    if (index < 0) continue
    if (ts.isFunctionDeclaration(current) && current.name !== undefined) {
      return { name: current.name.text, index }
    }
    const parent = current.parent
    if (parent !== undefined && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
      return { name: parent.name.text, index }
    }
    return undefined
  }
  return undefined
}

/** Every expression that reaches a diagnostic's `rule` slot in one file. */
function ruleExpressions(index: FileIndex): readonly ts.Expression[] {
  const expressions: ts.Expression[] = []
  const helpers = new Map<string, number>()

  const collect = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node) && propertyKey(node.name) === "rule") {
      expressions.push(node.initializer)
    }
    if (ts.isShorthandPropertyAssignment(node) && node.name.text === "rule") {
      const helper = enclosingRuleParameter(node)
      if (helper === undefined) {
        throw new ConformanceScanError(
          `${where(index, node)}: a diagnostic takes its rule id from a shorthand ` +
            "`rule` that is not a named local helper's parameter, so the scanner " +
            "cannot find the call sites that supply the actual rule ids. Pass the " +
            "rule id explicitly, or teach `src/conformance/rule-inventory.ts` the " +
            "new shape in the same change.",
        )
      }
      helpers.set(helper.name, helper.index)
    }
    node.forEachChild(collect)
  }
  index.source.forEachChild(collect)

  if (helpers.size > 0) {
    const collectCalls = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const position = helpers.get(node.expression.text)
        if (position !== undefined) {
          const argument = node.arguments[position]
          if (argument === undefined) {
            throw new ConformanceScanError(
              `${where(index, node)}: call to the diagnostic helper ` +
                `"${node.expression.text}" supplies no rule-id argument at position ` +
                `${position}.`,
            )
          }
          expressions.push(argument)
        }
      }
      node.forEachChild(collectCalls)
    }
    index.source.forEachChild(collectCalls)
  }

  return expressions
}

/**
 * Every pass the compiler's source declares, with every rule id it can emit.
 *
 * Throws {@link ConformanceScanError} rather than under-reporting — see the
 * module doc. `directory` defaults to `src/compiler/` and exists so the
 * scanner's own failure modes are testable.
 */
export function scanPassRuleInventory(
  directory: string = COMPILER_DIR,
): readonly PassRuleInventory[] {
  const byPass = new Map<string, { sources: string[]; rules: Set<string> }>()

  for (const file of listSources(directory)) {
    const index = indexFile(directory, file)
    const expressions = ruleExpressions(index)
    const passId = declaredPassId(index)

    if (passId === undefined) {
      if (expressions.length === 0) continue
      throw new ConformanceScanError(
        `${relativeSource(directory, file)}: builds ${expressions.length} diagnostic ` +
          'rule id(s) but declares no `const PASS = "<pass id>" as const`, so the ' +
          "conformance gate cannot attribute the rejection class to a pass. Declare " +
          "the pass id in the file that emits its diagnostics.",
      )
    }

    const entry = byPass.get(passId) ?? { sources: [], rules: new Set<string>() }
    entry.sources.push(relativeSource(directory, file))
    const seen = new Set<ts.Node>()
    for (const expression of expressions) {
      for (const rule of resolveLiterals(expression, index, seen)) entry.rules.add(rule)
    }
    byPass.set(passId, entry)
  }

  return [...byPass.entries()]
    .map(([pass, entry]) => ({
      pass,
      sources: [...entry.sources].sort(),
      rules: [...entry.rules].sort(),
    }))
    .sort((a, b) => (a.pass < b.pass ? -1 : a.pass > b.pass ? 1 : 0))
}

/** Every `<pass>/<rule>` id the compiler can emit, sorted. */
export function scanRuleIds(): readonly string[] {
  return scanPassRuleInventory()
    .flatMap((entry) => entry.rules.map((rule) => `${entry.pass}/${rule}`))
    .sort()
}
