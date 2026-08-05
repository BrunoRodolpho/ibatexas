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
// build a value-shape resolver mapper for a non-essential field. Tracked
// as FE-D27 (carved): the `{type, notes}` mapper for structured special-
// request capture, PLUS a date/time-NL-fields grounding path as an
// alternative to the same-turn check_availability requirement below, and
// reservation.modify's own slot-change equivalent.
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
    "ID do horário — um id já retornado por uma leitura anterior nesta conversa " +
    "(check_availability), NUNCA inventado ou digitado pelo cliente. " +
    "Como ALTERNATIVA, deixe de fora e informe `date` (e `time`): o sistema " +
    "encontra o horário disponível para essa data.",
};

const PARTY_SIZE_JSON_SCHEMA = {
  type: "number" as const,
  description: "Número de pessoas (1 a 20).",
};

// FE-D27 — the NL date/time ALTERNATIVE to a check_availability-grounded timeSlotId,
// so a pure-chat "mesa pra 4 sexta às 20h" can book without a prior availability read.
// `date` mirrors CHECK_AVAILABILITY_READ_SCHEMA's own ISO field (the precedent that
// the 4B emits YYYY-MM-DD); the resolver (resolve-and-assemble.ts) grounds date+time
// → a REAL timeSlotId via the SAME `checkAvailability` lookup check_availability uses.
// F-65 — UNLIKE `example` below, a field `description` IS copied onto the wire
// by `toPayloadJsonSchema`, so this string is live prompt text. That makes the
// date here two things at once: a format illustration the model reads, and — via
// `toolSurface` — a DIGESTED component of the L1 parse-cache key
// (`buildParseCacheKey`, parse-memo.ts).
//
// If this date is ever MEASURED to anchor the model's output year, the fix is to
// remove its ANCHORING ROLE — symbolic spec only, or a placeholder whose
// concreteness is not load-bearing — NOT to derive it from the turn clock. That
// distinction is the whole ruling: de-anchoring costs ONE digest rotation at
// deploy, a trade this program takes deliberately; a render-time value rotates
// the digest EVERY DAY, collapsing the 7-day `PARSE_CACHE_TTL_SECONDS` to under
// one. The format is already stated symbolically ("YYYY-MM-DD"), so the literal
// is reinforcement rather than the carrier — which is what makes de-anchoring
// cheap here.
const RESERVATION_DATE_JSON_SCHEMA = {
  type: "string" as const,
  description:
    "Data desejada da reserva no formato YYYY-MM-DD (ex.: \"2026-03-15\"), quando o " +
    "cliente disser a data em vez de escolher um horário já listado. " +
    "Omita se um timeSlotId já foi escolhido.",
};
const RESERVATION_TIME_JSON_SCHEMA = {
  type: "string" as const,
  description:
    "Horário desejado no formato HH:MM (ex.: \"20:00\"), se o cliente mencionar. " +
    "Omita se não houver horário específico.",
};

export const RESERVATION_CREATE_EXTRACTION_SCHEMA: CapabilityExtractionSchema =
  {
    capability: "reservation.create",
    fields: [
      {
        // FE-D27 — now OPTIONAL: the customer either picks a listed slot
        // (timeSlotId, State) OR states the date/time (date+time, Directive)
        // and the resolver grounds it to a real timeSlotId.
        name: "timeSlotId",
        trustClass: "state",
        jsonSchema: TIME_SLOT_ID_LOOKUP_KEY_JSON_SCHEMA,
        required: false,
      },
      {
        name: "partySize",
        trustClass: "directive",
        jsonSchema: PARTY_SIZE_JSON_SCHEMA,
        required: true,
      },
      {
        name: "date",
        trustClass: "directive",
        jsonSchema: RESERVATION_DATE_JSON_SCHEMA,
        required: false,
      },
      {
        name: "time",
        trustClass: "directive",
        jsonSchema: RESERVATION_TIME_JSON_SCHEMA,
        required: false,
      },
    ],
    // F-65 — the year here is ILLUSTRATIVE, not an anchor: `example` is
    // author-facing and never reaches the model (see ExtractionSchemaExample).
    // Its staleness is therefore inert; leave it alone.
    example: {
      utterance: "quero uma mesa pra 4 pessoas dia 20/03 às 20h",
      payload: { date: "2026-03-20", time: "20:00", partySize: 4 },
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
      {
        // FE-D27 — the NL alternative to newTimeSlotId for a slot change: state the
        // new date/time and the resolver grounds it to a real newTimeSlotId.
        name: "newDate",
        trustClass: "directive",
        // F-65 — live wire text and a digested parse-cache key component, same
        // as RESERVATION_DATE_JSON_SCHEMA above — de-anchor if ever measured to
        // bias the output year; never derive from the turn clock.
        jsonSchema: {
          type: "string",
          description:
            "Nova data no formato YYYY-MM-DD (ex.: \"2026-03-15\"), quando o cliente " +
            "quiser mudar o dia sem escolher um horário já listado. " +
            "Omita se não mudar o horário ou se um newTimeSlotId já foi escolhido.",
        },
        required: false,
      },
      {
        name: "newTime",
        trustClass: "directive",
        jsonSchema: {
          type: "string",
          description:
            "Novo horário no formato HH:MM (ex.: \"20:00\"), se o cliente mencionar. " +
            "Omita se não houver horário específico.",
        },
        required: false,
      },
    ],
    // F-65 — illustrative year, never on the wire (see ExtractionSchemaExample).
    example: {
      utterance: "muda minha reserva pra sexta, dia 20/03, às 20h",
      payload: { newDate: "2026-03-20", newTime: "20:00" },
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
        // FE-D27 — OPTIONAL (mirrors reservation.create): a listed slot (timeSlotId)
        // OR the stated date/time, grounded to a real timeSlotId by the resolver.
        name: "timeSlotId",
        trustClass: "state",
        jsonSchema: TIME_SLOT_ID_LOOKUP_KEY_JSON_SCHEMA,
        required: false,
      },
      {
        name: "partySize",
        trustClass: "directive",
        jsonSchema: PARTY_SIZE_JSON_SCHEMA,
        required: true,
      },
      {
        name: "date",
        trustClass: "directive",
        jsonSchema: RESERVATION_DATE_JSON_SCHEMA,
        required: false,
      },
      {
        name: "time",
        trustClass: "directive",
        jsonSchema: RESERVATION_TIME_JSON_SCHEMA,
        required: false,
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
