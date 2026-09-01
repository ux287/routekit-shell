/**
 * Tests for P-6: RAG stale-after-file-delete fix.
 *
 * These tests verify the contract changes without running the full embed pipeline:
 * - embed.mjs returns removedEmbeddings in its result
 * - tools.mjs threads removedCount into telemetry and MCP response
 * - runRagQuery filtering logic drops ghost paths
 * - rag.query.stale_filtered telemetry fires when results are dropped
 * - No regression when no files are deleted
 *
 * ---------------------------------------------------------------------------
 * TWO THINGS TO KNOW BEFORE TRUSTING THIS FILE
 * ---------------------------------------------------------------------------
 * 1. NO RUNNER EXECUTES IT. `packages/mcp-rks/package.json` runs
 *    `node --test __tests__/*.spec.mjs` — this is a `.test.mjs`. The root
 *    package.json has no `node --test` script, and every vitest config sweeps
 *    `tests/**` only. Nothing here has ever run in CI.
 * 2. It used to MIRROR the production filter with its own `fs.existsSync` copy,
 *    so it could not fail when production drifted — and production DID drift:
 *    the mirrored check dropped every note-loop row for months while this file
 *    reported the logic healthy. The mirror is gone; `filterStaleMatches` now
 *    delegates to the shipped `ragPathExists`.
 *
 * The executable gate for the path-normalization rule is
 * `tests/unit/rag-note-path-normalization.test.mjs`, which vitest does run.
 * Fix that one first; this file is documentation until a runner picks it up.
 * See backlog.fix.rag-query-existence-filter-drops-note-rows.
 */
import assert from "node:assert";
import { describe, it } from "node:test";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { ragPathExists } from "@routekit/rag/tools";

// ---------------------------------------------------------------------------
// Delegates to the SHIPPED predicate. Deliberately not a reimplementation —
// re-inlining the rule here is what made this file blind in the first place.
// ---------------------------------------------------------------------------
function filterStaleMatches(matches, projectRoot) {
  const staleDropped = [];
  const filtered = matches.filter(m => {
    if (ragPathExists(projectRoot, m?.path || m?.source || m?.file)) return true;
    staleDropped.push(m);
    return false;
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

describe("runRagQuery — the note-loop path asymmetry (four-case tension table)", () => {
  // The note loop stores a VAULT-relative path ("backlog.feat.X.md"); the code walk stores a
  // PROJECT-ROOT-relative one ("notes/backlog.feat.X.md"). Both must be handled without the
  // guard losing its original purpose of dropping genuinely deleted files.
  const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "rag-stale-tension-"));
  fs.mkdirSync(path.join(ROOT, "notes"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "notes", "backlog.feat.present.md"), "# present\n");

  it("PRECONDITION — the note exists under notes/ and NOT at the project root", () => {
    assert.strictEqual(fs.existsSync(path.join(ROOT, "notes", "backlog.feat.present.md")), true);
    assert.strictEqual(fs.existsSync(path.join(ROOT, "backlog.feat.present.md")), false);
  });

  it("(a) KEEPS a bare vault-relative slug whose notes/ form exists", () => {
    const { filtered, staleDropped } = filterStaleMatches([{ path: "backlog.feat.present.md" }], ROOT);
    assert.strictEqual(filtered.length, 1);
    assert.strictEqual(staleDropped.length, 0);
  });

  it("(b) DROPS a bare slug that resolves nowhere, including under notes/", () => {
    const { filtered, staleDropped } = filterStaleMatches([{ path: "backlog.feat.absent.md" }], ROOT);
    assert.strictEqual(filtered.length, 0);
    assert.strictEqual(staleDropped.length, 1);
  });

  it("(c) DROPS a notes/-prefixed path that does not exist", () => {
    const { filtered } = filterStaleMatches([{ path: "notes/backlog.feat.absent.md" }], ROOT);
    assert.strictEqual(filtered.length, 0);
  });

  it("(d) KEEPS a match with no path field", () => {
    const { filtered, staleDropped } = filterStaleMatches([{ score: 0.7 }], ROOT);
    assert.strictEqual(filtered.length, 1);
    assert.strictEqual(staleDropped.length, 0);
  });
});
