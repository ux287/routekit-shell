import { describe, it, expect } from "vitest";
import path from "path";

// Test the implicit directory computation logic
const computeImplicitDirs = (expectedFiles) => {
  const dirs = new Set();
  for (const filePath of expectedFiles) {
    let dir = path.dirname(filePath);
    while (dir && dir !== '.' && dir !== '/') {
      dirs.add(dir);
      dirs.add(dir + '/');
      dir = path.dirname(dir);
    }
  }
  return dirs;
};

describe("computeImplicitDirs", () => {
  it("computes parent directories from expected files", () => {
    const expected = ["src/new/file.js"];
    const dirs = computeImplicitDirs(expected);
    
    expect(dirs.has("src/new")).toBe(true);
    expect(dirs.has("src/new/")).toBe(true);
    expect(dirs.has("src")).toBe(true);
    expect(dirs.has("src/")).toBe(true);
  });

  it("does not include unrelated directories", () => {
    const expected = ["src/file.js"];
    const dirs = computeImplicitDirs(expected);
    
    expect(dirs.has("src/other")).toBe(false);
    expect(dirs.has("lib")).toBe(false);
  });

  it("handles deeply nested paths", () => {
    const expected = ["packages/mcp-rks/src/server/exec.mjs"];
    const dirs = computeImplicitDirs(expected);
    
    expect(dirs.has("packages/mcp-rks/src/server")).toBe(true);
    expect(dirs.has("packages/mcp-rks/src")).toBe(true);
    expect(dirs.has("packages/mcp-rks")).toBe(true);
    expect(dirs.has("packages")).toBe(true);
  });

  it("handles multiple files with shared parents", () => {
    const expected = ["src/a/file1.js", "src/b/file2.js"];
    const dirs = computeImplicitDirs(expected);
    
    expect(dirs.has("src/a")).toBe(true);
    expect(dirs.has("src/b")).toBe(true);
    expect(dirs.has("src")).toBe(true);
  });
});