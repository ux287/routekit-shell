/**
 * Witness for backlog.fix.rag-embed-result-file-outcomes-unbounded (handler half).
 * rks_rag_embed must bound fileOutcomes at the MCP boundary and flag every truncation.
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
const { RAG_EMBED_FILE_OUTCOMES_CAP: CAP } = await import("../../packages/mcp-rks/src/server/handlers/rag.mjs");

const PROJECT_ID = "rag-embed-bounded-fixture";
let root;
let prevRoot;
let prevId;

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
  prevRoot = process.env.ROUTEKIT_PROJECT_ROOT;
  prevId = process.env.ROUTEKIT_PROJECT_ID;
  runRagEmbed.mockReset();
  // Canonical (symlink-resolved) root, used for both ROUTEKIT_PROJECT_ROOT and the absolute path
  // passed in files, so both are built from one spelling. Defensive only: rag.mjs resolves no symlinks.
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rks-embed-bounded-")));
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

const outcomes = (prefix, n, embedded, reason) =>
  Array.from({ length: n }, (_, i) => ({ file: `notes/${prefix}${i}.md`, embedded, reason }));

const producer = (fileOutcomes, extra = {}) => ({
  ok: true, indexed: 1, corpusRowTotal: 1, processedNotes: fileOutcomes.length,
  embeddedNotes: 0, skippedNotes: 0, skippedCodeFiles: 0, fileOutcomes, db: "/tmp/db", ...extra,
});

describe("rks_rag_embed bounds fileOutcomes at the MCP boundary", () => {
  it("above the cap, a full walk reports truncation with a total and counts that sum to it", async () => {
    const all = [...outcomes("e", CAP, true, null), ...outcomes("u", CAP, false, "unchanged"), ...outcomes("x", 3, false, "excluded")];
    runRagEmbed.mockResolvedValue(producer(all));
    const res = await callEmbed({ projectId: PROJECT_ID });
    expect(res.fileOutcomesTruncated).toBe(true);
    expect(res.fileOutcomesTotal).toBe(all.length);
    expect(Object.values(res.fileOutcomeCounts).reduce((a, b) => a + b, 0)).toBe(all.length);
    expect(res.fileOutcomes.length).toBeLessThanOrEqual(CAP);
  });

  it("above the cap, only non-embedded, non-unchanged outcomes are returned", async () => {
    const problems = [...outcomes("x", 2, false, "excluded"), ...outcomes("n", 2, false, "no-rows")];
    runRagEmbed.mockResolvedValue(producer([...outcomes("e", CAP, true, null), ...outcomes("u", CAP, false, "unchanged"), ...problems]));
    const res = await callEmbed({ projectId: PROJECT_ID });
    expect(res.fileOutcomes).toEqual(problems);
    expect(res.fileOutcomes.some((o) => o.embedded === true || o.reason === "unchanged")).toBe(false);
  });

  it("above the cap, problem outcomes beyond the cap are truncated to the cap and flagged", async () => {
    runRagEmbed.mockResolvedValue(producer(outcomes("x", CAP + 5, false, "excluded")));
    const res = await callEmbed({ projectId: PROJECT_ID });
    expect(res.fileOutcomes.length).toBe(CAP);
    expect(res.fileOutcomesTruncated).toBe(true);
    expect(res.fileOutcomesTotal).toBe(CAP + 5);
  });

  it("at or below the cap, fileOutcomes is returned whole and not flagged truncated", async () => {
    const all = [...outcomes("e", CAP - 1, true, null), ...outcomes("u", 1, false, "unchanged")];
    runRagEmbed.mockResolvedValue(producer(all));
    const res = await callEmbed({ projectId: PROJECT_ID });
    expect(res.fileOutcomes).toEqual(all);
    expect(res.fileOutcomesTruncated === undefined || res.fileOutcomesTruncated === false).toBe(true);
  });

  it("with files supplied, only outcomes for the requested files are returned", async () => {
    const all = [...outcomes("e", CAP * 2, true, null), ...outcomes("s", 5, false, "not-selected")];
    runRagEmbed.mockResolvedValue(producer(all));
    const res = await callEmbed({ projectId: PROJECT_ID, files: ["notes/e0.md", "notes/s1.md"] });
    expect(res.fileOutcomes.map((o) => o.file).sort()).toEqual(["notes/e0.md", "notes/s1.md"]);
    expect(res.fileOutcomesTotal).toBe(all.length);
  });

  it("with files supplied as an absolute path, the requested file's outcome is still returned", async () => {
    const all = [...outcomes("e", 3, true, null), ...outcomes("s", 2, false, "not-selected")];
    runRagEmbed.mockResolvedValue(producer(all));
    const res = await callEmbed({ projectId: PROJECT_ID, files: [path.join(root, "notes", "e1.md")] });
    expect(res.fileOutcomes).toEqual([{ file: "notes/e1.md", embedded: true, reason: null }]);
    expect(res.fileOutcomesTotal).toBe(all.length);
  });

  it("above the cap, an all-healthy full walk returns an empty fileOutcomes list", async () => {
    runRagEmbed.mockResolvedValue(producer([...outcomes("e", CAP, true, null), ...outcomes("u", CAP, false, "unchanged")]));
    const res = await callEmbed({ projectId: PROJECT_ID });
    expect(res.fileOutcomes).toEqual([]);
  });

  it("above the cap, an all-healthy full walk is flagged truncated", async () => {
    runRagEmbed.mockResolvedValue(producer([...outcomes("e", CAP, true, null), ...outcomes("u", CAP, false, "unchanged")]));
    const res = await callEmbed({ projectId: PROJECT_ID });
    expect(res.fileOutcomesTruncated).toBe(true);
  });

  it("above the cap, an all-healthy full walk reports its total and embedded/unchanged counts", async () => {
    const all = [...outcomes("e", CAP, true, null), ...outcomes("u", CAP, false, "unchanged")];
    runRagEmbed.mockResolvedValue(producer(all));
    const res = await callEmbed({ projectId: PROJECT_ID });
    expect(res.fileOutcomesTotal).toBe(all.length);
    expect(res.fileOutcomesTotal).toBe(2 * CAP);
    expect(res.fileOutcomeCounts).toEqual({ embedded: CAP, unchanged: CAP });
  });

  it("at CAP + 1, an all-healthy full walk returns an empty list flagged truncated", async () => {
    runRagEmbed.mockResolvedValue(producer([...outcomes("e", CAP, true, null), ...outcomes("u", 1, false, "unchanged")]));
    const res = await callEmbed({ projectId: PROJECT_ID });
    expect(res.fileOutcomes).toEqual([]);
    expect(res.fileOutcomesTruncated).toBe(true);
    expect(res.fileOutcomesTotal).toBe(CAP + 1);
  });

  it("projects stalePathsSent from the producer result", async () => {
    runRagEmbed.mockResolvedValue(producer(outcomes("e", 1, true, null), { stalePathsSent: 7 }));
    const res = await callEmbed({ projectId: PROJECT_ID });
    expect(res.stalePathsSent).toBe(7);
  });
});
