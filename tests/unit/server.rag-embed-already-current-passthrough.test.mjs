/**
 * Witness for backlog.fix.rag-embed-unchanged-outcome-legibility (boundary half).
 * projectFileOutcomes must pass alreadyCurrent through unchanged. Harness mirrors
 * tests/unit/server.rag-embed-payload-projection.test.mjs: runRagEmbed mocked at the bare
 * @routekit/rag specifier, server driven over an in-memory MCP transport.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const runRagEmbed = vi.fn();
vi.mock("@routekit/rag", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, runRagEmbed };
});
const { createServer } = await import("../../packages/mcp-rks/src/server.mjs");

const PROJECT_ID = "rag-already-current-fixture";
let root;
const prevRoot = process.env.ROUTEKIT_PROJECT_ROOT;
const prevId = process.env.ROUTEKIT_PROJECT_ID;

async function callEmbed(args) {
  const server = createServer();
  const client = new Client({ name: "test", version: "0.0.0" }, { capabilities: {} });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  try {
    const r = await client.callTool({ name: "rks_rag_embed", arguments: args });
    return JSON.parse(r?.content?.[0]?.text ?? "{}");
  } finally {
    await client.close();
  }
}

beforeEach(() => {
  runRagEmbed.mockReset();
  root = fs.mkdtempSync(path.join(os.tmpdir(), "rks-embed-already-current-"));
  fs.mkdirSync(path.join(root, "notes"), { recursive: true });
  fs.mkdirSync(path.join(root, ".rks"), { recursive: true });
  fs.writeFileSync(path.join(root, ".rks", "project.json"), JSON.stringify({ id: PROJECT_ID, branches: { working: "staging" } }));
  fs.mkdirSync(path.join(root, "routekit"), { recursive: true });
  fs.writeFileSync(path.join(root, "routekit", "kg.yaml"), "nodes: []\n");
  process.env.ROUTEKIT_PROJECT_ROOT = root;
  delete process.env.ROUTEKIT_PROJECT_ID;
});

afterEach(() => {
  if (prevRoot === undefined) delete process.env.ROUTEKIT_PROJECT_ROOT;
  else process.env.ROUTEKIT_PROJECT_ROOT = prevRoot;
  if (prevId === undefined) delete process.env.ROUTEKIT_PROJECT_ID;
  else process.env.ROUTEKIT_PROJECT_ID = prevId;
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
});

const PRODUCER_RESULT = {
  ok: true,
  indexed: 10,
  corpusRowTotal: 10,
  processedNotes: 2,
  embeddedNotes: 1,
  skippedNotes: 1,
  skippedCodeFiles: 0,
  fileOutcomes: [
    { file: "notes/current.md", embedded: false, reason: "unchanged", alreadyCurrent: true },
    { file: "notes/fresh.md", embedded: true, reason: null },
  ],
  db: "/tmp/db",
};

describe("rks_rag_embed handler passes alreadyCurrent through", () => {
  it("keeps alreadyCurrent on a requested file outcome", async () => {
    runRagEmbed.mockResolvedValue(PRODUCER_RESULT);
    const res = await callEmbed({ projectId: PROJECT_ID, files: ["notes/current.md"] });
    expect(res.fileOutcomes).toEqual([{ file: "notes/current.md", embedded: false, reason: "unchanged", alreadyCurrent: true }]);
  });

  it("keeps alreadyCurrent below the cap and adds it nowhere else", async () => {
    runRagEmbed.mockResolvedValue(PRODUCER_RESULT);
    const res = await callEmbed({ projectId: PROJECT_ID });
    const current = res.fileOutcomes.find((o) => o.file === "notes/current.md");
    const fresh = res.fileOutcomes.find((o) => o.file === "notes/fresh.md");
    expect(current.alreadyCurrent).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(fresh, "alreadyCurrent")).toBe(false);
  });
});
