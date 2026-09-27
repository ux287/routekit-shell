import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveInstallCommand,
  detectEcosystem,
  runDependencyInstall,
} from "../../packages/cli/src/project/bootstrap.mjs";

// backlog.feat.scaffold-runs-npm-install — Concern B (the install MECHANISM).
//
// Fast, deterministic coverage: runDependencyInstall is dependency-injected with
// a spawn spy, so NO live `npm install` runs here. The slow live
// scaffold -> install -> runs path is intentionally NOT exercised (it would be a
// slow subprocess); the injected spy proves the command, cwd, timeout, and the
// non-fatal contract deterministically.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("ecosystem resolver (npm-only, shaped to extend)", () => {
  it("resolves the node ecosystem to `npm install --no-audit --no-fund`", () => {
    expect(resolveInstallCommand("node")).toEqual({
      cmd: "npm",
      args: ["install", "--no-audit", "--no-fund"],
    });
  });

  it("has NO pip/cargo branch — unknown ecosystems resolve to null", () => {
    expect(resolveInstallCommand("python")).toBeNull();
    expect(resolveInstallCommand("rust")).toBeNull();
    expect(resolveInstallCommand(undefined)).toBeNull();
  });

  it("detects node from a package.json, null from a bare dir", () => {
    const withPkg = fs.mkdtempSync(path.join(os.tmpdir(), "rks-eco-pkg-"));
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), "rks-eco-bare-"));
    try {
      fs.writeFileSync(path.join(withPkg, "package.json"), "{}");
      expect(detectEcosystem(withPkg)).toBe("node");
      expect(detectEcosystem(bare)).toBeNull();
    } finally {
      fs.rmSync(withPkg, { recursive: true, force: true });
      fs.rmSync(bare, { recursive: true, force: true });
    }
  });
});

describe("runDependencyInstall — invocation + non-fatal contract", () => {
  let tmp;
  let warnSpy;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rks-install-"));
    fs.writeFileSync(path.join(tmp, "package.json"), "{}");
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("invokes the resolved install once with cwd=projectRoot and timeout 180000", () => {
    const spawnSpy = vi.fn(() => ({ status: 0 }));
    const res = runDependencyInstall(tmp, { spawn: spawnSpy });
    expect(spawnSpy).toHaveBeenCalledTimes(1);
    expect(spawnSpy).toHaveBeenCalledWith(
      "npm",
      ["install", "--no-audit", "--no-fund"],
      expect.objectContaining({ cwd: tmp, timeout: 180000 }),
    );
    expect(res).toEqual({ ran: true, ok: true });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("does NOT install when no ecosystem is detected (no package.json)", () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), "rks-install-bare-"));
    const spawnSpy = vi.fn();
    try {
      const res = runDependencyInstall(bare, { spawn: spawnSpy });
      expect(spawnSpy).not.toHaveBeenCalled();
      expect(res).toEqual({ ran: false });
    } finally {
      fs.rmSync(bare, { recursive: true, force: true });
    }
  });

  it("non-zero exit is non-fatal: warns, returns ok:false, does not throw", () => {
    const spawnSpy = vi.fn(() => ({ status: 1, stderr: "boom" }));
    const res = runDependencyInstall(tmp, { spawn: spawnSpy });
    expect(res).toEqual({ ran: true, ok: false });
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("a timeout (status null) is non-fatal: warns, returns ok:false", () => {
    const spawnSpy = vi.fn(() => ({ status: null }));
    const res = runDependencyInstall(tmp, { spawn: spawnSpy });
    expect(res).toEqual({ ran: true, ok: false });
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("a spawn throw (e.g. npm not found) is non-fatal: caught, warns, no throw", () => {
    const spawnSpy = vi.fn(() => {
      throw new Error("ENOENT npm");
    });
    const res = runDependencyInstall(tmp, { spawn: spawnSpy });
    expect(res).toEqual({ ran: true, ok: false, threw: true });
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});

describe("init.mjs printed guidance matches auto-install behavior", () => {
  it("the nextSteps array no longer prints `npm install`, keeps cd + Claude Code", () => {
    const initSrc = fs.readFileSync(
      path.join(repoRoot, "packages", "mcp-rks", "src", "server", "init.mjs"),
      "utf8",
    );
    const m = initSrc.match(/const nextSteps = \[([\s\S]*?)\];/);
    expect(m, "nextSteps array present").not.toBeNull();
    const block = m[1];
    expect(block).not.toMatch(/['"`]npm install['"`]/);
    expect(block).toMatch(/cd \$\{projectPath\}/);
    expect(block).toMatch(/Claude Code/);
  });
});
