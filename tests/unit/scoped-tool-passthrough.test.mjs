/**
 * Tests for scoped-tool-passthrough — isFileInActiveScope helper
 * and hook passthrough checks.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");

function readSource(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), "utf8");
}

// Hooks live in read/ and write/ subdirs under hooks/ (on) or hooks.bak/ (off-rail).
// Check for actual tier subdirs so hooks.bak/ is selected during off-rail sessions.
function hooksDir() {
  const live = path.join(ROOT, ".routekit", "hooks");
  const bak = path.join(ROOT, ".routekit", "hooks.bak");
  if (fs.existsSync(path.join(live, "read")) || fs.existsSync(path.join(live, "write"))) return ".routekit/hooks";
  if (fs.existsSync(path.join(bak, "read")) || fs.existsSync(path.join(bak, "write"))) return ".routekit/hooks.bak";
  throw new Error("No tier subdirs found in .routekit/hooks or .routekit/hooks.bak");
}

// ── isFileInActiveScope unit tests ──────────────────────────────────────────

describe("isFileInActiveScope — guardrails-audit.mjs", async () => {
  const { isFileInActiveScope } = await import(
    path.join(ROOT, "packages/mcp-rks/src/server/guardrails-audit.mjs")
  );
  const tmpDir = path.join(ROOT, ".rks");
  const scopeFile = path.join(tmpDir, "active-scope.json");
  let originalContent;

  beforeEach(() => {
    try { originalContent = fs.readFileSync(scopeFile, "utf8"); } catch { originalContent = null; }
  });

  afterEach(() => {
    if (originalContent !== null) {
      fs.writeFileSync(scopeFile, originalContent, "utf8");
    } else {
      try { fs.unlinkSync(scopeFile); } catch {}
    }
  });

  it("returns true when filePath is in allowedFiles array", () => {
    fs.writeFileSync(scopeFile, JSON.stringify({
      allowedFiles: ["packages/mcp-rks/src/server/guardrails-audit.mjs"],
    }));
    const result = isFileInActiveScope(
      path.join(ROOT, "packages/mcp-rks/src/server/guardrails-audit.mjs"),
      ROOT
    );
    expect(result).toBe(true);
  });

  it("returns false when filePath is NOT in allowedFiles", () => {
    fs.writeFileSync(scopeFile, JSON.stringify({
      allowedFiles: ["packages/mcp-rks/src/server/guardrails-audit.mjs"],
    }));
    const result = isFileInActiveScope(
      path.join(ROOT, "packages/mcp-rks/src/server/exec.mjs"),
      ROOT
    );
    expect(result).toBe(false);
  });

  it("returns false when active-scope.json is missing (fail-open)", () => {
    try { fs.unlinkSync(scopeFile); } catch {}
    const result = isFileInActiveScope(
      path.join(ROOT, "packages/mcp-rks/src/server/guardrails-audit.mjs"),
      ROOT
    );
    expect(result).toBe(false);
  });

  it("returns false when active-scope.json has malformed JSON (fail-open)", () => {
    fs.writeFileSync(scopeFile, "{ not valid json }");
    const result = isFileInActiveScope(
      path.join(ROOT, "packages/mcp-rks/src/server/guardrails-audit.mjs"),
      ROOT
    );
    expect(result).toBe(false);
  });

  it("returns false when active-scope.json has no allowedFiles field (fail-open)", () => {
    fs.writeFileSync(scopeFile, JSON.stringify({ problemId: "test" }));
    const result = isFileInActiveScope(
      path.join(ROOT, "packages/mcp-rks/src/server/guardrails-audit.mjs"),
      ROOT
    );
    expect(result).toBe(false);
  });

  it("returns false when allowedFiles is empty array", () => {
    fs.writeFileSync(scopeFile, JSON.stringify({ allowedFiles: [] }));
    const result = isFileInActiveScope(
      path.join(ROOT, "packages/mcp-rks/src/server/guardrails-audit.mjs"),
      ROOT
    );
    expect(result).toBe(false);
  });
});

// ── Source-based hook passthrough verification ───────────────────────────────

describe("redirect-read-to-agent.mjs — active scope passthrough (source)", () => {
  const src = readSource(`${hooksDir()}/read/redirect-read-to-agent.mjs`);

  it("defines isFileInActiveScope helper", () => {
    expect(src).toMatch(/function isFileInActiveScope/);
  });

  it("reads SCOPE_FILE synchronously in isFileInActiveScope", () => {
    expect(src).toMatch(/readFileSync.*SCOPE_FILE/s);
    expect(src).toMatch(/allowedFiles/);
  });

  it("calls isFileInActiveScope with absolutePath before provenance check", () => {
    expect(src).toMatch(/isFileInActiveScope\(absolutePath\)/);
    const scopeIdx = src.indexOf("isFileInActiveScope(absolutePath)");
    const provenanceIdx = src.indexOf("hasValidProvenance(relativePath)");
    expect(scopeIdx).toBeGreaterThan(-1);
    expect(provenanceIdx).toBeGreaterThan(-1);
    expect(scopeIdx).toBeLessThan(provenanceIdx);
  });

  it("exits 0 when file is in active scope", () => {
    const idx = src.indexOf("isFileInActiveScope(absolutePath)");
    const snippet = src.slice(idx, idx + 60);
    expect(snippet).toMatch(/process\.exit\(0\)/);
  });

  it("isFileInActiveScope returns false on catch (fail-open)", () => {
    const helperStart = src.indexOf("function isFileInActiveScope");
    const helperEnd = src.indexOf("function loadRuntimePaths");
    const helperSrc = src.slice(helperStart, helperEnd);
    expect(helperSrc).toMatch(/catch.*return false/s);
  });
});

describe("redirect-edit-to-governor.mjs — active scope passthrough (source)", () => {
  const src = readSource(`${hooksDir()}/write/redirect-edit-to-governor.mjs`);

  it("imports fs and path", () => {
    expect(src).toMatch(/import fs from "fs"/);
    expect(src).toMatch(/import path from "path"/);
  });

  it("defines isFileInActiveScope helper", () => {
    expect(src).toMatch(/function isFileInActiveScope/);
  });

  it("calls isFileInActiveScope after filePath is set", () => {
    expect(src).toMatch(/isFileInActiveScope\(filePath\)/);
    const filePathIdx = src.indexOf("const filePath");
    const scopeIdx = src.lastIndexOf("isFileInActiveScope(filePath)");
    expect(scopeIdx).toBeGreaterThan(filePathIdx);
  });

  it("exits 0 when file is in active scope", () => {
    expect(src).toMatch(/if \(filePath && isFileInActiveScope\(filePath\)\).*process\.exit\(0\)/s);
  });
});

describe("redirect-glob-to-agent.mjs — active scope passthrough (source)", () => {
  const src = readSource(`${hooksDir()}/read/redirect-glob-to-agent.mjs`);

  it("imports fs and path", () => {
    expect(src).toMatch(/import fs from "fs"/);
    expect(src).toMatch(/import path from "path"/);
  });

  it("defines isPathInActiveScope helper", () => {
    expect(src).toMatch(/function isPathInActiveScope/);
  });

  it("calls isPathInActiveScope with searchPath", () => {
    expect(src).toMatch(/isPathInActiveScope\(searchPath\)/);
  });

  it("exits 0 when path is in active scope", () => {
    expect(src).toMatch(/if \(isPathInActiveScope\(searchPath\)\).*process\.exit\(0\)/s);
  });

  it("isPathInActiveScope checks if allowedFile starts with searchPath (directory match)", () => {
    const helperStart = src.indexOf("function isPathInActiveScope");
    const helperEnd = src.indexOf("\nasync function main");
    const helperSrc = src.slice(helperStart, helperEnd);
    expect(helperSrc).toMatch(/startsWith/);
  });
});

describe("redirect-grep-to-agent.mjs — active scope passthrough (source)", () => {
  const src = readSource(`${hooksDir()}/read/redirect-grep-to-agent.mjs`);

  it("imports fs and path", () => {
    expect(src).toMatch(/import fs from "fs"/);
    expect(src).toMatch(/import path from "path"/);
  });

  it("defines isPathInActiveScope helper", () => {
    expect(src).toMatch(/function isPathInActiveScope/);
  });

  it("calls isPathInActiveScope with searchPath", () => {
    expect(src).toMatch(/isPathInActiveScope\(searchPath\)/);
  });

  it("exits 0 when path is in active scope", () => {
    expect(src).toMatch(/if \(isPathInActiveScope\(searchPath\)\).*process\.exit\(0\)/s);
  });
});

describe("guardrails-audit.mjs — isFileInActiveScope export (source)", () => {
  const src = readSource("packages/mcp-rks/src/server/guardrails-audit.mjs");

  it("exports isFileInActiveScope", () => {
    expect(src).toMatch(/export function isFileInActiveScope/);
  });

  it("uses SCOPE_FILE constant", () => {
    const exportIdx = src.indexOf("export function isFileInActiveScope");
    const snippet = src.slice(exportIdx, exportIdx + 800);
    expect(snippet).toMatch(/SCOPE_FILE/);
  });

  it("returns false on catch (fail-open)", () => {
    const exportIdx = src.indexOf("export function isFileInActiveScope");
    const snippet = src.slice(exportIdx, exportIdx + 800);
    expect(snippet).toMatch(/catch/);
    expect(snippet).toMatch(/return false/);
  });

  it("checks Array.isArray on allowedFiles before using it", () => {
    const exportIdx = src.indexOf("export function isFileInActiveScope");
    const snippet = src.slice(exportIdx, exportIdx + 800);
    expect(snippet).toMatch(/Array\.isArray/);
  });
});
