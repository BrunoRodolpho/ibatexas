/**
 * Policy-manifest export — produces the `PolicyManifest` that drives the
 * adjudicate operator console's rule-provenance tree for the ibatexas adopter.
 *
 * It describes the EXACT post-prepend per-pack bundles the kernel runs (via
 * `buildIbatexasPolicyPacks` — the same composition `claustrum-bootstrap` feeds
 * to `composePolicyRouter`), so the manifest cannot drift from production. It
 * deliberately does NOT describe `composePolicyRouter`'s output: the router
 * collapses each phase to one delegating closure, which would render as a
 * single anonymous guard per phase.
 *
 * Pure (no I/O): callers supply already-resolved source-file paths; the CLI
 * (`ibx policy export`) owns path resolution + writing the artifact.
 *
 * Requires `@adjudicate/analyze >= 0.4.0` (the `describeInstalledPacks` surface).
 */

import {
  describeInstalledPacks,
  loadSourceFiles,
  type PolicyManifest,
} from "@adjudicate/analyze";
import { ordersPack, ORDER_TOOL_TO_INTENT } from "@ibatexas/pack-orders";
import { paymentsPack, PAYMENT_TOOL_TO_INTENT } from "@ibatexas/pack-payments";
import {
  reservationsPack,
  RESERVATION_TOOL_TO_INTENT,
} from "@ibatexas/pack-reservations";
import {
  customerOnboardingPack,
  CUSTOMER_ONBOARDING_TOOL_TO_INTENT,
} from "@ibatexas/pack-customer-onboarding";
import { whatsappPack, WHATSAPP_TOOL_TO_INTENT } from "@ibatexas/pack-whatsapp";
import { readGuardMetadata } from "@adjudicate/core/kernel";
import {
  buildIbatexasPolicyPacks,
  IBATEXAS_ADOPTER_AUTH_GUARDS,
  IBATEXAS_ADOPTER_BUSINESS_GUARDS,
  type ErasedPack,
} from "./compose-policy-packs.js";

/**
 * Every adopter-level guard prepended to every pack (by stable name):
 * the AUTH-phase agent scope + per-agent budget guards (T3-4) and the
 * business-phase F4 token-budget + confirm-on-autoresolve guards. Derived
 * from the live composed arrays so a new adopter guard (e.g. a new agent in
 * AGENT_REGISTRY) can never silently drift out of the manifest annotation.
 */
const ADOPTER_INJECTED_GUARD_NAMES = [
  ...IBATEXAS_ADOPTER_AUTH_GUARDS,
  ...IBATEXAS_ADOPTER_BUSINESS_GUARDS,
].map((g) => readGuardMetadata(g)?.name ?? g.name);

/** Tool→intent map for each pack, keyed by `pack.id`. */
const TOOL_MAPS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  [ordersPack.id]: ORDER_TOOL_TO_INTENT,
  [paymentsPack.id]: PAYMENT_TOOL_TO_INTENT,
  [reservationsPack.id]: RESERVATION_TOOL_TO_INTENT,
  [customerOnboardingPack.id]: CUSTOMER_ONBOARDING_TOOL_TO_INTENT,
  [whatsappPack.id]: WHATSAPP_TOOL_TO_INTENT,
};

export interface ManifestExportOptions {
  /** Wall clock for the `generatedAt` field — EXCLUDED from the digest. */
  readonly generatedAt?: string;
  /** Optional `@adjudicate/core` version string recorded in the manifest. */
  readonly kernelVersion?: string;
  /**
   * Absolute paths to each pack's guard source files, keyed by `pack.id`.
   * When supplied, the manifest carries `sourceLocation` per guard (path:line).
   * Omit for a structure-only manifest (e.g. when only `dist` is available).
   */
  readonly packSourceFiles?: Readonly<Record<string, ReadonlyArray<string>>>;
  /**
   * Workspace root — when set, guard `sourceLocation.file` paths are stored
   * relative to it so the committed manifest is portable (no machine paths).
   */
  readonly sourceRoot?: string;
}

/**
 * Build the ibatexas policy manifest from the live first-party packs + the
 * adopter-level guard composition.
 */
export function buildIbatexasPolicyManifest(
  opts: ManifestExportOptions = {},
): PolicyManifest {
  const realPacks = [
    ordersPack,
    paymentsPack,
    reservationsPack,
    customerOnboardingPack,
    whatsappPack,
  ] as unknown as ReadonlyArray<ErasedPack>;

  const packs = buildIbatexasPolicyPacks(
    realPacks,
    IBATEXAS_ADOPTER_BUSINESS_GUARDS,
  );

  const perPackOptions: Record<
    string,
    {
      toolToIntent?: Readonly<Record<string, string>>;
      adopterInjectedGuardNames?: ReadonlyArray<string>;
      sourceFiles?: ReadonlyArray<unknown>;
    }
  > = {};

  for (const pack of packs) {
    const srcPaths = opts.packSourceFiles?.[pack.id];
    perPackOptions[pack.id] = {
      toolToIntent: TOOL_MAPS[pack.id],
      adopterInjectedGuardNames: ADOPTER_INJECTED_GUARD_NAMES,
      ...(srcPaths !== undefined && srcPaths.length > 0
        ? { sourceFiles: loadSourceFiles(srcPaths) }
        : {}),
      ...(opts.sourceRoot === undefined ? {} : { sourceRoot: opts.sourceRoot }),
    };
  }

  return describeInstalledPacks(packs, {
    adopter: "ibatexas",
    ...(opts.kernelVersion === undefined
      ? {}
      : { kernelVersion: opts.kernelVersion }),
    ...(opts.generatedAt === undefined ? {} : { generatedAt: opts.generatedAt }),
    perPackOptions,
  });
}
