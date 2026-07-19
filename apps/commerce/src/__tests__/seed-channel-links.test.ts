// BKL-193 — unit tests for the seed's store-visibility helpers:
// ensurePublishableKeyForChannel (publishable key exists + EXACT-set channel
// binding) and ensureProductChannelLinks (heal missing product→channel links).
// Pure DI fakes — no vi.mock, no network (CLAUDE.md test rules).

import { describe, expect, it, vi } from "vitest";
import { Modules } from "@medusajs/framework/utils";
import {
  ensurePublishableKeyForChannel,
  ensureProductChannelLinks,
} from "../seed";

const CHANNEL = "sc_loja";

function fakeQuery(rows: unknown[]) {
  return { graph: vi.fn().mockResolvedValue({ data: rows }) } as never;
}

function fakeRemoteLink() {
  return {
    create: vi.fn().mockResolvedValue([]),
    dismiss: vi.fn().mockResolvedValue([]),
  };
}

function fakeApiKeyModule(keys: Array<{ id: string; revoked_at?: string | null }>) {
  return {
    listApiKeys: vi.fn().mockResolvedValue(keys),
    createApiKeys: vi
      .fn()
      .mockResolvedValue([{ id: "apk_created", title: "Default Publishable API Key" }]),
  } as never;
}

describe("ensurePublishableKeyForChannel (BKL-193)", () => {
  it("creates a key when none exists, then links the seed channel", async () => {
    const apiKeys = fakeApiKeyModule([]);
    const remoteLink = fakeRemoteLink();
    const out = await ensurePublishableKeyForChannel(
      apiKeys,
      fakeQuery([{ id: "apk_created", sales_channels: [] }]),
      remoteLink,
      CHANNEL,
    );
    expect(out).toEqual({ keyCreated: true, added: true, dismissed: 0 });
    expect(remoteLink.create).toHaveBeenCalledWith([
      {
        [Modules.API_KEY]: { publishable_key_id: "apk_created" },
        [Modules.SALES_CHANNEL]: { sales_channel_id: CHANNEL },
      },
    ]);
    expect(remoteLink.dismiss).not.toHaveBeenCalled();
  });

  it("EXACT-set: dismisses a stale channel link and adds the seed channel", async () => {
    const remoteLink = fakeRemoteLink();
    const out = await ensurePublishableKeyForChannel(
      fakeApiKeyModule([{ id: "apk_1", revoked_at: null }]),
      fakeQuery([{ id: "apk_1", sales_channels: [{ id: "sc_default" }] }]),
      remoteLink,
      CHANNEL,
    );
    expect(out).toEqual({ keyCreated: false, added: true, dismissed: 1 });
    expect(remoteLink.dismiss).toHaveBeenCalledWith([
      {
        [Modules.API_KEY]: { publishable_key_id: "apk_1" },
        [Modules.SALES_CHANNEL]: { sales_channel_id: "sc_default" },
      },
    ]);
  });

  it("idempotent no-op when the key is already exactly the seed channel", async () => {
    const remoteLink = fakeRemoteLink();
    const out = await ensurePublishableKeyForChannel(
      fakeApiKeyModule([{ id: "apk_1", revoked_at: null }]),
      fakeQuery([{ id: "apk_1", sales_channels: [{ id: CHANNEL }] }]),
      remoteLink,
      CHANNEL,
    );
    expect(out).toEqual({ keyCreated: false, added: false, dismissed: 0 });
    expect(remoteLink.create).not.toHaveBeenCalled();
    expect(remoteLink.dismiss).not.toHaveBeenCalled();
  });

  it("skips revoked keys (creates a fresh one)", async () => {
    const apiKeys = fakeApiKeyModule([{ id: "apk_dead", revoked_at: "2026-01-01" }]);
    const out = await ensurePublishableKeyForChannel(
      apiKeys,
      fakeQuery([{ id: "apk_created", sales_channels: [] }]),
      fakeRemoteLink(),
      CHANNEL,
    );
    expect(out.keyCreated).toBe(true);
  });
});

describe("ensureProductChannelLinks (BKL-193)", () => {
  it("links ONLY the products missing the seed channel (check-before-create)", async () => {
    const remoteLink = fakeRemoteLink();
    const created = await ensureProductChannelLinks(
      fakeQuery([
        { id: "prod_linked", sales_channels: [{ id: CHANNEL }] },
        { id: "prod_missing", sales_channels: [] },
        { id: "prod_other", sales_channels: [{ id: "sc_default" }] },
      ]),
      remoteLink,
      CHANNEL,
      ["prod_linked", "prod_missing", "prod_other"],
    );
    expect(created).toBe(2);
    expect(remoteLink.create).toHaveBeenCalledWith([
      {
        [Modules.PRODUCT]: { product_id: "prod_missing" },
        [Modules.SALES_CHANNEL]: { sales_channel_id: CHANNEL },
      },
      {
        [Modules.PRODUCT]: { product_id: "prod_other" },
        [Modules.SALES_CHANNEL]: { sales_channel_id: CHANNEL },
      },
    ]);
  });

  it("all linked → zero creates (idempotent)", async () => {
    const remoteLink = fakeRemoteLink();
    const created = await ensureProductChannelLinks(
      fakeQuery([{ id: "p1", sales_channels: [{ id: CHANNEL }] }]),
      remoteLink,
      CHANNEL,
      ["p1"],
    );
    expect(created).toBe(0);
    expect(remoteLink.create).not.toHaveBeenCalled();
  });

  it("empty id list → no graph query at all", async () => {
    const query = fakeQuery([]);
    const created = await ensureProductChannelLinks(query, fakeRemoteLink(), CHANNEL, []);
    expect(created).toBe(0);
    expect((query as { graph: ReturnType<typeof vi.fn> }).graph).not.toHaveBeenCalled();
  });
});
