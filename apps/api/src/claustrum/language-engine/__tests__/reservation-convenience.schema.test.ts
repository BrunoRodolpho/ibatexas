// reservation-convenience.schema.test.ts — FE-T14: the pack-reservations
// extraction schemas pass the authoring-contract lint and expose ONLY the
// model-extractable fields — never reservationId, and never specialRequests
// (data-integrity hazard — see reservation-convenience.schema.ts's header).

import { describe, expect, it } from "vitest";
import {
  assertSoundExtractionSchema,
  extractionFieldNames,
  toPayloadJsonSchema,
} from "../extraction-schema.js";
import {
  RESERVATION_CREATE_EXTRACTION_SCHEMA,
  RESERVATION_MODIFY_EXTRACTION_SCHEMA,
  RESERVATION_CANCEL_EXTRACTION_SCHEMA,
  RESERVATION_WAITLIST_JOIN_EXTRACTION_SCHEMA,
} from "../reservation-convenience.schema.js";

describe("RESERVATION_CREATE_EXTRACTION_SCHEMA", () => {
  it("passes the authoring-contract lint", () => {
    expect(() => assertSoundExtractionSchema(RESERVATION_CREATE_EXTRACTION_SCHEMA)).not.toThrow();
  });

  it("exposes ONLY {timeSlotId, partySize}, both required — no reservationId, no specialRequests", () => {
    const names = extractionFieldNames(RESERVATION_CREATE_EXTRACTION_SCHEMA);
    expect([...names].sort()).toEqual(["partySize", "timeSlotId"]);
    expect(names.has("reservationId")).toBe(false);
    expect(names.has("specialRequests")).toBe(false);
    const wire = toPayloadJsonSchema(RESERVATION_CREATE_EXTRACTION_SCHEMA);
    expect(wire.required).toEqual(["timeSlotId", "partySize"]);
  });

  it("timeSlotId is State class (a lookup key), partySize is Directive", () => {
    const byName = new Map(RESERVATION_CREATE_EXTRACTION_SCHEMA.fields.map((f) => [f.name, f]));
    expect(byName.get("timeSlotId")?.trustClass).toBe("state");
    expect(byName.get("partySize")?.trustClass).toBe("directive");
  });
});

describe("RESERVATION_MODIFY_EXTRACTION_SCHEMA", () => {
  it("passes the authoring-contract lint", () => {
    expect(() => assertSoundExtractionSchema(RESERVATION_MODIFY_EXTRACTION_SCHEMA)).not.toThrow();
  });

  it("exposes ONLY {newTimeSlotId, newPartySize}, BOTH optional — no reservationId, no specialRequests", () => {
    const names = extractionFieldNames(RESERVATION_MODIFY_EXTRACTION_SCHEMA);
    expect([...names].sort()).toEqual(["newPartySize", "newTimeSlotId"]);
    expect(names.has("reservationId")).toBe(false);
    expect(names.has("specialRequests")).toBe(false);
    const wire = toPayloadJsonSchema(RESERVATION_MODIFY_EXTRACTION_SCHEMA);
    expect(wire.required).toBeUndefined();
  });
});

describe("RESERVATION_CANCEL_EXTRACTION_SCHEMA", () => {
  it("passes the authoring-contract lint", () => {
    expect(() => assertSoundExtractionSchema(RESERVATION_CANCEL_EXTRACTION_SCHEMA)).not.toThrow();
  });

  it("exposes ONLY {reason}, optional — no reservationId", () => {
    const names = extractionFieldNames(RESERVATION_CANCEL_EXTRACTION_SCHEMA);
    expect([...names]).toEqual(["reason"]);
    expect(names.has("reservationId")).toBe(false);
  });
});

describe("RESERVATION_WAITLIST_JOIN_EXTRACTION_SCHEMA", () => {
  it("passes the authoring-contract lint", () => {
    expect(() => assertSoundExtractionSchema(RESERVATION_WAITLIST_JOIN_EXTRACTION_SCHEMA)).not.toThrow();
  });

  it("exposes ONLY {timeSlotId, partySize}, both required", () => {
    const names = extractionFieldNames(RESERVATION_WAITLIST_JOIN_EXTRACTION_SCHEMA);
    expect([...names].sort()).toEqual(["partySize", "timeSlotId"]);
    const wire = toPayloadJsonSchema(RESERVATION_WAITLIST_JOIN_EXTRACTION_SCHEMA);
    expect(wire.required).toEqual(["timeSlotId", "partySize"]);
  });
});
