import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { FlatCompat } = require("@eslint/eslintrc");
const js = require("@eslint/js");
const compat = new FlatCompat({
  baseDirectory: import.meta.dirname,
  recommendedConfig: js.configs.recommended,
  allConfig: js.configs.all,
});

// ── Audit-redaction chokepoint (F-53) ────────────────────────────────────────
//
// Spliced in explicitly because the `no-restricted-imports` block below REPLACES
// (never merges) the base config's rule options — without this line the repo-wide
// ban from @ibatexas/eslint-config would be silently dead across packages/tools.
const { AUDIT_RAW_SINK_IMPORT_BAN } = require("@ibatexas/eslint-config/restricted-imports.js");

// ── EGRESS BRAND enforcement (Plan 1 / Theorem E-1) ──────────────────────────
// (c) ban `as RenderedReply` casts; (d) restrict the raw `twilio` SDK import to
// the kernel-gated egress wrapper (twilio/adjudicated.ts). See apps/api config.
const RENDERED_REPLY_CAST_BAN = {
  selector:
    "TSAsExpression > TSTypeReference > Identifier[name='RenderedReply']",
  message:
    "Forging a RenderedReply via `as` is banned (Theorem E-1). Obtain one from a minter in @adjudicate/core; the string is read only via unwrapRendered at egress.",
};

const TWILIO_IMPORT_BAN = {
  name: "twilio",
  message:
    "Raw `twilio` SDK egress is restricted to the kernel-gated wrapper (packages/tools/src/twilio/adjudicated.ts).",
};

// (e) close the raw-HTTP egress vector: ban any reference to the Twilio REST
// host (`api.twilio.com`) — string literal or template — so customer egress
// cannot be smuggled via `fetch` past the SDK-import ban (Theorem E-1
// sole-emitter, not sole-importer).
const TWILIO_REST_HOST_BAN = [
  {
    selector: "Literal[value=/api\\.twilio\\.com/]",
    message:
      "Direct calls to the Twilio REST host (api.twilio.com) are banned outside the kernel-gated egress wrapper (Theorem E-1 sole-emitter).",
  },
  {
    selector: "TemplateElement[value.raw=/api\\.twilio\\.com/]",
    message:
      "Direct calls to the Twilio REST host (api.twilio.com) are banned outside the kernel-gated egress wrapper (Theorem E-1 sole-emitter).",
  },
];

export default [
  ...compat.extends("@ibatexas/eslint-config"),
  {
    files: ["src/**/*.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        RENDERED_REPLY_CAST_BAN,
        ...TWILIO_REST_HOST_BAN,
      ],
      "no-restricted-imports": [
        "error",
        { paths: [TWILIO_IMPORT_BAN, AUDIT_RAW_SINK_IMPORT_BAN] },
      ],
    },
  },
  {
    // The kernel-gated egress wrapper is the only sanctioned `twilio` importer.
    // F-53: re-declared with the audit ban alone rather than "off" — being a
    // sanctioned Twilio importer does not make it a sanctioned audit composer.
    files: ["src/twilio/adjudicated.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        { paths: [AUDIT_RAW_SINK_IMPORT_BAN] },
      ],
    },
  },
];
