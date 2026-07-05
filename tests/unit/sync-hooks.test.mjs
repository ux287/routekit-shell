import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { syncHooks, checkDrift, listFilesRecursive } from "../../scripts/sync-hooks.mjs";

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../scripts/sync-hooks.mjs");

function tmpDir(prefix) {
  return mkdtempSync(path.join(os.tmpdir(), `rks-synchooks-${prefix}-`));
}

function write(p, content = "stub") {
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, content, "utf8");
}

function buildSrc(dir) {
  write(path.join(dir, "write", "enforce-plan-scope.mjs"), "// enforce-plan-scope");
  write(path.join(dir, "read", "monitor-context.mjs"), "// monitor-context");
  write(path.join(dir, "system", "guardrails-gate.mjs"), "// guardrails-gate");
}

describe("syncHooks()", () => {
  let src, dest;

  beforeEach(() => {
    src = tmpDir("src");
    dest = tmpDir("dest");
    buildSrc(src);
  });

  afterEach(() => {
    rmSync(src, { recursive: true, force: true });
    rmSync(dest, { recursive: true, force: true });
  });

  it("copies all files from src to dest", () => {
    syncHooks(src, dest);
    expect(existsSync(path.join(dest, "write", "enforce-plan-scope.mjs"))).toBe(true);
    expect(existsSync(path.join(dest, "read", "monitor-context.mjs"))).toBe(true);
    expect(existsSync(path.join(dest, "system", "guardrails-gate.mjs"))).toBe(true);
  });

  it("exact content match after sync", () => {
    syncHooks(src, dest);
    expect(readFileSync(path.join(dest, "write", "enforce-plan-scope.mjs"), "utf8")).toBe("// enforce-plan-scope");
  });

  it("returns list of all synced files", () => {
    const files = syncHooks(src, dest);
    expect(Array.isArray(files)).toBe(true);
    expect(files.length).toBe(3);
    expect(files).toContain(path.join("write", "enforce-plan-scope.mjs"));
    expect(files).toContain(path.join("read", "monitor-context.mjs"));
  });

  it("is idempotent: running twice produces same content", () => {
    syncHooks(src, dest);
    const content1 = readFileSync(path.join(dest, "write", "enforce-plan-scope.mjs"), "utf8");
    syncHooks(src, dest);
    const content2 = readFileSync(path.join(dest, "write", "enforce-plan-scope.mjs"), "utf8");
    expect(content2).toBe(content1);
  });

  it("overwrites stale content in dest on second run", () => {
    syncHooks(src, dest);
    writeFileSync(path.join(dest, "write", "enforce-plan-scope.mjs"), "STALE");
    syncHooks(src, dest);
    expect(readFileSync(path.join(dest, "write", "enforce-plan-scope.mjs"), "utf8")).toBe("// enforce-plan-scope");
  });
});

describe("checkDrift()", () => {
  let src, dest;

  beforeEach(() => {
    src = tmpDir("src");
    dest = tmpDir("dest");
    buildSrc(src);
  });

  afterEach(() => {
    rmSync(src, { recursive: true, force: true });
    rmSync(dest, { recursive: true, force: true });
  });

  it("returns ok when dirs are identical", () => {
    syncHooks(src, dest);
    const result = checkDrift(src, dest);
    expect(result.ok).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it("detects file missing from dest", () => {
    syncHooks(src, dest);
    rmSync(path.join(dest, "system", "guardrails-gate.mjs"));
    const result = checkDrift(src, dest);
    expect(result.ok).toBe(false);
    expect(result.issues.some(i => i.includes("guardrails-gate.mjs"))).toBe(true);
  });

  it("detects extra file in dest", () => {
    syncHooks(src, dest);
    write(path.join(dest, "write", "extra-hook.mjs"), "// extra");
    const result = checkDrift(src, dest);
    expect(result.ok).toBe(false);
    expect(result.issues.some(i => i.includes("extra-hook.mjs"))).toBe(true);
  });

  it("detects content difference", () => {
    syncHooks(src, dest);
    writeFileSync(path.join(dest, "read", "monitor-context.mjs"), "// DIFFERENT");
    const result = checkDrift(src, dest);
    expect(result.ok).toBe(false);
    expect(result.issues.some(i => i.includes("monitor-context.mjs"))).toBe(true);
  });

  it("reports correct counts", () => {
    syncHooks(src, dest);
    const result = checkDrift(src, dest);
    expect(result.srcCount).toBe(3);
    expect(result.destCount).toBe(3);
  });
});

describe("sync-hooks.mjs CLI --check mode", () => {
  it("exits 0 when packages/hooks and templates/generic/.routekit/hooks are in sync", () => {
    const result = spawnSync(process.execPath, [SCRIPT, "--check"], {
      encoding: "utf8",
      timeout: 15_000,
      cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."),
    });
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toContain("No drift");
  });
});

describe("listFilesRecursive()", () => {
  let dir;

  beforeEach(() => { dir = tmpDir("list"); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("returns sorted relative paths", () => {
    write(path.join(dir, "b.mjs"), "b");
    write(path.join(dir, "sub", "a.mjs"), "a");
    const files = listFilesRecursive(dir);
    expect(files).toEqual(["b.mjs", path.join("sub", "a.mjs")]);
  });

  it("returns empty array for non-existent directory", () => {
    expect(listFilesRecursive(path.join(dir, "nonexistent"))).toEqual([]);
  });
});
