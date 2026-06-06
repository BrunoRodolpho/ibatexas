// Verifies the VictoriaLogs log shipper's contract + its load-bearing fence:
// it must NEVER block or throw into the app, even when VictoriaLogs is down.
// Runs fully offline against a local http server (no container/image needed).

import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it, expect } from "vitest";
import { createVictoriaLogsStream } from "../../observability/victorialogs-stream.js";

function listen(handler: http.RequestListener): Promise<{ port: number; close: () => void; server: http.Server }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ port, close: () => server.close(), server });
    });
  });
}

describe("victorialogs-stream", () => {
  it("POSTs buffered pino lines to /insert/jsonline as ndjson with stream-field tagging", async () => {
    let capturedUrl = "";
    let capturedBody = "";
    const { port, close } = await listen((req, res) => {
      capturedUrl = req.url ?? "";
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        capturedBody = body;
        res.writeHead(204);
        res.end();
      });
    });

    const stream = createVictoriaLogsStream(`http://127.0.0.1:${port}`);
    stream.write('{"level":30,"msg":"a","component":"kernel","event":"decision"}\n');
    stream.write('{"level":40,"msg":"b","component":"kernel","event":"refusal"}\n');
    await new Promise<void>((resolve) => stream.end(resolve)); // final → flush → POST

    // The ingestion contract VictoriaLogs needs.
    expect(capturedUrl).toContain("/insert/jsonline");
    expect(capturedUrl).toContain("_msg_field=msg");
    expect(capturedUrl).toContain("_time_field=time");
    expect(capturedUrl).toContain("_stream_fields=component,event");
    // Both lines shipped, newline-delimited (ndjson).
    expect(capturedBody).toContain('"msg":"a"');
    expect(capturedBody).toContain('"msg":"b"');
    expect(capturedBody.trimEnd().split("\n")).toHaveLength(2);

    close();
  });

  it("never throws when VictoriaLogs is unreachable (failure-isolated)", async () => {
    // Nothing is listening here — every flush will ECONNREFUSED.
    const stream = createVictoriaLogsStream("http://127.0.0.1:1");

    // write() must return synchronously without throwing.
    expect(() => stream.write('{"msg":"x"}\n')).not.toThrow();

    // end() triggers a flush that fails — it must resolve cleanly, never reject.
    await expect(
      new Promise<void>((resolve, reject) =>
        stream.end((err?: Error | null) => (err ? reject(err) : resolve())),
      ),
    ).resolves.toBeUndefined();
  });

  it("keeps write() non-blocking and bounded under a flood (no app back-pressure)", () => {
    const stream = createVictoriaLogsStream("http://127.0.0.1:1"); // unreachable
    const start = Date.now();
    for (let i = 0; i < 50_000; i++) stream.write(`{"n":${i}}\n`);
    // 50k O(1) buffer appends are near-instant; if write() awaited the network
    // or the buffer grew unbounded this would stall. Generous ceiling.
    expect(Date.now() - start).toBeLessThan(2000);
    stream.destroy();
  });
});
