// BKL-033 wiring guard — the production conductor's "web" driver MUST be a
// WebConfirmChannel (with a real matchToParked), never the bare WebChannel
// (whose matchToParked returns null, dead-ending customer confirm-resume). A
// silent revert to WebChannel would re-break ~a dozen MODIFY/cancel flows; this
// test fails closed on that regression.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildChannelDrivers } from "../../claustrum-bootstrap.js";
import { WebConfirmChannel } from "../web-confirm-channel.js";

const SAVED = process.env.WEB_GATEWAY_SIGNING_KEY;

beforeEach(() => {
  // buildChannelDrivers requires a web signing key (fails closed otherwise);
  // TWILIO_* is left unset so the WhatsApp driver is skipped (not under test).
  process.env.WEB_GATEWAY_SIGNING_KEY = "test-web-gateway-signing-key-0123456789";
});

afterEach(() => {
  if (SAVED === undefined) delete process.env.WEB_GATEWAY_SIGNING_KEY;
  else process.env.WEB_GATEWAY_SIGNING_KEY = SAVED;
});

describe("BKL-033 — the production web driver is a WebConfirmChannel", () => {
  it("the channel set includes exactly one 'web' driver and it is a WebConfirmChannel", () => {
    const drivers = buildChannelDrivers();
    const web = drivers.filter((d) => d.kind === "web");
    expect(web).toHaveLength(1);
    expect(web[0]).toBeInstanceOf(WebConfirmChannel);
  });
});
