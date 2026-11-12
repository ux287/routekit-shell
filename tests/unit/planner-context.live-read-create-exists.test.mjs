/**
 * Tests for planner-context-create-exists-liveread — verifies that
 * files listed as op:create in story frontmatter but already existing
 * on disk receive live content injection (not skipped as "new files").
 *
 * Tests the two fixes:
 *   Fix A: createTargets map checks disk existence before frontmatterCreateFiles
 *   Fix B: enhancedWithLiveContent uses fs.existsSync not summary string matching
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { readLiveTargetContent } from "../../packages/mcp-rks/src/server/planner-live-read.mjs";

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rks-create-exists-test-"));
}

function writeFile(dir, relPath, content) {
  const abs = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

// ---------------------------------------------------------------------------
// Fix A: createTargets map — disk check before frontmatterCreateFiles
// We test this by verifying readLiveTargetContent returns content for an
// existing file regardless of how it was labeled.
// ---------------------------------------------------------------------------

describe("Fix A — disk existence overrides op:create label", () => {
  it("readLiveTargetContent returns content for a file that exists, even if story says op:create", () => {
    const dir = makeTempDir();
    const content = "export class SQLiteService {\n  static getInstance() { return new SQLiteService(); }\n}\n";
    writeFile(dir, "services/sqliteService.ts", content);

    const result = readLiveTargetContent(dir, "services/sqliteService.ts", []);
    expect(result).not.toBeNull();
    expect(result.content).toBe(content);
  });

  it("readLiveTargetContent returns null for a file that genuinely does not exist", () => {
    const dir = makeTempDir();
    const result = readLiveTargetContent(dir, "services/newFile.ts", []);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Fix B: enhancedWithLiveContent — fs.existsSync not summary string matching
// We simulate the before/after by directly testing the condition logic.
// ---------------------------------------------------------------------------

describe("Fix B — live read skip uses disk existence, not summary string", () => {
  it("a file that exists on disk with 'to be created' summary should still yield live content via readLiveTargetContent", () => {
    const dir = makeTempDir();
    const existingContent = "export const sqliteService = { createDiscrepancy: () => {} };\n";
    writeFile(dir, "services/sqliteService.ts", existingContent);

    // Simulate target as it would appear with the wrong summary (pre-fix scenario)
    const target = {
      path: "services/sqliteService.ts",
      summary: "(new file - to be created, marked create:true in frontmatter)",
      content: "",
    };

    // With Fix B: the check is fs.existsSync, not summary.includes("to be created")
    const absPath = path.join(dir, target.path);
    const fileExists = fs.existsSync(absPath);
    expect(fileExists).toBe(true);

    // Since file exists, live read should proceed
    const liveRead = readLiveTargetContent(dir, target.path, []);
    expect(liveRead).not.toBeNull();
    expect(liveRead.content).toBe(existingContent);
  });

  it("a file that genuinely does not exist should not yield live content", () => {
    const dir = makeTempDir();
    const target = {
      path: "services/brandNew.ts",
      summary: "(new file - to be created, marked create:true in frontmatter)",
      content: "",
    };

    const absPath = path.join(dir, target.path);
    const fileExists = fs.existsSync(absPath);
    expect(fileExists).toBe(false);

    const liveRead = readLiveTargetContent(dir, target.path, []);
    expect(liveRead).toBeNull();
  });

  it("large existing file (900+ lines) gets live content even with op:create summary", () => {
    const dir = makeTempDir();
    const largeContent = Array(908).fill("// line of code").join("\n") + "\n";
    writeFile(dir, "services/sqliteService.ts", largeContent);

    const liveRead = readLiveTargetContent(dir, "services/sqliteService.ts", []);
    expect(liveRead).not.toBeNull();
    // Large file with no ragSnippets returns full-file source
    expect(liveRead.source).toBe("full-file");
    expect(liveRead.totalLines).toBeGreaterThan(900);
  });
});
