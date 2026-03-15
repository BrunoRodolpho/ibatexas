/**
 * Error thrown when an upstream service (e.g. Medusa) returns an error.
 * The raw upstream message is stored for server-side logging, but the
 * error handler will only return a generic message to the client.
 */
export class UpstreamError extends Error {
  readonly statusCode: number;
  readonly upstream: string;

  constructor(upstream: string, statusCode: number, rawMessage: string) {
    super(`${upstream} error ${statusCode}`);
    this.name = "UpstreamError";
    this.upstream = upstream;
    this.statusCode = statusCode;
    // Store raw message for server-side logging only
    Object.defineProperty(this, "rawMessage", {
      value: rawMessage,
      enumerable: false,
    });
  }
}
