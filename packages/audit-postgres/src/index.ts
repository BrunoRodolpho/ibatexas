// @adjudicate/audit-postgres — durable governance trail in Postgres.

export {
  createPostgresSink,
  partitionMonthOf,
  recordToRow,
  type IntentAuditRow,
  type PostgresSinkOptions,
  type PostgresWriter,
} from "./postgres-sink.js";

export {
  readAuditWindow,
  rowToRecord,
  type AuditQuery,
  type AuditQueryWindow,
} from "./replay.js";
