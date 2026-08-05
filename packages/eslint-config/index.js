const { AUDIT_RAW_SINK_IMPORT_BAN } = require("./restricted-imports.js");

module.exports = {
  parser: "@typescript-eslint/parser",
  plugins: ["@typescript-eslint", "import"],
  extends: ["eslint:recommended", "plugin:@typescript-eslint/recommended"],
  rules: {
    /* ── Audit-redaction chokepoint (F-53) ──────────────────────────────── */
    /* Repo-wide: only the audit composer may import raw sink primitives.   */
    /* Workspaces that override no-restricted-imports must re-splice this — */
    /* see packages/eslint-config/restricted-imports.js.                    */
    "no-restricted-imports": ["error", { paths: [AUDIT_RAW_SINK_IMPORT_BAN] }],
    "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    "@typescript-eslint/no-explicit-any": "error",
    "import/order": ["warn", { groups: ["builtin", "external", "internal", "parent", "sibling", "index"], "newlines-between": "never" }],
    "no-console": ["warn", { allow: ["warn", "error"] }],
    "prefer-const": "error",
    "no-var": "error",
    /* ── UI Design System enforcement ──────────────────────────────── */
    /* Ban raw smoke-300/400 text colors — use semantic tokens instead */
    "no-restricted-syntax": ["warn",
      {
        selector: "Literal[value=/text-smoke-3(?:00|50)/]",
        message: "Use semantic token (tw.text.muted or tw.text.secondary from @ibatexas/ui/theme) instead of text-smoke-300/350",
      },
      {
        selector: "Literal[value=/text-smoke-400/]",
        message: "Use semantic token (tw.text.muted or tw.text.disabled from @ibatexas/ui/theme) instead of text-smoke-400",
      },
    ],
  },
  ignorePatterns: ["dist/", "coverage/", "*.config.*", "*.d.ts"],
};
