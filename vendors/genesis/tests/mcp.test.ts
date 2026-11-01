/**
 * MCP server tests: real protocol (in-memory client/server pair), all nine
 * tools, success + model-recoverable error paths. No network, no stdio.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";

import { createMcpServer } from "../src/mcp/server.js";

async function pair(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.map((c) => c.text ?? "").join("\n");
}

const TINY = {
  name: "mcp-tiny",
  dataset: { inline: [{ input: "a", reference: "A" }, { input: "b", reference: "B" }] },
  subject: { inline: "upper" },
  evaluator: { type: "exact" },
  metrics: ["task_success"],
  thresholds: { task_success: ">=1.0" },
};

describe("mcp server", () => {
  it("lists all ten tools with descriptions and schemas", async () => {
    const client = await pair();
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([
        "audit_evaluator",
        "check_regression",
        "compare_runs",
        "evaluate",
        "gate",
        "list_benchmarks",
        "read_report",
        "run_benchmark",
        "show_claim",
        "trust",
      ]);
      for (const t of tools) {
        expect(t.description?.length).toBeGreaterThan(0);
        expect(t.inputSchema).toBeTruthy();
      }
    } finally {
      await client.close();
    }
  });

  it("evaluate runs a spec and returns verdict + bundle path", async () => {
    const client = await pair();
    try {
      const result = await client.callTool({ name: "evaluate", arguments: { spec: TINY } });
      const body = text(result as never);
      expect(body).toContain("SUPPORTED");
      expect(body).toContain("outDir");
      expect(result.isError).toBeFalsy();
    } finally {
      await client.close();
    }
  });

  it("invalid specs return model-recoverable errors, not protocol failures", async () => {
    const client = await pair();
    try {
      const result = await client.callTool({ name: "evaluate", arguments: { spec: { name: "bad" } } });
      expect(result.isError).toBe(true);
      expect(text(result as never)).toContain("genesis:");
    } finally {
      await client.close();
    }
  });

  it("gate tool renders a fail-closed release decision", async () => {
    const client = await pair();
    try {
      const release = await client.callTool({
        name: "gate",
        arguments: {
          spec: {
            name: "mcp-gate",
            dataset: { inline: [{ input: "a", reference: "A" }] },
            subject: { inline: "upper" },
            evaluator: { type: "exact" },
            metrics: ["task_success"],
            thresholds: { task_success: ">=1.0" },
          },
        },
      });
      const body = (release.content as { type: string; text?: string }[]).map((c) => c.text ?? "").join("\n");
      expect(body).toContain("GATE: RELEASE");
      const blocked = await client.callTool({
        name: "gate",
        arguments: {
          spec: {
            name: "mcp-gate",
            dataset: { inline: [{ input: "a", reference: "A" }] },
            subject: { inline: "upper" },
            evaluator: { type: "exact" },
            metrics: ["task_success"],
          },
          forbidden: { task_success: 0.5 },
        },
      });
      const blockedBody = (blocked.content as { type: string; text?: string }[]).map((c) => c.text ?? "").join("\n");
      expect(blockedBody).toContain("GATE: BLOCK");
    } finally {
      await client.close();
    }
  }, 120_000);

  it("trust combines system and evaluator verdicts", async () => {
    const client = await pair();
    try {
      const result = await client.callTool({ name: "trust", arguments: { spec: TINY } });
      const body = text(result as never);
      expect(body).toContain("TRUSTED");
    } finally {
      await client.close();
    }
  });

  it("audit_evaluator judges the spec evaluator", async () => {
    const client = await pair();
    try {
      const result = await client.callTool({ name: "audit_evaluator", arguments: { spec: TINY } });
      expect(text(result as never)).toContain("SOUND");
    } finally {
      await client.close();
    }
  });

  it("run_benchmark + list_benchmarks work over the shipped registry", async () => {
    const client = await pair();
    try {
      const listed = await client.callTool({ name: "list_benchmarks", arguments: {} });
      expect(text(listed as never)).toContain("sentiment-v1");
      const ran = await client.callTool({
        name: "run_benchmark",
        arguments: { benchmark: "arithmetic-v1", subjectInline: "double" },
      });
      expect(text(ran as never)).toContain("SUPPORTED");
      const missing = await client.callTool({
        name: "run_benchmark",
        arguments: { benchmark: "nope", subjectInline: "echo" },
      });
      expect(missing.isError).toBe(true);
    } finally {
      await client.close();
    }
  }, 120_000);

  it("compare_runs and check_regression gate round-trip", async () => {
    const client = await pair();
    try {
      const ev = await client.callTool({ name: "evaluate", arguments: { spec: TINY } });
      const outDir = JSON.parse(
        (text(ev as never).match(/```json\n([\s\S]*)\n```/)?.[1] ?? "{}"),
      ).outDir as string;
      const cmp = await client.callTool({ name: "compare_runs", arguments: { runA: outDir, runB: outDir } });
      expect(text(cmp as never)).toContain("COMPARE");
      const gate = await client.callTool({
        name: "check_regression",
        arguments: { base: outDir, candidate: outDir, maxQualityDrop: 0.02 },
      });
      expect(text(gate as never)).toContain("PASS");
      const badGate = await client.callTool({
        name: "check_regression",
        arguments: { base: outDir, candidate: "/nonexistent" },
      });
      expect(badGate.isError).toBe(true);
    } finally {
      await client.close();
    }
  }, 120_000);

  it("read_report and show_claim read back bundles and specs", async () => {
    const client = await pair();
    try {
      const ev = await client.callTool({ name: "evaluate", arguments: { spec: TINY } });
      const outDir = JSON.parse(
        (text(ev as never).match(/```json\n([\s\S]*)\n```/)?.[1] ?? "{}"),
      ).outDir as string;
      const report = await client.callTool({ name: "read_report", arguments: { dir: outDir } });
      expect(text(report as never)).toContain("verdict");
      const claim = await client.callTool({ name: "show_claim", arguments: { specPath: "examples/rag/evaluation.yaml" } });
      expect(text(claim as never)).toContain("claim-rag-001");
      const missing = await client.callTool({ name: "read_report", arguments: { dir: "/nonexistent" } });
      expect(missing.isError).toBe(true);
    } finally {
      await client.close();
    }
  }, 120_000);
});
