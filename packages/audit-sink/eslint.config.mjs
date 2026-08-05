import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { FlatCompat } = require("@eslint/eslintrc");
const js = require("@eslint/js");
const compat = new FlatCompat({
  baseDirectory: import.meta.dirname,
  recommendedConfig: js.configs.recommended,
  allConfig: js.configs.all,
});
// ── Audit-redaction chokepoint (F-53) — the authorised-composer allowlist ────
//
// The base config bans the raw @adjudicate/audit sink primitives everywhere.
// This package OWNS the redacted pipeline, so exactly one file inside it is
// allowed to import them: the composer that builds
//   redactor -> persistentBufferedSink -> multiSink(console, nats, postgres)
// and hands the result out through `getAuditSink()`.
//
// The list is hand-written, NOT derived from which files happen to import the
// primitives today — deriving it from the source it checks would let the
// allowlist grow silently to cover any new bypass. Adding a file here must be a
// deliberate edit with a reviewer, because it IS the act of authorising a new
// unredacted-emit path.
//
// Deliberately minimal: `intent-audit-wiring.ts` is NOT listed. It composes
// dependencies but imports only `createInMemorySpillStorage`, which cannot emit
// and is therefore unrestricted. If composition ever moves back into that file
// it should fail lint and force this list to be updated on purpose.
const AUDIT_COMPOSER_ALLOWLIST = ["src/index.ts"];

export default [
  ...compat.extends("@ibatexas/eslint-config"),
  {
    files: AUDIT_COMPOSER_ALLOWLIST,
    rules: {
      "no-restricted-imports": "off",
    },
  },
];
