// Broadcast opt-out registry (responder-trace-admin D3).
//
// A Redis SET of opted-out recipients (phones). The broadcast route consults it
// BEFORE every proactive send so a customer who opted out of marketing is never
// blasted. Staff manage it via the admin broadcast routes (and an inbound
// "PARAR"/"STOP" handler can call optOut() — left as a follow-up hook).
//
// Key (rk(), Hard Rule #7): broadcast:optout → SET of recipient strings.

import { getRedisClient, rk } from "@ibatexas/tools";

export interface OptOutRedis {
  sAdd(key: string, member: string): Promise<unknown>;
  sRem(key: string, member: string): Promise<unknown>;
  sIsMember(key: string, member: string): Promise<boolean>;
  sMembers(key: string): Promise<string[]>;
}

export interface BroadcastOptOutStore {
  optOut(recipient: string): Promise<void>;
  optIn(recipient: string): Promise<void>;
  isOptedOut(recipient: string): Promise<boolean>;
  list(): Promise<string[]>;
}

const OPTOUT_SET = (): string => rk("broadcast:optout");

export function createBroadcastOptOutStore(redis: OptOutRedis): BroadcastOptOutStore {
  return {
    async optOut(recipient) {
      await redis.sAdd(OPTOUT_SET(), recipient);
    },
    async optIn(recipient) {
      await redis.sRem(OPTOUT_SET(), recipient);
    },
    async isOptedOut(recipient) {
      return redis.sIsMember(OPTOUT_SET(), recipient);
    },
    async list() {
      return redis.sMembers(OPTOUT_SET());
    },
  };
}

export async function getBroadcastOptOutStore(): Promise<BroadcastOptOutStore> {
  const redis = (await getRedisClient()) as unknown as OptOutRedis;
  return createBroadcastOptOutStore(redis);
}
