// reservation-convenience.schema.ts — FE-T14 (rollout: convenience mutating
// verbs). The pack-reservations family: reservation.create,
// reservation.modify, reservation.cancel, reservation.waitlist.join.
//
// ── specialRequests is DELIBERATELY EXCLUDED from every schema below ──────
// `ReservationCreatePayload`/`ReservationModifyPayload` (pack-reservations/
// src/types.ts) declare `specialRequests?: ReadonlyArray<string>`, but the
// REAL executors (packages/tools/src/reservation/create-reservation.ts /
// modify-reservation.ts) thread through the RICHER `SpecialRequest[]` shape
// (`{type: "birthday"|"anniversary"|...|"other", notes?: string}[]`) via an
// explicit unsafe cast — see those files' own comments: "Pack payload
// declares specialRequests: ReadonlyArray<string> but the service-layer
// executor uses the rich SpecialRequest[] shape... We pass the
// SpecialRequest[] through as-is so the structured entries reach Prisma."
// A model-facing schema exposing a flat string array (this rollout slice's
// only array-field idiom, extraction-schema.ts's `type:"array"`) would
// silently mismatch that richer shape and corrupt what actually reaches
// Prisma — not merely a narrower model surface, a DATA-INTEGRITY hazard.
// specialRequests is optional and non-core to either capability (a
// reservation is fully functional without it), so this rollout slice
// scopes it OUT entirely (CRITICAL DESIGN RULE 4: "optional over
// required... absence must flow to existing honest paths") rather than
// build a value-shape resolver mapper for a non-essential field. A future
// ticket that wants structured special-request capture from chat should
// design that mapper deliberately, not inherit it from this scoping
// decision.
//
// ── reservation.create ────────────────────────────────────────────────────
// Wire payload is `{timeSlotId, partySize, specialRequests?}`. `timeSlotId`
// is NOT on FORBIDDEN_EXTRACTION_FIELD_NAMES (it names a PUBLIC availability
// slot, not an owner-scoped resource — no authorization decision is ever
// gated on trusting it) but is genuinely never something the customer TYPES
// — it is an id already returned by an earlier `check_availability` read
// this same conversation (read-tool-schemas.ts's own precedent:
// `get_also_added`'s `productId`, "a lookup key... consumed ONLY as a
// lookup key, never typed by the customer"). Classified State, not
// Directive, for exactly that reason. `partySize` mirrors
// CHECK_AVAILABILITY_READ_SCHEMA's own field verbatim (same wire shape,
// same "1 to 20" range prose).
//
// ── reservation.modify ────────────────────────────────────────────────────
// Wire payload is `{reservationId, newTimeSlotId?, newPartySize?,
// specialRequests?}`. `reservationId` is Identity-class (forbidden) — the
// model sees ONLY `{newTimeSlotId?, newPartySize?}`, both optional (a
// customer might change just the time, just the party size, or both).
// FE-T14 adds `reservation.modify` to RESERVATION_AUTORESOLVE_KINDS /
// AUTORESOLVE_CONFIRM_KINDS (resolve-and-assemble.ts /
// compose-policy-packs.ts) — mirroring reservation.cancel's EXISTING
// treatment exactly: auto-resolve to the customer's one active reservation
// when unambiguous, forcing a confirm (a guess, never a silent apply).
// Before this change, `reservation.modify` had NO reachable reservationId
// at all from chat (RESERVATION_AUTORESOLVE_KINDS previously listed only
// reservation.cancel) — a live, customer-facing gap this ticket closes.
//
// ── reservation.cancel ───────────────────────────────────────────────────
// Wire payload is `{reservationId, reason?}`. Already fully wired for
// auto-resolve BEFORE this ticket — no resolver change needed. The model
// sees ONLY `{reason?}`, free text.
//
// ── reservation.waitlist.join ────────────────────────────────────────────
// Wire payload is `{timeSlotId, partySize}` — a NEW resource (joining a
// waitlist), no existing target to resolve, same `timeSlotId`/`partySize`
// shape as reservation.create.

import {
  type CapabilityExtractionSchema,
  assertSoundExtractionSchema,
} from "./extraction-schema.js";

const TIME_SLOT_ID_LOOKUP_KEY_JSON_SCHEMA = {
  type: "string" as const,
  description:
    "ID do horário — SEMPRE um id já retornado por uma leitura anterior " +
    "nesta conversa (check_availability), NUNCA inventado ou digitado pelo cliente.",
};

const PARTY_SIZE_JSON_SCHEMA = {
  type: "number" as const,
  description: "Número de pessoas (1 a 20).",
};

export const RESERVATION_CREATE_EXTRACTION_SCHEMA: CapabilityExtractionSchema =
  {
    capability: "reservation.create",
    fields: [
      {
        name: "timeSlotId",
        trustClass: "state",
        jsonSchema: TIME_SLOT_ID_LOOKUP_KEY_JSON_SCHEMA,
        required: true,
      },
      {
        name: "partySize",
        trustClass: "directive",
        jsonSchema: PARTY_SIZE_JSON_SCHEMA,
        required: true,
      },
    ],
    example: {
      utterance: "quero reservar aquele horário que vocês acharam, pra 4 pessoas",
      payload: { timeSlotId: "slot_123", partySize: 4 },
    },
  };

export const RESERVATION_MODIFY_EXTRACTION_SCHEMA: CapabilityExtractionSchema =
  {
    capability: "reservation.modify",
    fields: [
      {
        name: "newTimeSlotId",
        trustClass: "state",
        jsonSchema: {
          type: "string",
          description:
            "ID do novo horário — SEMPRE um id já retornado por uma leitura " +
            "anterior nesta conversa (check_availability). Omita se o " +
            "cliente não quiser mudar o horário.",
        },
        required: false,
      },
      {
        name: "newPartySize",
        trustClass: "directive",
        jsonSchema: {
          type: "number",
          description:
            "Novo número de pessoas (1 a 20). Omita se o cliente não quiser " +
            "mudar a quantidade de pessoas.",
        },
        required: false,
      },
    ],
    example: {
      utterance: "muda minha reserva pra 6 pessoas",
      payload: { newPartySize: 6 },
    },
  };

export const RESERVATION_CANCEL_EXTRACTION_SCHEMA: CapabilityExtractionSchema =
  {
    capability: "reservation.cancel",
    fields: [
      {
        name: "reason",
        trustClass: "directive",
        jsonSchema: {
          type: "string",
          description:
            "Motivo do cancelamento, se mencionado. Omita se não houver motivo explícito.",
        },
        required: false,
      },
    ],
    example: {
      utterance: "cancela minha reserva, surgiu um imprevisto",
      payload: { reason: "surgiu um imprevisto" },
    },
  };

export const RESERVATION_WAITLIST_JOIN_EXTRACTION_SCHEMA: CapabilityExtractionSchema =
  {
    capability: "reservation.waitlist.join",
    fields: [
      {
        name: "timeSlotId",
        trustClass: "state",
        jsonSchema: TIME_SLOT_ID_LOOKUP_KEY_JSON_SCHEMA,
        required: true,
      },
      {
        name: "partySize",
        trustClass: "directive",
        jsonSchema: PARTY_SIZE_JSON_SCHEMA,
        required: true,
      },
    ],
    example: {
      utterance: "coloca eu na lista de espera daquele horário, somos 4",
      payload: { timeSlotId: "slot_123", partySize: 4 },
    },
  };

// Fail closed at import time — a schema that would leak reservationId (or
// any other identifier / PII field) can never even be loaded onto the wire.
assertSoundExtractionSchema(RESERVATION_CREATE_EXTRACTION_SCHEMA);
assertSoundExtractionSchema(RESERVATION_MODIFY_EXTRACTION_SCHEMA);
assertSoundExtractionSchema(RESERVATION_CANCEL_EXTRACTION_SCHEMA);
assertSoundExtractionSchema(RESERVATION_WAITLIST_JOIN_EXTRACTION_SCHEMA);
