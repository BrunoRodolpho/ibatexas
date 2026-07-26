// LE2-030 AC2 — the Twilio delivery-status callback route.
//
// Simulated callbacks only: `twilio.validateRequest` is mocked (so no real HMAC
// is needed) and the delivery store is driven through its injected fake pool.
// No DB, no network.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { __setDeliveryStorePoolForTests } from "../../whatsapp/delivery-store.js";
import {
  whatsappStatusCallbackRoutes,
  WHATSAPP_STATUS_CALLBACK_PATH,
} from "../whatsapp-status-callback.js";

// The route validates through whatsapp-webhook.ts's `verifyTwilioSignature`,
// which calls `twilio.validateRequest` — mocked so no real HMAC is needed.
// (`vi.mock` is hoisted above the imports by vitest's transform.)
const mockValidateRequest = vi.hoisted(() => vi.fn());
vi.mock("twilio", () => ({ default: { validateRequest: mockValidateRequest } }));

const CALLBACK_URL = "https://bot.example.com/api/webhooks/whatsapp/status";

/** In-memory stand-in for the one row per SID, with the rank guard applied. */
const RANK: Record<string, number> = {
  queued: 1,
  accepted: 1,
  scheduled: 1,
  sending: 2,
  sent: 3,
  delivered: 4,
  read: 5,
  canceled: 6,
  undelivered: 6,
  failed: 6,
};

interface Row {
  status: string | null;
  statusAt: string | null;
  errorCode: string | null;
  callbackCount: number;
}

let rows: Map<string, Row>;

async function build(): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(whatsappStatusCallbackRoutes);
  await app.ready();
  return app;
}

/** POST a form-urlencoded callback exactly as Twilio would. */
function post(
  app: FastifyInstance,
  payload: Record<string, string>,
  headers: Record<string, string> = { "x-twilio-signature": "sig" },
) {
  return app.inject({
    method: "POST",
    url: WHATSAPP_STATUS_CALLBACK_PATH,
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    payload: new URLSearchParams(payload).toString(),
  });
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("TWILIO_AUTH_TOKEN", "test_auth_token");
  vi.stubEnv("TWILIO_STATUS_CALLBACK_URL", CALLBACK_URL);
  mockValidateRequest.mockReturnValue(true);
  rows = new Map([["SM_known", { status: null, statusAt: null, errorCode: null, callbackCount: 0 }]]);

  __setDeliveryStorePoolForTests({
    async query(sql: string, params: ReadonlyArray<unknown> = []) {
      if (!sql.includes("UPDATE whatsapp_delivery")) return { rowCount: 0, rows: [] };
      const sid = params[0] as string;
      const incomingRank = params[1] as number;
      const status = params[2] as string;
      const at = params[3] as string;
      const errorCode = params[4] as string | null;
      const row = rows.get(sid);
      if (row === undefined) return { rowCount: 0, rows: [] };
      row.callbackCount += 1;
      if (incomingRank > (row.status === null ? 0 : (RANK[row.status] ?? 0))) {
        row.status = status;
        row.statusAt = at;
        row.errorCode = errorCode;
      }
      return { rowCount: 1, rows: [{ status: row.status }] };
    },
  });
});

afterEach(() => {
  __setDeliveryStorePoolForTests(null);
  vi.unstubAllEnvs();
});

// ── signature validation (the SAME rule the inbound webhook applies) ─────────

describe("status callback — signature validation", () => {
  it("400s a callback with no X-Twilio-Signature header", async () => {
    const app = await build();
    const res = await post(app, { MessageSid: "SM_known", MessageStatus: "delivered" }, {});
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "Missing signature" });
    await app.close();
  });

  it("403s a callback whose signature does not verify", async () => {
    mockValidateRequest.mockReturnValue(false);
    const app = await build();
    const res = await post(app, { MessageSid: "SM_known", MessageStatus: "delivered" });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "Invalid signature" });
    // Rejected before any store write.
    expect(rows.get("SM_known")!.callbackCount).toBe(0);
    await app.close();
  });

  it("500s when TWILIO_STATUS_CALLBACK_URL is not configured", async () => {
    vi.stubEnv("TWILIO_STATUS_CALLBACK_URL", "");
    const app = await build();
    const res = await post(app, { MessageSid: "SM_known", MessageStatus: "delivered" });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: "Webhook not configured" });
    await app.close();
  });

  it("verifies against the STATUS callback URL, not the inbound webhook URL", async () => {
    vi.stubEnv("TWILIO_WEBHOOK_URL", "https://bot.example.com/api/webhooks/whatsapp");
    const app = await build();
    await post(app, { MessageSid: "SM_known", MessageStatus: "delivered" });
    expect(mockValidateRequest).toHaveBeenCalledWith(
      "test_auth_token",
      "sig",
      CALLBACK_URL,
      expect.objectContaining({ MessageSid: "SM_known", MessageStatus: "delivered" }),
    );
    await app.close();
  });
});

// ── correlation + persistence ────────────────────────────────────────────────

describe("status callback — correlate by SID and record the transition", () => {
  it("records `delivered` against the SID's row and answers 200", async () => {
    const app = await build();
    const res = await post(app, { MessageSid: "SM_known", MessageStatus: "delivered" });

    expect(res.statusCode).toBe(200);
    expect(rows.get("SM_known")).toMatchObject({ status: "delivered", callbackCount: 1 });
    await app.close();
  });

  it("records a failure with its Twilio error code", async () => {
    const app = await build();
    const res = await post(app, {
      MessageSid: "SM_known",
      MessageStatus: "failed",
      ErrorCode: "63016",
      ErrorMessage: "Failed to send freeform message",
    });

    expect(res.statusCode).toBe(200);
    expect(rows.get("SM_known")).toMatchObject({ status: "failed", errorCode: "63016" });
    await app.close();
  });

  it("accepts the legacy SmsStatus alias", async () => {
    const app = await build();
    await post(app, { MessageSid: "SM_known", SmsStatus: "delivered" });
    expect(rows.get("SM_known")!.status).toBe("delivered");
    await app.close();
  });

  it("keeps the terminal status when `sent` arrives after `delivered` (out of order)", async () => {
    const app = await build();
    await post(app, { MessageSid: "SM_known", MessageStatus: "delivered" });
    const res = await post(app, { MessageSid: "SM_known", MessageStatus: "sent" });

    expect(res.statusCode).toBe(200); // still accepted — just not applied
    expect(rows.get("SM_known")).toMatchObject({ status: "delivered", callbackCount: 2 });
    await app.close();
  });

  it("is a logged no-op (still 200) for an unknown SID", async () => {
    const app = await build();
    const res = await post(app, { MessageSid: "SM_never_sent", MessageStatus: "delivered" });

    expect(res.statusCode).toBe(200);
    expect(rows.has("SM_never_sent")).toBe(false);
    // The known row is untouched — no cross-contamination.
    expect(rows.get("SM_known")!.callbackCount).toBe(0);
    await app.close();
  });

  it("still answers 200 when the delivery store is unreachable (no Twilio retry storm)", async () => {
    __setDeliveryStorePoolForTests({
      async query() {
        throw new Error("connection refused");
      },
    });
    const app = await build();
    const res = await post(app, { MessageSid: "SM_known", MessageStatus: "delivered" });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});

// ── malformed payloads ───────────────────────────────────────────────────────

describe("status callback — malformed payloads", () => {
  it("400s a callback with no MessageSid", async () => {
    const app = await build();
    const res = await post(app, { MessageStatus: "delivered" });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("400s a callback carrying a status outside Twilio's vocabulary", async () => {
    const app = await build();
    const res = await post(app, { MessageSid: "SM_known", MessageStatus: "teleported" });
    expect(res.statusCode).toBe(400);
    expect(rows.get("SM_known")!.callbackCount).toBe(0);
    await app.close();
  });
});
