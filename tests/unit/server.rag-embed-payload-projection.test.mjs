/**
 * Witness for backlog.fix.rag-embed-reports-corpus-total-not-per-run-outcome — the
 * BOUNDARY half.
 *
 * The embed layer already computed honest per-run counts. The `rks_rag_embed` payload
 * projection discarded them, kept only the whole-corpus `indexed`, and did not even echo
 * the `files` input — so `indexed: 4050` arrived with nothing tying it to the one file the
 * caller had named.
 *
 * BEHAVIOURAL, not a source grep. `runRagEmbed` is mocked at the specifier `server.mjs`
 * actually imports (bare `@routekit/rag`), with the other imported symbols preserved, so
 * the projection is exercised rather than read.
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

// A project id that cannot collide with a real registry entry. The first cut used
// "routekit-shell-core", which resolved through the machine's project REGISTRY — present on
// a dev box, absent on a CI runner. It passed locally for the wrong reason and went red in
// CI with "Project not found".
const PROJECT_ID = "rag-projection-fixture";

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
  root = fs.mkdtempSync(path.join(os.tmpdir(), "rks-embed-projection-"));
  fs.mkdirSync(path.join(root, "notes"), { recursive: true });
  fs.mkdirSync(path.join(root, ".rks"), { recursive: true });
  // `id`, NOT `projectId` — project-context.mjs reads `localJson.id` to decide whether this
  // is the "self" project. With the wrong key it silently falls through to the registry.
  fs.writeFileSync(
    path.join(root, ".rks", "project.json"),
    JSON.stringify({ id: PROJECT_ID, branches: { working: "staging" } }),
  );
  // loadContext requires a KG file alongside project.json; without it the tool refuses
  // before the projection under test ever runs.
  fs.mkdirSync(path.join(root, "routekit"), { recursive: true });
  fs.writeFileSync(path.join(root, "routekit", "kg.yaml"), "nodes: []\n");
  process.env.ROUTEKIT_PROJECT_ROOT = root;
  // An inherited ROUTEKIT_PROJECT_ID would win over the file and reopen the registry path.
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
  indexed: 4109,
  corpusRowTotal: 4109,
  processedNotes: 3,
  embeddedNotes: 1,
  skippedNotes: 2,
  skippedCodeFiles: 0,
  fileOutcomes: [
    { file: "notes/mine.md", embedded: true, reason: null },
    { file: "notes/other.md", embedded: false, reason: "unchanged" },
    { file: "notes/drafts.x.md", embedded: false, reason: "not-selected" },
  ],
  db: "/tmp/db",
};

describe("the rks_rag_embed payload carries per-run work, not only a corpus total", () => {
  it("ECHOES the files input, so a caller can confirm the request arrived intact", async () => {
    runRagEmbed.mockResolvedValue(PRODUCER_RESULT);
    const res = await callEmbed({ projectId: PROJECT_ID, files: ["notes/mine.md"] });
    expect(res.files).toEqual(["notes/mine.md"]);
  });

  it("carries the four per-run counters the producer computed", async () => {
    runRagEmbed.mockResolvedValue(PRODUCER_RESULT);
    const res = await callEmbed({ projectId: PROJECT_ID, files: ["notes/mine.md"] });
    expect(res.processedNotes).toBe(3);
    expect(res.embeddedNotes).toBe(1);
    expect(res.skippedNotes).toBe(2);
    expect(res.skippedCodeFiles).toBe(0);
  });

  it("carries the per-file outcomes, so the caller's own file is answerable", async () => {
    runRagEmbed.mockResolvedValue(PRODUCER_RESULT);
    const res = await callEmbed({ projectId: PROJECT_ID, files: ["notes/mine.md"] });
    const mine = res.fileOutcomes.find((o) => o.file === "notes/mine.md");
    expect(mine).toMatchObject({ embedded: true, reason: null });
    expect(res.fileOutcomes.find((o) => o.file === "notes/drafts.x.md").reason).toBe("not-selected");
  });

  it("names the corpus total apart from the run result", async () => {
    runRagEmbed.mockResolvedValue(PRODUCER_RESULT);
    const res = await callEmbed({ projectId: PROJECT_ID, files: ["notes/mine.md"] });
    expect(res.corpusRowTotal).toBe(4109);
    // `indexed` keeps its meaning for existing consumers rather than being repurposed.
    expect(res.indexed).toBe(4109);
  });

  it("projects the corpus total from the PRODUCER, not from a fallback onto indexed", async () => {
    // Two different values kill the `?? result.indexed` arm as a load-bearing path: if the
    // projection fell back, corpusRowTotal would read 4109 instead of 77.
    runRagEmbed.mockResolvedValue({ ...PRODUCER_RESULT, corpusRowTotal: 77 });
    const res = await callEmbed({ projectId: PROJECT_ID, files: ["notes/mine.md"] });
    expect(res.corpusRowTotal).toBe(77);
    expect(res.indexed).toBe(4109);
  });

  it("reports files as null when the caller named none, rather than omitting the key", async () => {
    runRagEmbed.mockResolvedValue(PRODUCER_RESULT);
    const res = await callEmbed({ projectId: PROJECT_ID });
    expect(res.files).toBeNull();
  });
});
