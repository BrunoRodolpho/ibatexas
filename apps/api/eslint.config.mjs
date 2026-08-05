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
// The base config (@ibatexas/eslint-config) bans the raw @adjudicate/audit sink
// primitives repo-wide. ESLint REPLACES rule options rather than merging them,
// so the `no-restricted-imports` block below would silently drop that ban for
// all of apps/api — measured: with the ban only in the base config, a probe
// importing `multiSink` here linted CLEAN while the identical probe in
// packages/journeys errored. Splice it in explicitly; anything added to this
// file's `paths` must keep it.
const { AUDIT_RAW_SINK_IMPORT_BAN } = require("@ibatexas/eslint-config/restricted-imports.js");

// ── EGRESS BRAND enforcement (Plan 1 / Theorem E-1) ──────────────────────────
//
// Defense-in-depth for the runtime-non-forgeable `RenderedReply`:
//   (c) ban `as RenderedReply` (and `as any/unknown as RenderedReply`) — a cast
//       is the only compile-time way to synthesize a brand without a minter; the
//       module-private symbol blocks object literals, so the cast is the gap.
//   (d) restrict the raw `twilio` SDK import to the customer-egress chokepoint
//       (whatsapp/client.ts) plus the inbound/OTP surfaces that legitimately use
//       Twilio for NON-egress (webhook signature validation, Verify OTP). Every
//       other module must go through a minter + the kernel-gated wrapper.
const RENDERED_REPLY_CAST_BAN = {
  selector:
    "TSAsExpression > TSTypeReference > Identifier[name='RenderedReply']",
  message:
    "Forging a RenderedReply via `as` is banned (Theorem E-1). Obtain one from a minter in @adjudicate/core (mint*/wrapLegacyResponderText); the string is read only via unwrapRendered at egress.",
};

const TWILIO_IMPORT_BAN = {
  name: "twilio",
  message:
    "Raw `twilio` SDK egress is restricted to the branded chokepoint (apps/api/src/whatsapp/client.ts). Send customer text via sendText(...) with a RenderedReply minted in @adjudicate/core.",
};

// (e) close the raw-HTTP egress vector: a direct call to the Twilio REST host
// (`https://api.twilio.com/...`) bypasses the SDK-import ban entirely (Theorem E
// is sole-emitter, not sole-importer). Ban any reference to the host — string
// literal or template — so customer egress cannot be smuggled via `fetch`.
const TWILIO_REST_HOST_BAN = [
  {
    selector: "Literal[value=/api\\.twilio\\.com/]",
    message:
      "Direct calls to the Twilio REST host (api.twilio.com) are banned outside the kernel-gated egress chokepoint (Theorem E-1 sole-emitter). Send customer text via sendText(...) with a minted RenderedReply.",
  },
  {
    selector: "TemplateElement[value.raw=/api\\.twilio\\.com/]",
    message:
      "Direct calls to the Twilio REST host (api.twilio.com) are banned outside the kernel-gated egress chokepoint (Theorem E-1 sole-emitter).",
  },
];

// Files allowed to import the raw `twilio` SDK: the egress chokepoint plus the
// inbound-validation / Verify-OTP surfaces (non-message-egress uses).
const TWILIO_ALLOWED = [
  "src/whatsapp/client.ts",
  "src/routes/whatsapp-webhook.ts",
  "src/routes/auth.ts",
  "src/routes/me/anonymize-otp-gate.ts",
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
    // Egress chokepoint + Twilio inbound/OTP surfaces may import the SDK; the
    // RenderedReply cast ban + REST-host ban still apply to them (they use the
    // SDK, never a raw api.twilio.com fetch).
    //
    // F-53: this override re-declares the rule with the audit ban ALONE rather
    // than switching it "off". Turning the rule off would have exempted these
    // four files from the audit-sink ban too — they are sanctioned Twilio
    // importers, not sanctioned audit composers.
    files: TWILIO_ALLOWED,
    rules: {
      "no-restricted-imports": [
        "error",
        { paths: [AUDIT_RAW_SINK_IMPORT_BAN] },
      ],
    },
  },
];
