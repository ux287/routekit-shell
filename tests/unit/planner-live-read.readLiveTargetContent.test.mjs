import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { readLiveTargetContent, parseLineRangeFromSnippet } from "../../packages/mcp-rks/src/server/planner-live-read.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rks-live-read-test-"));
}

function writeFile(dir, relPath, content) {
  const abs = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
  return abs;
}

function makeLines(n) {
  return Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n");
}

// ---------------------------------------------------------------------------
// parseLineRangeFromSnippet
// ---------------------------------------------------------------------------

describe("parseLineRangeFromSnippet", () => {
  it("parses en-dash range comment", () => {
    const snippet = `// Context: function body for "displayActions" (lines 234–317 of 1332)\nconst x = 1;`;
    const result = parseLineRangeFromSnippet(snippet);
    expect(result).toEqual({ startLine: 234, endLine: 317 });
  });

  it("parses hyphen range comment", () => {
    const snippet = `// Context: function body for "foo" (lines 10-50 of 200)\nconst y = 2;`;
    const result = parseLineRangeFromSnippet(snippet);
    expect(result).toEqual({ startLine: 10, endLine: 50 });
  });

  it("returns null for snippet with no context comment", () => {
    const snippet = `const foo = () => {};`;
    expect(parseLineRangeFromSnippet(snippet)).toBeNull();
  });

  it("returns null for null input", () => {
    expect(parseLineRangeFromSnippet(null)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseLineRangeFromSnippet("")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// readLiveTargetContent
// ---------------------------------------------------------------------------

describe("readLiveTargetContent", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null when file does not exist on disk", () => {
    const result = readLiveTargetContent(tmpDir, "does-not-exist.ts", []);
    expect(result).toBeNull();
  });

  it("returns full file content for a small file (no snippets)", () => {
    const content = "const a = 1;\nconst b = 2;\n";
    writeFile(tmpDir, "src/small.ts", content);
    const result = readLiveTargetContent(tmpDir, "src/small.ts", []);
    expect(result).not.toBeNull();
    expect(result.content).toBe(content);
    expect(result.source).toBe("full-file");
    expect(result.startLine).toBe(1);
    expect(result.totalLines).toBeGreaterThan(0);
  });

  it("returns full file content for a small file even when snippets are provided", () => {
    const content = makeLines(50); // 50 lines — below threshold
    writeFile(tmpDir, "src/tiny.ts", content);
    const snippet = `// Context: function body for "foo" (lines 10-30 of 50)\nconst x = 1;`;
    const result = readLiveTargetContent(tmpDir, "src/tiny.ts", [snippet]);
    expect(result.source).toBe("full-file");
    expect(result.startLine).toBe(1);
  });

  it("returns verbatim disk content — content matches actual file", () => {
    const content = "export function hello() {\n  return 42;\n}\n";
    writeFile(tmpDir, "src/hello.ts", content);
    const result = readLiveTargetContent(tmpDir, "src/hello.ts", []);
    expect(result.content).toBe(content);
  });

  it("uses RAG snippet line hints to perform a targeted line-range read for large files", () => {
    // 400-line file — above SMALL_FILE_THRESHOLD (300)
    const lines = Array.from({ length: 400 }, (_, i) => `// line ${i + 1}`);
    writeFile(tmpDir, "src/large.ts", lines.join("\n"));

    const snippet = `// Context: function body for "bar" (lines 180–220 of 400)\nconst bar = () => {};`;
    const result = readLiveTargetContent(tmpDir, "src/large.ts", [snippet]);

    expect(result.source).toBe("line-range");
    expect(result.startLine).toBeLessThanOrEqual(180);
    expect(result.endLine).toBeGreaterThanOrEqual(220);
    // Should not include lines far outside the range
    expect(result.endLine).toBeLessThan(400);
    // Content should include the target area
    expect(result.content).toContain("// line 180");
    expect(result.content).toContain("// line 220");
  });

  it("falls back to full-file for a large file when snippets have no line hints", () => {
    const lines = Array.from({ length: 400 }, (_, i) => `// line ${i + 1}`);
    writeFile(tmpDir, "src/large2.ts", lines.join("\n"));

    const snippet = `export const foo = () => "no context comment here";`;
    const result = readLiveTargetContent(tmpDir, "src/large2.ts", [snippet]);

    expect(result.source).toBe("full-file");
    expect(result.startLine).toBe(1);
    expect(result.totalLines).toBe(400);
  });

  it("returns line provenance metadata (startLine, endLine, totalLines)", () => {
    const content = makeLines(10);
    writeFile(tmpDir, "src/meta.ts", content);
    const result = readLiveTargetContent(tmpDir, "src/meta.ts", []);
    expect(typeof result.startLine).toBe("number");
    expect(typeof result.endLine).toBe("number");
    expect(typeof result.totalLines).toBe("number");
    expect(result.endLine).toBeGreaterThanOrEqual(result.startLine);
    expect(result.totalLines).toBeGreaterThanOrEqual(result.endLine);
  });

  it("unions multiple snippet line ranges for a large file", () => {
    const lines = Array.from({ length: 500 }, (_, i) => `// line ${i + 1}`);
    writeFile(tmpDir, "src/multi.ts", lines.join("\n"));

    const snippets = [
      `// Context: function body for "foo" (lines 50–80 of 500)\nfoo`,
      `// Context: function body for "bar" (lines 200–240 of 500)\nbar`,
    ];
    const result = readLiveTargetContent(tmpDir, "src/multi.ts", snippets);

    expect(result.source).toBe("line-range");
    // Should cover both ranges (50-80 and 200-240) unioned
    expect(result.startLine).toBeLessThanOrEqual(50);
    expect(result.endLine).toBeGreaterThanOrEqual(240);
  });
});
