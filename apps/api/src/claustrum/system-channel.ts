// SystemChannel — the non-conversational `"system"` ChannelDriver (T3-1).
//
// Adopter-side adapter for channel kind `"system"` (widened upstream in
// claustrum core 0.3.0, T3-0): the ingress for runtime-internal trigger
// turns — a domain event (e.g. `payment.status_changed`) normalized into a
// `ChannelMessage` so a server-resident managed agent can run the SAME
// kernel-gated cognitive loop as a chat turn. There is no human on the other
// end of this channel:
//
//   - `perceive()` turns a typed {@link TriggerEvent} into an inbound
//     `ChannelMessage` whose `externalId` is `` `${sourceSubject}:${eventId}` ``
//     — THE per-turn deterministic-nonce carrier. `CognitiveState` has no ctx
//     field and `workingMemory` is a plain string, so `perception.externalId`
//     is the only structured channel from a trigger into the planner seam;
//     T3-2's `deriveNonce` reads exactly this value (plan v2 §5, ledger #2).
//   - `render()` JOURNALS (structured log via an injectable sink) — it never
//     delivers anything outbound. The agent acts on the world via kernel-
//     adjudicated tools, not chat replies; the synthesized response text is
//     an operator-facing trace artifact only.
//   - `matchToParked()` is `null` unconditionally: a trigger event carries no
//     "yes/no/tomorrow" resumption convention. Parked-confirmation resolution
//     for agent envelopes arrives via the approvals glue (T3-7), not via this
//     channel.
//   - `attest()` HMAC-signs the envelope with a DEDICATED system-gateway key
//     (same HMAC-SHA256-over-canonical-bytes pattern as the web/WhatsApp
//     channels; per-gateway keys keep one channel's compromise from forging
//     another's envelopes). The actor is enriched with
//     `channel: "system"` + the gateway id before signing.
//
// Perception text (recorded design choice): a deterministic, compact, LABELED
// English rendering of the trigger — one `label: value` line per field with
// the payload as canonical (key-sorted) JSON via the kernel's `canonicalJson`.
// English is deliberate: the text is SYSTEM-internal planner input, never
// user-facing (CLAUDE.md rule #4 pt-BR applies to user-facing text only).
// Determinism is load-bearing twice over: (a) the scripted-provider content
// key in tests pins the template byte-for-byte, and (b) a re-delivered event
// produces a byte-identical perception, so planner prompts (and any prompt-
// keyed caching) are stable across redeliveries.
//
// NOT wired into the production conductor here — T3-6 owns the shadow
// composition (dedicated sandbox ToolRegistry, agent-namespace audit rows).
// This module ships the driver + unit tests only.

import { createHmac } from "node:crypto";
import { canonicalJson, type IntentEnvelope } from "@adjudicate/core";
import {
  resolveGatewaySigningKey,
  type ChannelDriver,
  type ChannelKind,
  type ChannelMessage,
  type GatewaySigningKey,
  type ParkedMatch,
  type RenderedResponse,
  type Session,
  type SignedEnvelope,
} from "@claustrum/core";
import { logger } from "../lib/logger.js";

// ── Trigger event (the raw payload `perceive()` accepts) ─────────────────────

/**
 * The entity a trigger event is about. `customerId` is REQUIRED: the
 * Conductor loads/saves sessions and recalls memory by `(customerId,
 * channel)`, so a trigger with no customer association cannot open a
 * routable capsule on this channel.
 */
export interface TriggerEntityRef {
  /** Entity type, e.g. `"order"`, `"payment"`, `"reservation"`. */
  readonly kind: string;
  /** Entity id, e.g. the order id the failed PIX charge belongs to. */
  readonly id: string;
  /** The customer the agent acts on behalf of (session/memory key). */
  readonly customerId: string;
}

/**
 * A typed trigger event — the system channel's "vendor webhook". Produced by
 * the trigger bridge (T3-2: BullMQ worker over NATS deliveries); consumed by
 * `SystemChannel.perceive()`.
 */
export interface TriggerEvent {
  /**
   * Full source subject of the originating event, e.g.
   * `"ibatexas.payment.status_changed"`. First half of the `externalId`
   * nonce carrier.
   */
  readonly sourceSubject: string;
  /**
   * Stable per-event identifier (broker/event id). Second half of the
   * `externalId` nonce carrier — a redelivery MUST present the same id.
   */
  readonly eventId: string;
  /** Domain event kind, short form — e.g. `"payment.status_changed"`. */
  readonly kind: string;
  /** Event payload, rendered canonically into the perception text. */
  readonly payload: Readonly<Record<string, unknown>>;
  /** The entity (and customer) this trigger is about. */
  readonly entityRef: TriggerEntityRef;
  /** ISO-8601 time the source event occurred. Used as `receivedAt` when set. */
  readonly occurredAt?: string;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Structural guard for {@link TriggerEvent}. Everything checked here is
 * NON-recoverable for this channel (port rejection contract): the subject +
 * event id form the deterministic nonce carrier, and the entity's customerId
 * is the session/memory routing key — silently defaulting any of them would
 * corrupt replay dedup or open a capsule for the wrong (or no) customer.
 */
export function isTriggerEvent(raw: unknown): raw is TriggerEvent {
  if (!isPlainObject(raw)) return false;
  const candidate = raw as Partial<TriggerEvent>;
  return (
    isNonEmptyString(candidate.sourceSubject) &&
    isNonEmptyString(candidate.eventId) &&
    isNonEmptyString(candidate.kind) &&
    isPlainObject(candidate.payload) &&
    isPlainObject(candidate.entityRef) &&
    isNonEmptyString(candidate.entityRef.kind) &&
    isNonEmptyString(candidate.entityRef.id) &&
    isNonEmptyString(candidate.entityRef.customerId) &&
    (candidate.occurredAt === undefined || isNonEmptyString(candidate.occurredAt))
  );
}

// ── Deterministic derivations (exported so T3-2 reuses, never re-derives) ────

/**
 * `` `${sourceSubject}:${eventId}` `` — the per-turn deterministic-nonce
 * carrier. Lands on `ChannelMessage.externalId` → `perception.externalId`,
 * the only structured channel from a trigger into the planner seam.
 */
export function triggerExternalId(event: TriggerEvent): string {
  return `${event.sourceSubject}:${event.eventId}`;
}

/**
 * Deterministic conversation id, scoped to (event kind, entity) — NOT to the
 * event id: successive triggers about the same entity thread into one
 * conversation, which is what session-level memory should accumulate over.
 */
export function triggerConversationId(event: TriggerEvent): string {
  return `trigger:${event.kind}:${event.entityRef.kind}:${event.entityRef.id}`;
}

/**
 * Deterministic, compact system rendering of the trigger — the perception
 * text the agent planner reads (see the module header for the recorded
 * design choice). Fixed line order; payload as canonical key-sorted JSON;
 * `occurred-at` line present only when the event carries it.
 */
export function renderTriggerPerceptionText(event: TriggerEvent): string {
  const lines = [
    `system trigger: ${event.kind}`,
    `subject: ${event.sourceSubject}`,
    `event-id: ${event.eventId}`,
    `entity: ${event.entityRef.kind} ${event.entityRef.id}`,
    `customer: ${event.entityRef.customerId}`,
    ...(event.occurredAt !== undefined
      ? [`occurred-at: ${event.occurredAt}`]
      : []),
    `payload: ${canonicalJson(event.payload)}`,
  ];
  return lines.join("\n");
}

// ── Render journal ───────────────────────────────────────────────────────────

/** Structured journal entry `render()` emits instead of delivering outbound. */
export interface SystemRenderJournalEntry {
  readonly event: "system_channel.render";
  readonly gateway: string;
  readonly channel: ChannelKind;
  readonly customerId: string;
  readonly conversationId: string;
  /** The synthesized turn text — operator-facing trace, never delivered. */
  readonly text: string;
  readonly meta?: RenderedResponse["meta"];
}

// ── Config + driver ──────────────────────────────────────────────────────────

export interface SystemChannelConfig {
  /**
   * HMAC-SHA256 signing key for `attest()`. MUST be a key dedicated to the
   * system gateway (never share the web/WhatsApp gateway keys) so a
   * compromise of one channel cannot forge envelopes for another.
   */
  readonly gatewaySigningKey: GatewaySigningKey;
  /** Gateway identifier written to `actor.gateway`, e.g. `"ibatexas-agent-host"`. */
  readonly gateway: string;
  /** Key id embedded in the SignedEnvelope. Default `"system-gateway-default"`. */
  readonly gatewayKeyId?: string;
  /**
   * Journal sink for `render()`. Default: the api pino logger at info level.
   * The agent-host composition (T3-6) may inject a sink that ALSO forwards to
   * the structured events emitter / `agent_runs` journal — this single seam
   * is where that wiring lands.
   */
  readonly journal?: (entry: SystemRenderJournalEntry) => void;
}

export class SystemChannel implements ChannelDriver {
  readonly kind: ChannelKind = "system";

  constructor(private readonly config: SystemChannelConfig) {
    // Resolve to validate: catches a missing key and a `{current:""}` provider.
    try {
      resolveGatewaySigningKey(config.gatewaySigningKey);
    } catch {
      throw new Error("SystemChannel: gatewaySigningKey required");
    }
    if (!isNonEmptyString(config.gateway)) {
      throw new Error("SystemChannel: gateway required");
    }
  }

  /**
   * Normalize a {@link TriggerEvent} into an inbound `ChannelMessage`.
   * Throws on a structurally-invalid trigger (port rejection contract —
   * see {@link isTriggerEvent} for why every checked field is essential).
   */
  async perceive(raw: unknown): Promise<ChannelMessage> {
    if (!isTriggerEvent(raw)) {
      throw new Error(
        "SystemChannel.perceive: raw is not a TriggerEvent " +
          "(requires non-empty sourceSubject, eventId, kind, object payload, " +
          "and entityRef {kind, id, customerId})",
      );
    }
    return {
      channel: "system",
      customerId: raw.entityRef.customerId,
      conversationId: triggerConversationId(raw),
      externalId: triggerExternalId(raw),
      text: renderTriggerPerceptionText(raw),
      receivedAt: raw.occurredAt ?? new Date().toISOString(),
      raw,
    };
  }

  /**
   * Journal the rendered response — NO outbound delivery. The agent's
   * side effects flow exclusively through kernel-adjudicated tools; the
   * synthesized text is trace material for operators and the run journal.
   */
  async render(response: RenderedResponse): Promise<void> {
    const entry: SystemRenderJournalEntry = {
      event: "system_channel.render",
      gateway: this.config.gateway,
      channel: response.channel,
      customerId: response.customerId,
      conversationId: response.conversationId,
      text: response.text,
      ...(response.meta !== undefined ? { meta: response.meta } : {}),
    };
    const journal = this.config.journal;
    if (journal !== undefined) {
      journal(entry);
      return;
    }
    logger.info(
      { component: "system-channel", ...entry },
      "system channel render journaled (no outbound delivery)",
    );
  }

  /**
   * Enrich the actor with `channel: "system"` + the gateway id, then
   * HMAC-SHA256 the canonical bytes of the enriched envelope — the same
   * attestation pattern as the web/WhatsApp channels, under a dedicated
   * key. Verification goes through `verifyGatewayAttestation` (rotation-
   * aware: current OR previous key accepted).
   */
  async attest(envelope: IntentEnvelope): Promise<SignedEnvelope> {
    // Sign with the CURRENT key; throws on an empty/missing key.
    const currentKey = resolveGatewaySigningKey(this.config.gatewaySigningKey);
    if (!envelope || typeof envelope !== "object") {
      throw new Error("SystemChannel.attest: envelope must be an object");
    }

    // Audit metadata only — enrichment must NOT alter the replay key
    // (intentHash is preserved from construction time).
    const enrichedActor = {
      ...envelope.actor,
      channel: "system" as const,
      gateway: this.config.gateway,
    };
    const enriched: IntentEnvelope = {
      ...envelope,
      actor: enrichedActor as typeof envelope.actor,
    };

    const canonical = canonicalJson(enriched);
    const signature = createHmac("sha256", currentKey)
      .update(canonical, "utf8")
      .digest("hex");

    return {
      envelope: enriched,
      signature,
      keyId: this.config.gatewayKeyId ?? "system-gateway-default",
      alg: "HMAC-SHA256",
    };
  }

  /**
   * The system channel has no parked-reply semantics: a trigger event is
   * never a "yes/no/tomorrow" reply to a parked confirmation. Returns `null`
   * unconditionally so every trigger runs the normal cognitive loop;
   * agent-envelope confirmations resolve through the approvals glue (T3-7).
   */
  matchToParked(_channelEvent: ChannelMessage, _session: Session): ParkedMatch | null {
    void _channelEvent;
    void _session;
    return null;
  }
}
