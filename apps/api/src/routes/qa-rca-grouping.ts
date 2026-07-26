// LE2-031 — customer grouping for the RCA conversation rail.
//
// The rail used to read as KERNEL SESSIONS: one row per turn_trace
// conversation_id, which is a per-session UUID. A customer who wrote on Monday
// and again on Friday appeared as two unrelated strangers. This module folds
// those sessions back onto the identity behind them, so the rail reads as
// customers with their sessions as sub-rows.
//
// PURE by construction (no pg, no fetch, no clock): the route does the reads,
// this decides identity + ordering. That is what makes the hard properties
// unit-pinnable — group identity must be a function of the ROW alone, never of
// its position, its neighbours, or the order the rows arrived in, or a live
// refresh would silently re-key (and therefore collapse) the investigator's
// expanded rows.
//
// THE IDENTITY LADDER (first match wins — the order is the whole design):
//   1. ops        session id `admin:<staffId>` — the ops plane has NO
//                 ibx_domain.conversations row at all, so the prefix is the
//                 only marker there will ever be. It wins outright: an ops
//                 thread is never folded into a customer, and never counted as
//                 an unidentified customer.
//   2. customer   ibx_domain.conversations.customer_id — the real identity,
//                 stable across channels and across months.
//   3. phone      the salted phone hash (whatsapp_delivery / conversation_
//                 incidents). A guest who never registered still has ONE hash,
//                 so their sessions still fold together. Hashed, never a phone.
//   4. unidentified  everything else — an EXPLICIT bucket, never a silent drop.
//                 A web visitor with no customer row and no phone is genuinely
//                 unidentifiable from this data; saying so is the honest read,
//                 and the sessions stay one click away.

/** How a group's identity was established (also the rail's visible label). */
export type ConversationGroupKind = "customer" | "ops" | "unidentified";

/** The single explicit home for sessions we cannot attribute. One bucket, by
 *  design: it is a statement ("these have no identity in this data"), not a
 *  per-session pseudo-identity. */
export const UNIDENTIFIED_GROUP_KEY = "unidentified";

/** The ops plane stamps its turn_trace.conversation_id as `admin:<staffId>`. */
export const OPS_SESSION_PREFIX = "admin:";

/** One conversation row as the qa-rca conversations read produces it — the
 *  wire shape plus the two identity columns the route enriches in. */
export interface GroupableConversation {
  sessionId: string;
  channel: string;
  startedAt: string | null;
  lastAt: string | null;
  turnCount: number;
  /** ibx_domain.conversations.customer_id — null for guests and for ops. */
  customerId: string | null;
  /** Salted LGPD hash (never a phone number) — null when no lane carried one. */
  phoneHash: string | null;
}

/** One top-level rail row: a customer (or a staff operator, or the explicit
 *  unidentified bucket) with the sessions that belong to it. */
export interface ConversationGroup {
  /** Stable identity — a pure function of the row's own identity fields.
   *  `customer:<id>` | `phone:<hash>` | `ops:<staffId>` | `unidentified`. */
  groupKey: string;
  kind: ConversationGroupKind;
  /** Display string for the rail (ids are opaque; the kind carries meaning). */
  label: string;
  customerId: string | null;
  phoneHash: string | null;
  /** Ops groups only — the staff actor behind `admin:<staffId>`. */
  staffId: string | null;
  /** Sessions of this group, most-recent-first (the rail's sub-rows). */
  sessionIds: string[];
  /** Distinct channels seen across the group's sessions, sorted. */
  channels: string[];
  sessionCount: number;
  /** Sum of the sessions' turn counts. */
  turnCount: number;
  /** Earliest / latest activity across the group's sessions. */
  startedAt: string | null;
  lastAt: string | null;
}

/** The identity half of a group — everything derivable from ONE row. */
export interface GroupIdentity {
  groupKey: string;
  kind: ConversationGroupKind;
  label: string;
  customerId: string | null;
  phoneHash: string | null;
  staffId: string | null;
}

/** Resolve one conversation to the identity that owns it. Pure, total, and
 *  position-independent — the property every stability pin rests on. */
export function resolveGroupIdentity(c: GroupableConversation): GroupIdentity {
  if (c.sessionId.startsWith(OPS_SESSION_PREFIX)) {
    // `admin:` with nothing after it is malformed but real — keep it in its own
    // ops group rather than inventing a staff id or dropping the thread.
    const staffId = c.sessionId.slice(OPS_SESSION_PREFIX.length);
    return {
      groupKey: `ops:${staffId}`,
      kind: "ops",
      label: staffId.length > 0 ? `ops · ${staffId}` : "ops · (no staff id)",
      customerId: null,
      phoneHash: null,
      staffId: staffId.length > 0 ? staffId : null,
    };
  }
  if (c.customerId !== null && c.customerId.length > 0) {
    return {
      groupKey: `customer:${c.customerId}`,
      kind: "customer",
      label: c.customerId,
      customerId: c.customerId,
      phoneHash: c.phoneHash,
      staffId: null,
    };
  }
  if (c.phoneHash !== null && c.phoneHash.length > 0) {
    return {
      groupKey: `phone:${c.phoneHash}`,
      kind: "customer",
      label: `phone ${c.phoneHash}`,
      customerId: null,
      phoneHash: c.phoneHash,
      staffId: null,
    };
  }
  return {
    groupKey: UNIDENTIFIED_GROUP_KEY,
    kind: "unidentified",
    label: "unidentified",
    customerId: null,
    phoneHash: null,
    staffId: null,
  };
}

/** Sortable instant — a missing/unparseable timestamp sinks to the end rather
 *  than jumping to the top of a recency-ordered list. */
function instant(iso: string | null): number {
  if (iso === null) return Number.NEGATIVE_INFINITY;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : Number.NEGATIVE_INFINITY;
}

/** Most-recent-first, with a total tie-break so equal (or equally absent)
 *  timestamps still order deterministically. Compared, never subtracted: the
 *  -Infinity sentinel makes `b - a` NaN/Infinity and would silently drop the
 *  comparison to the tie-break. */
function byRecencyThen(aAt: string | null, bAt: string | null, aKey: string, bKey: string): number {
  const a = instant(aAt);
  const b = instant(bAt);
  if (a !== b) return b > a ? 1 : -1;
  return aKey.localeCompare(bKey);
}

function minIso(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return instant(a) <= instant(b) ? a : b;
}

function maxIso(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return instant(a) >= instant(b) ? a : b;
}

/** Fold conversations onto their customer identity.
 *
 *  Ordering is TOTAL and content-derived: most-recent activity first, ties
 *  broken by the group key (and by session id inside a group). Two refreshes
 *  over the same rows therefore produce byte-identical output regardless of the
 *  order postgres handed them back — which is what keeps the rail's expanded
 *  rows, its selection, and its deep links from shifting under a live tick.
 *
 *  Scope note: the groups describe the LOADED page of conversations. A
 *  customer's older sessions that the route's LIMIT excluded are simply not
 *  here — the group is never a claim about everything that customer ever did. */
export function groupConversationsByCustomer(
  conversations: ReadonlyArray<GroupableConversation>,
): ConversationGroup[] {
  const byKey = new Map<string, ConversationGroup>();
  const sessionsByKey = new Map<string, GroupableConversation[]>();

  for (const c of conversations) {
    const id = resolveGroupIdentity(c);
    const existing = byKey.get(id.groupKey);
    if (existing === undefined) {
      byKey.set(id.groupKey, {
        groupKey: id.groupKey,
        kind: id.kind,
        label: id.label,
        customerId: id.customerId,
        phoneHash: id.phoneHash,
        staffId: id.staffId,
        sessionIds: [],
        channels: [],
        sessionCount: 0,
        turnCount: c.turnCount,
        startedAt: c.startedAt,
        lastAt: c.lastAt,
      });
      sessionsByKey.set(id.groupKey, [c]);
    } else {
      existing.turnCount += c.turnCount;
      existing.startedAt = minIso(existing.startedAt, c.startedAt);
      existing.lastAt = maxIso(existing.lastAt, c.lastAt);
      // A phone hash may only appear on SOME of a customer's sessions (a web
      // session carries none) — keep the first one seen so the group can still
      // show it. Never overwrites a customer id.
      if (existing.phoneHash === null) existing.phoneHash = id.phoneHash;
      sessionsByKey.get(id.groupKey)!.push(c);
    }
  }

  for (const [key, group] of byKey) {
    const sessions = sessionsByKey.get(key) ?? [];
    sessions.sort((a, b) => byRecencyThen(a.lastAt, b.lastAt, a.sessionId, b.sessionId));
    group.sessionIds = sessions.map((s) => s.sessionId);
    group.sessionCount = sessions.length;
    group.channels = [...new Set(sessions.map((s) => s.channel))].sort();
  }

  return [...byKey.values()].sort((a, b) => byRecencyThen(a.lastAt, b.lastAt, a.groupKey, b.groupKey));
}
