/**
 * backlog.fix.rag-query-ranked-telemetry: startAgentToolsServer wires setRagHostHooks to its own
 * collector, so a rag_query served by rks-agent-tools (the claude-cli research path) emits rag.query.
 * Same in-process harness as tests/unit/agents/agent-tools-mcp-server.test.mjs (InMemoryTransport,
 * injected recording collector, no subprocess). query() and the RAG path loader are mocked.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../../../packages/rag/src/query.mjs", () => ({ query: (...args) => queryMock(...args) }));
vi.mock("../../../packages/rag/src/rag-config-loader.mjs", () => ({
  getRagPathsFor: vi.fn(async () => ({ notes: "/nonexistent/rag/notes" })),
}));
vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({ StdioServerTransport: vi.fn() }));

import { startAgentToolsServer } from "../../../packages/mcp-rks/src/agents/agent-tools-mcp-server.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const SERVER_REL = "packages/mcp-rks/src/agents/agent-tools-mcp-server.mjs";
const SLUGS = ["doc.a", "doc.b", "doc.c", "doc.d", "doc.e"];

let tmp;
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-tools-rag-telemetry-"));
  for (const s of SLUGS) fs.writeFileSync(path.join(tmp, `${s}.md`), `${s}\n`, "utf8");
});
afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function recordingCollector() {
  const events = [];
  return {
    events,
    emit: (event, projectId, data) => {
      events.push({ event, projectId, data });
    },
    flush: async () => {},
  };
}

async function servedRagQuery(q) {
  queryMock.mockResolvedValue({
    ok: true,
    matches: SLUGS.map((slug, i) => ({ slug, path: `${slug}.md`, text: `${slug} text`, score: 1 - i / 10, hybridRank: i + 1, semanticScore: 0.5, keywordScore: 0.1 })),
    candidateTrace: { windowRows: 5, candidates: [] },
  });
  const collector = recordingCollector();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const { server } = await startAgentToolsServer(
    ["--agent", "research", "--project", "proj-rq", "--root", tmp, "--telemetry-id", "tid-rq", "--model", "model-rq"],
    { transport: serverTransport, ensureTelemetryStorage: () => collector },
  );
  const client = new Client({ name: "agent-tools-rag-telemetry-test", version: "0.0.0" });
  try {
    await client.connect(clientTransport);
    const res = await client.callTool({ name: "rag_query", arguments: { q } });
    return { collector, res };
  } finally {
    await client.close();
    await server.close();
  }
}

describe("rks-agent-tools rag.query telemetry wiring", () => {
  it("a served rag_query call records rag.query on the server's own collector", async () => {
    const { collector, res } = await servedRagQuery("wiring probe");
    expect(res.isError).toBeFalsy();
    const ragEvents = collector.events.filter((e) => e.event === "rag.query");
    expect(ragEvents.length).toBeGreaterThan(0);
    expect(ragEvents.some((e) => e.data.query === "wiring probe")).toBe(true);
  });

  it("does not wire addRagSourcedPath", () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, SERVER_REL), "utf8");
    expect(src).not.toContain("addRagSourcedPath");
  });

  it("the agent.research.tool_call event for rag_query is unchanged", async () => {
    const { collector } = await servedRagQuery("tool call probe");
    const call = collector.events.find((e) => e.event === "agent.research.tool_call" && e.data.tool === "rag_query");
    expect(call).toBeDefined();
    expect(call.data).toMatchObject({ tool: "rag_query", ok: true, query: "tool call probe", telemetryId: "tid-rq", model: "model-rq" });
    expect(typeof call.data.durationMs).toBe("number");
    expect("hitCount" in call.data).toBe(true);
    expect("ranked" in call.data).toBe(false);
    expect("candidates" in call.data).toBe(false);
  });
});
