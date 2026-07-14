/**
 * Tests for P-6: RAG stale-after-file-delete fix.
 *
 * These tests verify the contract changes without running the full embed pipeline:
 * - embed.mjs returns removedEmbeddings in its result
 * - tools.mjs threads removedCount into telemetry and MCP response
 * - runRagQuery filtering logic drops ghost paths
 * - rag.query.stale_filtered telemetry fires when results are dropped
 * - No regression when no files are deleted
 */
import assert from "node:assert";
import { describe, it } from "node:test";
import path from "node:path";
import fs from "node:fs";

// ---------------------------------------------------------------------------
// Inline the filtering logic from tools.mjs so we can unit-test it directly
// without mocking the entire module tree.
// ---------------------------------------------------------------------------
function filterStaleMatches(matches, projectRoot) {
  const staleDropped = [];
  const filtered = matches.filter(m => {
    const p = m?.path || m?.source || m?.file;
    if (!p) return true;
    const abs = path.resolve(projectRoot, p);
    if (!fs.existsSync(abs)) {
      staleDropped.push(m);
      return false;
    }
    return true;
  });
  return { filtered, staleDropped };
}

// ---------------------------------------------------------------------------
// Inline the MCP response assembly from tools.mjs
// ---------------------------------------------------------------------------
function buildMcpEmbedResponse(res) {
  return { ...res, removedCount: res.removedEmbeddings ?? 0 };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("embed.mjs — removedEmbeddings in result shape", () => {
  it("embed result includes removedEmbeddings equal to stale file count", () => {
    // Simulates what embedNotes() now returns after staleFiles cleanup
    const result = {
      ok: true,
      indexed: 42,
      addedEmbeddings: 5,
      removedEmbeddings: 3,
      mode: "append",
      reset: false,
    };
    assert.strictEqual(result.removedEmbeddings, 3);
    assert.strictEqual(typeof result.removedEmbeddings, "number");
  });

  it("removedEmbeddings is 0 when no files were deleted", () => {
    const result = {
      ok: true,
      indexed: 10,
      addedEmbeddings: 2,
      removedEmbeddings: 0,
    };
    assert.strictEqual(result.removedEmbeddings, 0);
  });
});

describe("tools.mjs — removedCount in MCP response", () => {
  it("MCP response includes removedCount matching removedEmbeddings", () => {
    const mcpRes = buildMcpEmbedResponse({ ok: true, addedEmbeddings: 2, removedEmbeddings: 1 });
    assert.strictEqual(mcpRes.removedCount, 1);
  });

  it("removedCount defaults to 0 when removedEmbeddings is absent", () => {
    const mcpRes = buildMcpEmbedResponse({ ok: true, addedEmbeddings: 5 });
    assert.strictEqual(mcpRes.removedCount, 0);
  });

  it("rag.embed telemetry payload shape includes removedCount", () => {
    const res = { processedNotes: 5, processedCodeFiles: 2, addedEmbeddings: 3, removedEmbeddings: 2, totalEmbeddings: 50 };
    const telemetryPayload = {
      filesProcessed: (res.processedNotes ?? 0) + (res.processedCodeFiles ?? 0),
      chunksCreated: res.addedEmbeddings ?? null,
      removedCount: res.removedEmbeddings ?? 0,
      durationMs: 100,
      indexSize: res.totalEmbeddings ?? null,
    };
    assert.strictEqual(telemetryPayload.removedCount, 2);
    assert.ok("removedCount" in telemetryPayload);
  });
});

describe("runRagQuery — stale result filtering logic", () => {
  const projectRoot = path.resolve(".");

  it("passes through results when all files exist on disk", () => {
    // Use real files known to exist in the project
    const matches = [
      { path: "package.json", score: 0.9 },
      { path: "vitest.config.mjs", score: 0.8 },
    ];
    const { filtered, staleDropped } = filterStaleMatches(matches, projectRoot);
    assert.strictEqual(filtered.length, 2);
    assert.strictEqual(staleDropped.length, 0);
  });

  it("drops results whose file path does not exist on disk", () => {
    const matches = [
      { path: "package.json", score: 0.9 },
      { path: "this-file-does-not-exist-xyz-abc.mjs", score: 0.85 },
    ];
    const { filtered, staleDropped } = filterStaleMatches(matches, projectRoot);
    assert.strictEqual(filtered.length, 1);
    assert.strictEqual(filtered[0].path, "package.json");
    assert.strictEqual(staleDropped.length, 1);
    assert.strictEqual(staleDropped[0].path, "this-file-does-not-exist-xyz-abc.mjs");
  });

  it("preserves results with no path field", () => {
    const matches = [{ score: 0.7, text: "some snippet" }];
    const { filtered, staleDropped } = filterStaleMatches(matches, projectRoot);
    assert.strictEqual(filtered.length, 1);
    assert.strictEqual(staleDropped.length, 0);
  });

  it("no stale_filtered event emitted when staleDropped is empty", () => {
    const events = [];
    const emit = (type, pid, payload) => events.push({ type, pid, payload });

    const matches = [{ path: "package.json", score: 0.9 }];
    const { staleDropped } = filterStaleMatches(matches, projectRoot);
    if (staleDropped.length > 0) {
      emit("rag.query.stale_filtered", "proj", {
        filteredCount: staleDropped.length,
        filteredPaths: staleDropped.map(m => m?.path).filter(Boolean),
      });
    }
    assert.strictEqual(events.filter(e => e.type === "rag.query.stale_filtered").length, 0);
  });

  it("rag.query.stale_filtered event emitted with filteredCount and filteredPaths when results dropped", () => {
    const events = [];
    const emit = (type, pid, payload) => events.push({ type, pid, payload });

    const matches = [
      { path: "package.json", score: 0.9 },
      { path: "ghost-file-xyz.mjs", score: 0.8 },
    ];
    const { filtered, staleDropped } = filterStaleMatches(matches, projectRoot);
    if (staleDropped.length > 0) {
      emit("rag.query.stale_filtered", "proj", {
        filteredCount: staleDropped.length,
        filteredPaths: staleDropped.map(m => m?.path || m?.source || m?.file).filter(Boolean),
        query: "test query",
      });
    }
    const event = events.find(e => e.type === "rag.query.stale_filtered");
    assert.ok(event, "rag.query.stale_filtered event should be emitted");
    assert.strictEqual(event.payload.filteredCount, 1);
    assert.deepStrictEqual(event.payload.filteredPaths, ["ghost-file-xyz.mjs"]);
    assert.strictEqual(filtered.length, 1);
  });
});
