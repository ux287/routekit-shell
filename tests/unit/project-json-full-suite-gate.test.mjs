/**
 * backlog.chore.enable-repo-guard-ship-gate
 *
 * The repo's own .rks/project.json enables the scoped ship gate (fullSuiteGate.testPaths)
 * with the repo-wide guard tests, and every listed path ships to the rks-public mirror.
 * No subprocesses are spawned.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import yaml from "js-yaml";
import { applyExclude } from "../../packages/mcp-rks/src/server/publish.mjs";
import { resolveFullSuiteGateConfig } from "../../packages/mcp-rks/src/exec/full-suite-gate.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const pj = JSON.parse(fs.readFileSync(path.join(repoRoot, ".rks", "project.json"), "utf8"));
const gate = pj.fullSuiteGate;
const testPaths = (gate && Array.isArray(gate.testPaths)) ? gate.testPaths : [];
const TRIAGE = "tests/unit/telemetry-global-mock-triage.test.mjs";
const SELF = "tests/unit/project-json-full-suite-gate.test.mjs";

describe("repo fullSuiteGate config", () => {
  it("declares enabled true, no command, and testPaths including the triage guard", () => {
    expect(typeof gate).toBe("object");
    expect(gate).not.toBeNull();
    expect(Array.isArray(gate)).toBe(false);
    expect(gate.enabled).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(gate, "command")).toBe(false);
    expect(Array.isArray(gate.testPaths)).toBe(true);
    expect(gate.testPaths.length).toBeGreaterThan(0);
    expect(gate.testPaths).toContain(TRIAGE);
  });

  it("every testPaths entry is a repo-relative existing file", () => {
    expect(testPaths.length).toBeGreaterThan(0);
    for (const entry of testPaths) {
      expect(typeof entry, String(entry)).toBe("string");
      expect(path.isAbsolute(entry), entry).toBe(false);
      expect(entry.split(/[\\/]/).includes(".."), entry).toBe(false);
      const abs = path.join(repoRoot, entry);
      expect(fs.existsSync(abs) && fs.statSync(abs).isFile(), entry).toBe(true);
    }
  });

  it("resolveFullSuiteGateConfig on the repo root returns the enabled scoped config", () => {
    const cfg = resolveFullSuiteGateConfig(repoRoot);
    expect(cfg.enabled).toBe(true);
    expect(cfg.misconfigured).toBeUndefined();
    expect(cfg.testPaths).toEqual([...new Set(testPaths)]);
  });

  it("fullSuiteGate is the last top-level key, immediately after onboarder", () => {
    const keys = Object.keys(pj);
    expect(keys[keys.length - 1]).toBe("fullSuiteGate");
    expect(keys[keys.length - 2]).toBe("onboarder");
  });
});

describe("repo fullSuiteGate public mirror", () => {
  const profiles = yaml.load(fs.readFileSync(path.join(repoRoot, ".routekit", "publish-profiles.yaml"), "utf8"));
  const rksPublic = profiles.profiles["rks-public"];

  it("every testPaths entry survives the rks-public exclude list", () => {
    expect(testPaths.length).toBeGreaterThan(0);
    expect(applyExclude([...testPaths], rksPublic.exclude)).toEqual([...testPaths]);
  });

  it("this test file survives the rks-public exclude list", () => {
    expect(applyExclude([SELF], rksPublic.exclude)).toEqual([SELF]);
  });
});
