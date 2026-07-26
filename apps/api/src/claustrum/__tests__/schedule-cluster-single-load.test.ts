// BKL-234 — the STRUCTURAL PREMISE behind SCHEDULE_CLUSTER_COMPATIBLE.
//
// Declaring {STORE_OPEN_NOW, STORE_HOURS, STORE_HOURS_FOR_DATE} pairwise COMPATIBLE
// relieves those pairs of §O#1 default-deny. That is only SOUND because the members
// cannot contradict each other, and the reason they cannot is mechanical, not
// empirical: `createDomainTriadReadBackend` loads the restaurant schedule through a
// single-flight per-turn memo (`scheduleP ??= loadSchedule()`), and EVERY cluster
// member plus every falsifier is a pure projection of that ONE loaded object.
//
// The premise is load-bearing and NON-OBVIOUS, because the two claims have DIFFERENT
// declared freshness policies:
//   · STORE_OPEN_NOW — `must_read_this_turn`
//   · STORE_HOURS    — `{ kind: "cacheable", ttl: 3_600_000 }`  ← 1 HOUR
// Read naively, that pairing is exactly the dangerous "one cached, one live" case: a
// stale hours string co-rendered with a fresh open-now signal could disagree. It
// cannot TODAY, for two reasons this suite pins:
//   1. the backend instance (and therefore the memo) is constructed INSIDE the
//      per-turn gatherer, so it never caches across turns; and
//   2. within a turn both values project from the same load, so the cacheable TTL is
//      vacuous — the entry is always written by THIS turn's read.
//
// If a future change ever gave the schedule reads independent loads, or let a backend
// or ledger outlive a turn, the cacheable TTL would become live and the COMPATIBLE
// declaration would no longer be justified. This suite is what makes that a RED TEST
// rather than a silent soundness regression, so the declaration stays structural.

import { describe, expect, it, vi } from "vitest";
import type { RestaurantSchedule } from "@ibatexas/types";

const { loadCalls, schedule } = vi.hoisted(() => ({
  loadCalls: { count: 0 },
  schedule: {
    value: undefined as unknown,
  },
}));

// Mock ONLY the schedule loader; every projection helper stays REAL, so this suite
// proves the wiring rather than a restatement of it.
vi.mock("@ibatexas/tools", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ibatexas/tools")>();
  return {
    ...actual,
    loadSchedule: async () => {
      loadCalls.count += 1;
      return schedule.value;
    },
    // The Redis/Medusa handles must never be touched by a schedule-only read.
    getRedisClient: () => {
      throw new Error("getRedisClient must not run in this suite");
    },
  };
});

const { createDomainTriadReadBackend } = await import("../turn-reads.js");

/** A real weekly schedule: open for lunch + dinner every day, no exceptions. */
function makeSchedule(): RestaurantSchedule {
  return {
    days: Array.from({ length: 7 }, (_, dayOfWeek) => ({
      dayOfWeek,
      isOpen: true,
      lunchStart: "11:00",
      lunchEnd: "15:00",
      dinnerStart: "18:00",
      dinnerEnd: "23:00",
    })),
    holidays: [],
    overrides: [],
  };
}

/** The SAME schedule with a window that would CONTRADICT `makeSchedule()`'s hours. */
function makeContradictingSchedule(): RestaurantSchedule {
  return {
    days: Array.from({ length: 7 }, (_, dayOfWeek) => ({
      dayOfWeek,
      isOpen: true,
      lunchStart: "05:00",
      lunchEnd: "06:00",
      dinnerStart: null,
      dinnerEnd: null,
    })),
    holidays: [],
    overrides: [],
  };
}

describe("BKL-234 — every schedule-cluster read projects ONE per-turn load", () => {
  it("reads the schedule EXACTLY ONCE across all cluster members and falsifiers", async () => {
    loadCalls.count = 0;
    schedule.value = makeSchedule();
    const backend = createDomainTriadReadBackend();

    // Everything the schedule cluster and its falsifiers need, in one turn.
    const [signal, hours, hoursForDate, holiday, override, holidayForDate, overrideForDate] =
      await Promise.all([
        backend.readSchedule(),
        backend.readStoreHours(),
        backend.readHoursForDate("2026-08-02"),
        backend.readHoliday(),
        backend.readScheduleOverride(),
        backend.readHolidayForDate("2026-08-02"),
        backend.readScheduleOverrideForDate("2026-08-02"),
      ]);

    // THE PREMISE: one load backs every member ⇒ they cannot observe different
    // schedule states ⇒ no two cluster members can contradict ⇒ COMPATIBLE is sound.
    expect(loadCalls.count).toBe(1);

    // Non-vacuity: the reads actually produced the values the claims bind to.
    expect(signal).toBeDefined();
    expect(hours.hoursText).toContain("11h");
    expect(hoursForDate.hoursText).toContain("11h");
    // No exceptions in this schedule ⇒ every falsifier is ABSENT (does not fire).
    expect(holiday).toBeNull();
    expect(override).toBeNull();
    expect(holidayForDate).toBeNull();
    expect(overrideForDate).toBeNull();
  });

  it("the memo is PER-BACKEND, so it cannot leak across turns", async () => {
    loadCalls.count = 0;
    schedule.value = makeSchedule();

    // Turn 1.
    const first = createDomainTriadReadBackend();
    await Promise.all([first.readSchedule(), first.readStoreHours()]);
    expect(loadCalls.count).toBe(1);

    // Turn 2 — a NEW backend instance (what createIbatexasInvestigator builds per
    // turn) must re-read. A shared/process-wide memo would leave this at 1, which is
    // the state in which STORE_HOURS's 1h cacheable TTL would stop being vacuous.
    const second = createDomainTriadReadBackend();
    await Promise.all([second.readSchedule(), second.readStoreHours()]);
    expect(loadCalls.count).toBe(2);
  });

  it("a mid-turn schedule change cannot split the cluster (both see the SAME load)", async () => {
    loadCalls.count = 0;
    schedule.value = makeSchedule();
    const backend = createDomainTriadReadBackend();

    // Read the open-now signal, then mutate the SOURCE before reading hours. The memo
    // holds the resolved promise, so the hours read must still project the schedule
    // the signal came from — this is the concrete contradiction the declaration would
    // otherwise permit.
    const signal = await backend.readSchedule();
    schedule.value = makeContradictingSchedule();

    const hours = await backend.readStoreHours();

    expect(loadCalls.count).toBe(1);
    expect(signal).toBeDefined();
    // Still the ORIGINAL window — the post-read mutation is invisible this turn.
    expect(hours.hoursText).toContain("11h");
    expect(hours.hoursText).not.toContain("05h");
  });
});
