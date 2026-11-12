// backlog.fix.rag-embed-server-stale-module-unreported: the rks_rag_embed payload carries the
// stale-embed-code fields runRagEmbed returns, and merges result.warning with result.error.
// BEHAVIOURAL: runRagEmbed is mocked at the bare @routekit/rag specifier that handlers/rag.mjs
// imports, with the other exports preserved. Fixture pattern copied from
// tests/unit/server.rag-embed-payload-projection.test.mjs.
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

// A project id that cannot collide with a real registry entry.
const PROJECT_ID = "rag-stale-code-projection-fixture";
const STALE_WARNING = "embed code on disk is newer than the loaded code; restart the MCP server";

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
  root = fs.mkdtempSync(path.join(os.tmpdir(), "rks-embed-stale-projection-"));
  fs.mkdirSync(path.join(root, "notes"), { recursive: true });
  fs.mkdirSync(path.join(root, ".rks"), { recursive: true });
  // `id`, NOT `projectId` (project-context.mjs reads localJson.id).
  fs.writeFileSync(
    path.join(root, ".rks", "project.json"),
    JSON.stringify({ id: PROJECT_ID, branches: { working: "staging" } }),
  );
  // loadContext requires a KG file alongside project.json.
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

describe("rks_rag_embed stale embed code projection", () => {
  it("projects embedCodeStale, both timestamps and the stale warning on a stale ok run", async () => {
    runRagEmbed.mockResolvedValue({
      ok: true,
      indexed: 1,
      embedCodeStale: true,
      embedCodeMtimeAtLoad: "2026-01-01T00:00:00.000Z",
      embedCodeOnDiskAt: "2026-01-02T00:00:00.000Z",
      warning: STALE_WARNING,
    });
    const res = await callEmbed({ projectId: PROJECT_ID });
    expect(res.ok).toBe(true);
    expect(res.embedCodeStale).toBe(true);
    expect(res.embedCodeMtimeAtLoad).toBe("2026-01-01T00:00:00.000Z");
    expect(res.embedCodeOnDiskAt).toBe("2026-01-02T00:00:00.000Z");
    expect(res.warning).toBe(STALE_WARNING);
  });

  it("projects embedCodeStale null and the reason, with the error as warning, on a lock-refused result", async () => {
    const error = "Embed already in progress (PID: 123, started: 1)";
    const reason = "embed lock not acquired; embed code neither loaded nor compared";
    runRagEmbed.mockResolvedValue({ ok: false, error, locked: true, embedCodeStale: null, embedCodeStaleReason: reason });
    const res = await callEmbed({ projectId: PROJECT_ID });
    expect(res.ok).toBe(false);
    expect(res.embedCodeStale).toBeNull();
    expect(res.embedCodeStaleReason).toBe(reason);
    expect(res.warning).toBe(error);
  });

  it("puts both strings in warning when the result carries both error and warning", async () => {
    const error = "embed failed: simulated";
    runRagEmbed.mockResolvedValue({ ok: false, error, warning: STALE_WARNING, embedCodeStale: true });
    const res = await callEmbed({ projectId: PROJECT_ID });
    expect(typeof res.warning).toBe("string");
    expect(res.warning).toContain(error);
    expect(res.warning).toContain(STALE_WARNING);
  });

  it("leaves warning absent when the result carries neither error nor warning", async () => {
    runRagEmbed.mockResolvedValue({ ok: true, indexed: 1, embedCodeStale: false });
    const res = await callEmbed({ projectId: PROJECT_ID });
    expect(res.embedCodeStale).toBe(false);
    expect(res.warning).toBeUndefined();
  });

  it("projects embedCodeStale null, the reason and the unobserved-staleness warning on an ok run", async () => {
    const reason = "fingerprint directory unreadable: simulated EACCES";
    const warning = "could not determine whether the embed ran current embed code: simulated EACCES";
    runRagEmbed.mockResolvedValue({ ok: true, indexed: 1, embedCodeStale: null, embedCodeStaleReason: reason, warning });
    const res = await callEmbed({ projectId: PROJECT_ID });
    expect(res.ok).toBe(true);
    expect(res.embedCodeStale).toBeNull();
    expect(res.embedCodeStaleReason).toBe(reason);
    expect(typeof res.warning).toBe("string");
    expect(res.warning).toContain(warning);
  });
});
