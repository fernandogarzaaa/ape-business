/**
 * Subject adapter tests: HTTP contract, timeout coverage, failure modes.
 */

import { createServer, type Server } from "node:http";
import { describe, expect, it } from "vitest";

import { createSubject } from "../src/eval/subjects.js";
import type { EvalTask } from "../src/eval/types.js";

function task(): EvalTask {
  return { id: "task-0001", input: "hello" };
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

describe("http subject", () => {
  it("POSTs the task and parses a JSON body", async () => {
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        const task = JSON.parse(body).task;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ echo: task.input }));
      });
    });
    const url = await listen(server);
    try {
      const r = await createSubject({ http: { url }, timeout_ms: 5000 }).run(task(), 0, null);
      expect(r.error).toBeNull();
      expect(r.output).toEqual({ echo: "hello" });
    } finally {
      server.close();
    }
  });

  it("P1: the timeout covers a stalled response body, not just headers", async () => {
    // Sends headers immediately, then never sends the body: pre-fix, the
    // abort timer was cleared on headers and res.text() hung forever.
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"partial": ');
      // Never end the response.
    });
    const url = await listen(server);
    try {
      const started = Date.now();
      const r = await createSubject({ http: { url }, timeout_ms: 300 }).run(task(), 0, null);
      expect(Date.now() - started).toBeLessThan(5000);
      expect(r.timed_out).toBe(true);
      expect(r.output).toBeNull();
    } finally {
      server.close();
    }
  }, 15_000);

  it("reports HTTP error statuses as errors, not failures", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(500);
      res.end("boom");
    });
    const url = await listen(server);
    try {
      const r = await createSubject({ http: { url }, timeout_ms: 5000 }).run(task(), 0, null);
      expect(r.error).toContain("500");
      expect(r.exit_code).toBe(500);
    } finally {
      server.close();
    }
  });
});
