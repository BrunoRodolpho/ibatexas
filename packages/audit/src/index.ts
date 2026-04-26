// @adjudicate/audit — execution ledger + durable audit sinks + replay.

export { type Ledger, type LedgerHit, type LedgerRecordInput } from "./ledger.js";
export {
  createRedisLedger,
  type CreateRedisLedgerOptions,
  type RedisLedgerClient,
} from "./ledger-redis.js";
export { createMemoryLedger } from "./ledger-memory.js";

export { type AuditSink, multiSink } from "./sink.js";
export {
  createConsoleSink,
  type ConsoleSinkOptions,
} from "./sink-console.js";
export {
  createNatsSink,
  type NatsPublisher,
  type NatsSinkOptions,
} from "./sink-nats.js";

export { replay, type Adjudicator, type ReplayReport } from "./replay.js";

export { isLedgerEnabled, isLedgerEnforced } from "./feature-flag.js";
