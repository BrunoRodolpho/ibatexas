import { createRequire } from "module";
import coreWebVitals from "eslint-config-next/core-web-vitals";

// ── Audit-redaction chokepoint (F-53) ────────────────────────────────────────
//
// apps/admin builds on eslint-config-next rather than @ibatexas/eslint-config,
// so it never inherited the repo-wide ban on the raw @adjudicate/audit sink
// primitives. Spliced in directly to keep the invariant's reach uniform. The
// admin app does not depend on @adjudicate/audit today, so this is forward
// cover: a future emit path fails lint as it is written, not at review.
// `scripts/check-audit-sink-import-ban.mjs` is what noticed this workspace was
// uncovered, and fails if it ever silently becomes so again.
const require = createRequire(import.meta.url);
const { AUDIT_RAW_SINK_IMPORT_BAN } = require("@ibatexas/eslint-config/restricted-imports.js");

export default [
  ...coreWebVitals,
  {
    rules: {
      "no-restricted-imports": ["error", { paths: [AUDIT_RAW_SINK_IMPORT_BAN] }],
    },
  },
];
