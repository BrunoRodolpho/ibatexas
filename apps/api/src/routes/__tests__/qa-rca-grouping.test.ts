// LE2-031 — pins for the RCA rail's customer grouping (qa-rca-grouping.ts).
//
// The rail's hard-won properties all reduce to ONE invariant here: a group's
// identity is a pure function of the row's own identity fields, never of order,
// position or neighbours. Deep links (#rca/conv/<sessionId>) address SESSIONS,
// which grouping does not rename; the live 5s tick re-fetches the same rows and
// must produce byte-identical group keys and ordering, or the investigator's
// expanded groups would collapse under them.
//
// Pure module — no pg, no fetch, no clock.

import { describe, it, expect } from "vitest";
import {
  groupConversationsByCustomer,
  resolveGroupIdentity,
  UNIDENTIFIED_GROUP_KEY,
  type GroupableConversation,
} from "../qa-rca-grouping.js";

const T = (s: string): string => `2026-07-2${s}T10:00:00.000Z`;

function conv(over: Partial<GroupableConversation> = {}): GroupableConversation {
  return {
    sessionId: "sess-1",
    channel: "whatsapp",
    startedAt: T("1"),
    lastAt: T("1"),
    turnCount: 1,
    customerId: null,
    phoneHash: null,
    ...over,
  };
}

// ── the identity ladder ──────────────────────────────────────────────────────

describe("resolveGroupIdentity — the ladder", () => {
  it("keys a customer by customer_id, across sessions AND channels", () => {
    const web = resolveGroupIdentity(conv({ sessionId: "s-a", channel: "web", customerId: "cus_1" }));
    const wa = resolveGroupIdentity(conv({ sessionId: "s-b", channel: "whatsapp", customerId: "cus_1" }));
    expect(web.groupKey).toBe("customer:cus_1");
    expect(wa.groupKey).toBe(web.groupKey);
    expect(web.kind).toBe("customer");
  });

  it("falls back to the salted phone hash for a guest with no customer row", () => {
    const id = resolveGroupIdentity(conv({ customerId: null, phoneHash: "ph_abc" }));
    expect(id.groupKey).toBe("phone:ph_abc");
    expect(id.kind).toBe("customer");
    expect(id.customerId).toBeNull();
    expect(id.phoneHash).toBe("ph_abc");
  });

  it("prefers the customer id over the phone hash when both exist", () => {
    const id = resolveGroupIdentity(conv({ customerId: "cus_1", phoneHash: "ph_abc" }));
    expect(id.groupKey).toBe("customer:cus_1");
    // The hash still rides along — it is the same human, and the rail shows it.
    expect(id.phoneHash).toBe("ph_abc");
  });

  it("labels an ops thread distinctly and NEVER folds it into a customer", () => {
    const id = resolveGroupIdentity(
      // Even if a customer id somehow rode along, the admin: prefix wins: the
      // ops plane has no domain conversation row and is not a customer thread.
      conv({ sessionId: "admin:staff_7", channel: "ops", customerId: "cus_1", phoneHash: "ph_abc" }),
    );
    expect(id.kind).toBe("ops");
    expect(id.groupKey).toBe("ops:staff_7");
    expect(id.staffId).toBe("staff_7");
    expect(id.label).toContain("ops");
    expect(id.customerId).toBeNull();
    expect(id.phoneHash).toBeNull();
  });

  it("keeps a malformed bare 'admin:' as an ops group rather than inventing a staff id", () => {
    const id = resolveGroupIdentity(conv({ sessionId: "admin:" }));
    expect(id.kind).toBe("ops");
    expect(id.staffId).toBeNull();
  });

  it("routes an unattributable session to the explicit bucket — never a silent drop", () => {
    const id = resolveGroupIdentity(conv({ customerId: null, phoneHash: null }));
    expect(id.groupKey).toBe(UNIDENTIFIED_GROUP_KEY);
    expect(id.kind).toBe("unidentified");
  });

  it("treats empty-string identity columns as absent (never keys on '')", () => {
    expect(resolveGroupIdentity(conv({ customerId: "", phoneHash: "" })).groupKey).toBe(
      UNIDENTIFIED_GROUP_KEY,
    );
  });
});

// ── folding + aggregation ────────────────────────────────────────────────────

describe("groupConversationsByCustomer — folding", () => {
  it("folds a customer's sessions into one row with summed turns and a spanning window", () => {
    const groups = groupConversationsByCustomer([
      conv({ sessionId: "s-mon", customerId: "cus_1", startedAt: T("1"), lastAt: T("1"), turnCount: 3 }),
      conv({
        sessionId: "s-fri",
        customerId: "cus_1",
        channel: "web",
        startedAt: T("5"),
        lastAt: T("5"),
        turnCount: 4,
      }),
    ]);
    expect(groups).toHaveLength(1);
    const g = groups[0]!;
    expect(g.groupKey).toBe("customer:cus_1");
    expect(g.sessionCount).toBe(2);
    expect(g.turnCount).toBe(7);
    expect(g.startedAt).toBe(T("1"));
    expect(g.lastAt).toBe(T("5"));
    expect(g.channels).toEqual(["web", "whatsapp"]);
    // Sessions are the rail's sub-rows — most recent first.
    expect(g.sessionIds).toEqual(["s-fri", "s-mon"]);
  });

  it("carries a phone hash that only SOME of a customer's sessions had", () => {
    const [g] = groupConversationsByCustomer([
      conv({ sessionId: "s-web", customerId: "cus_1", channel: "web", phoneHash: null }),
      conv({ sessionId: "s-wa", customerId: "cus_1", phoneHash: "ph_abc" }),
    ]);
    expect(g!.customerId).toBe("cus_1");
    expect(g!.phoneHash).toBe("ph_abc");
  });

  it("collects every unattributable session in ONE explicit bucket — none lost", () => {
    const groups = groupConversationsByCustomer([
      conv({ sessionId: "s-1" }),
      conv({ sessionId: "s-2" }),
      conv({ sessionId: "s-3", customerId: "cus_1" }),
    ]);
    const bucket = groups.find((g) => g.groupKey === UNIDENTIFIED_GROUP_KEY)!;
    expect(bucket.kind).toBe("unidentified");
    expect(bucket.sessionIds).toEqual(["s-1", "s-2"]);
    // Conservation: every input session appears in exactly one group.
    expect(groups.flatMap((g) => g.sessionIds).sort()).toEqual(["s-1", "s-2", "s-3"]);
  });

  it("keeps ops threads in their own per-staff groups beside the customers", () => {
    // The ops plane keys its whole thread as `admin:<staffId>`, so one staff is
    // one session — the fold is a no-op there and the LABEL is the point.
    const groups = groupConversationsByCustomer([
      conv({ sessionId: "admin:staff_7", channel: "ops", lastAt: T("3") }),
      conv({ sessionId: "admin:staff_9", channel: "ops", lastAt: T("1") }),
      conv({ sessionId: "s-cust", customerId: "cus_1", lastAt: T("4") }),
    ]);
    expect(groups.map((g) => g.groupKey)).toEqual(["customer:cus_1", "ops:staff_7", "ops:staff_9"]);
    expect(groups.filter((g) => g.kind === "ops")).toHaveLength(2);
  });

  it("returns [] for no conversations", () => {
    expect(groupConversationsByCustomer([])).toEqual([]);
  });
});

// ── ordering + stability across refreshes ────────────────────────────────────

describe("groupConversationsByCustomer — ordering + stability", () => {
  const page: GroupableConversation[] = [
    conv({ sessionId: "s-a", customerId: "cus_1", lastAt: T("1") }),
    conv({ sessionId: "s-b", customerId: "cus_2", lastAt: T("5") }),
    conv({ sessionId: "s-c", lastAt: T("3") }),
    conv({ sessionId: "admin:staff_7", channel: "ops", lastAt: T("4") }),
    conv({ sessionId: "s-d", customerId: "cus_1", lastAt: T("2") }),
  ];

  it("orders groups by most-recent activity first", () => {
    expect(groupConversationsByCustomer(page).map((g) => g.groupKey)).toEqual([
      "customer:cus_2",
      "ops:staff_7",
      UNIDENTIFIED_GROUP_KEY,
      "customer:cus_1",
    ]);
  });

  it("is order-independent: the same rows in any order give the SAME keys and order", () => {
    const forward = groupConversationsByCustomer(page);
    const reversed = groupConversationsByCustomer([...page].reverse());
    const rotated = groupConversationsByCustomer([...page.slice(2), ...page.slice(0, 2)]);
    expect(reversed).toEqual(forward);
    expect(rotated).toEqual(forward);
  });

  it("keeps group identity stable when a live refresh adds a turn / a new session", () => {
    const before = groupConversationsByCustomer(page);
    // The 5s tick: cus_1 sent another message (new turn on s-d) and a brand-new
    // session appeared. Existing group keys must not move.
    const after = groupConversationsByCustomer([
      ...page.map((c) => (c.sessionId === "s-d" ? { ...c, turnCount: c.turnCount + 1, lastAt: T("6") } : c)),
      conv({ sessionId: "s-new", customerId: "cus_3", lastAt: T("7") }),
    ]);
    for (const key of before.map((g) => g.groupKey)) {
      expect(after.map((g) => g.groupKey)).toContain(key);
    }
    // …and the sessions the rail addresses by deep link are unchanged.
    expect(after.find((g) => g.groupKey === "customer:cus_1")!.sessionIds.sort()).toEqual(["s-a", "s-d"]);
  });

  it("breaks ties deterministically (equal timestamps never shuffle)", () => {
    const tied: GroupableConversation[] = [
      conv({ sessionId: "s-z", customerId: "cus_z", lastAt: T("1") }),
      conv({ sessionId: "s-a", customerId: "cus_a", lastAt: T("1") }),
    ];
    expect(groupConversationsByCustomer(tied).map((g) => g.groupKey)).toEqual([
      "customer:cus_a",
      "customer:cus_z",
    ]);
    expect(groupConversationsByCustomer([...tied].reverse()).map((g) => g.groupKey)).toEqual([
      "customer:cus_a",
      "customer:cus_z",
    ]);
  });

  it("sinks groups with no usable timestamp to the end instead of the top", () => {
    const groups = groupConversationsByCustomer([
      conv({ sessionId: "s-null", customerId: "cus_null", startedAt: null, lastAt: null }),
      conv({ sessionId: "s-ok", customerId: "cus_ok", lastAt: T("1") }),
    ]);
    expect(groups.map((g) => g.groupKey)).toEqual(["customer:cus_ok", "customer:cus_null"]);
  });
});
