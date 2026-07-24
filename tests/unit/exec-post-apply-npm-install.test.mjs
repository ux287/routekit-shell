import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { shouldInstallDeps } from "../../packages/mcp-rks/src/server/exec.mjs";

// backlog.fix.exec-post-apply-npm-install
//
// rks_exec runs a bounded best-effort `npm install` after applying a plan and BEFORE the post-apply
// test phase, so a plan that adds a dependency (e.g. a test runner) gets it installed in the
// governed flow — no off-rail detour (the uat-calc-0629-3 failure: package.json applied, then tests
// died on "Cannot find package 'vitest'"). These assertions pin the gating predicate; the install
// block's non-fatal / timeout / telemetry behavior is verified by ARCH against source (spawnSync
// returns rather than throws, timeout:180000, emit wrapped in try/catch) and is not unit-exercised
// here to avoid a real 180s npm run.

describe("shouldInstallDeps — governed dependency-install gate", () => {
  const withNodeModules = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "rks-deps-"));
    fs.writeFileSync(path.join(d, "package.json"), "{}");
    fs.mkdirSync(path.join(d, "node_modules"));
    return d;
  };
  const pkgNoNodeModules = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "rks-deps-pkg-"));
    fs.writeFileSync(path.join(d, "package.json"), "{}");
    return d;
  };
  const trulyBare = () => fs.mkdtempSync(path.join(os.tmpdir(), "rks-deps-bare-"));
  const rm = (d) => fs.rmSync(d, { recursive: true, force: true });

  it("returns true when package.json is in appliedFiles (a dependency was added/changed)", () => {
    const root = withNodeModules();
    try {
      expect(shouldInstallDeps(["src/engine.ts", "package.json"], root)).toBe(true);
    } finally { rm(root); }
  });

  it("returns false when package.json is NOT applied and node_modules exists (no needless install)", () => {
    const root = withNodeModules();
    try {
      expect(shouldInstallDeps(["src/engine.ts", "tests/engine.test.ts"], root)).toBe(false);
    } finally { rm(root); }
  });

  it("returns true when node_modules is missing but a package.json exists (deps never installed)", () => {
    const root = pkgNoNodeModules();
    try {
      expect(shouldInstallDeps(["src/engine.ts"], root)).toBe(true);
    } finally { rm(root); }
  });

  it("returns false for a bare dir with no package.json (nothing to install)", () => {
    const root = trulyBare();
    try {
      expect(shouldInstallDeps(["src/engine.ts"], root)).toBe(false);
    } finally { rm(root); }
  });

  it("matches a nested package.json path as well", () => {
    const root = withNodeModules();
    try {
      expect(shouldInstallDeps(["packages/web/package.json"], root)).toBe(true);
    } finally { rm(root); }
  });

  it("handles empty/undefined/null appliedFiles gracefully (falls back to package.json + node_modules state)", () => {
    const wn = withNodeModules();
    const pnm = pkgNoNodeModules();
    try {
      expect(shouldInstallDeps([], wn)).toBe(false);
      expect(shouldInstallDeps(undefined, pnm)).toBe(true);
      expect(shouldInstallDeps(null, wn)).toBe(false);
    } finally { rm(wn); rm(pnm); }
  });
});
