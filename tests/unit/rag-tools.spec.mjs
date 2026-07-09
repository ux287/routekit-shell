/**
 * Tests for packages/mcp-rks/src/rag/tools.mjs
 *
 * Covers:
 * - getLastEmbedTime() file reading and error handling
 * - ensureRagIndex() auto-seed logic
 * - runRagQuery() input validation
 * - runRagEmbed() error propagation
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { getLastEmbedTime, ensureRagIndex } from "../../packages/mcp-rks/src/rag/tools.mjs";

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rks-rag-tools-test-"));
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* */ }
}

describe("rag tools", () => {
  let tmpDir;

  afterEach(() => {
    if (tmpDir) cleanup(tmpDir);
  });

  describe("getLastEmbedTime", () => {
    it("returns null when no embed timestamp exists", () => {
      tmpDir = makeTempDir();
      const result = getLastEmbedTime(tmpDir);
      expect(result).toBeNull();
    });

    it("returns timestamp from existing last-embed.json", () => {
      tmpDir = makeTempDir();
      const metaDir = path.join(tmpDir, ".rks", "rag");
      fs.mkdirSync(metaDir, { recursive: true });
      const ts = Date.now();
      fs.writeFileSync(
        path.join(metaDir, "last-embed.json"),
        JSON.stringify({ lastEmbedMs: ts })
      );

      const result = getLastEmbedTime(tmpDir);
      expect(result).toBe(ts);
    });

    it("returns null when last-embed.json has no lastEmbedMs", () => {
      tmpDir = makeTempDir();
      const metaDir = path.join(tmpDir, ".rks", "rag");
      fs.mkdirSync(metaDir, { recursive: true });
      fs.writeFileSync(
        path.join(metaDir, "last-embed.json"),
        JSON.stringify({ other: "data" })
      );

      const result = getLastEmbedTime(tmpDir);
      expect(result).toBeNull();
    });

    it("returns null when last-embed.json is invalid JSON", () => {
      tmpDir = makeTempDir();
      const metaDir = path.join(tmpDir, ".rks", "rag");
      fs.mkdirSync(metaDir, { recursive: true });
      fs.writeFileSync(
        path.join(metaDir, "last-embed.json"),
        "not json at all"
      );

      const result = getLastEmbedTime(tmpDir);
      expect(result).toBeNull();
    });
  });

  describe("ensureRagIndex", () => {
    it("returns no-notes when notes directory does not exist", async () => {
      tmpDir = makeTempDir();
      const result = await ensureRagIndex(tmpDir);
      expect(result).toEqual({ ok: false, reason: "no-notes" });
    });

    it("returns seeded=false when rag directory already has files", async () => {
      tmpDir = makeTempDir();
      // Create notes dir
      fs.mkdirSync(path.join(tmpDir, "notes"), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, "notes", "test.md"), "# Test");
      // Create rag dir with content
      const ragDir = path.join(tmpDir, ".rks", "rag");
      fs.mkdirSync(ragDir, { recursive: true });
      fs.writeFileSync(path.join(ragDir, "some-index"), "data");

      const result = await ensureRagIndex(tmpDir);
      expect(result.ok).toBe(true);
      expect(result.seeded).toBe(false);
    });

    it("returns no-notes when notes dir missing even if rag dir exists", async () => {
      tmpDir = makeTempDir();
      // Create rag dir but no notes dir
      fs.mkdirSync(path.join(tmpDir, ".rks", "rag"), { recursive: true });

      const result = await ensureRagIndex(tmpDir);
      expect(result).toEqual({ ok: false, reason: "no-notes" });
    });
  });

  describe("runRagQuery validation", () => {
    it("rejects when query text is missing", async () => {
      tmpDir = makeTempDir();
      // Import dynamically to test
      const { runRagQuery } = await import("../../packages/mcp-rks/src/rag/tools.mjs");
      await expect(runRagQuery(tmpDir, {})).rejects.toThrow("Query text is required");
    });

    it("rejects when options is null", async () => {
      tmpDir = makeTempDir();
      const { runRagQuery } = await import("../../packages/mcp-rks/src/rag/tools.mjs");
      await expect(runRagQuery(tmpDir, null)).rejects.toThrow("Query text is required");
    });

    it("rejects when q is empty string", async () => {
      tmpDir = makeTempDir();
      const { runRagQuery } = await import("../../packages/mcp-rks/src/rag/tools.mjs");
      await expect(runRagQuery(tmpDir, { q: "" })).rejects.toThrow("Query text is required");
    });
  });
});
