/**
 * backlog.fix.exec-commit-set-protected-paths: the built-in governance floor and the
 * shared derivations that must never carry a governance path.
 *
 * testRequirement -> test mapping (TRn = the story's nth testRequirement):
 *   TR1  "is frozen and equals the four built-in prefixes in order"
 *   TR2  "matches every governance spelling with no .rks/protected-files.yml present"
 *   TR3  "does not match ordinary paths or look-alikes"
 *   TR4  "honours project patterns on top of the floor"
 *   TR5  "fails closed on non-string or empty input"
 *   TR6  "resolves the target against projectRoot before matching"
 *   TR7  "planDeclaredOutputs keeps only the non-governance entry"
 *   TR8  "computeCommitFiles never includes a declared governance path"
 *   TR9  "computeUnexpectedFiles flags a governance path even when produces declares it"
 * No subprocess is spawned in this file.
 */
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { makeTempDir } from "../helpers/tmp.mjs";
import { GOVERNANCE_PATH_PREFIXES, isGovernancePath, isGovernanceRelPath } from "../../packages/mcp-rks/src/exec/command-runner.mjs";
import { planDeclaredOutputs, computeUnexpectedFiles } from "../../packages/mcp-rks/src/server/test-runner.mjs";
import { loadProjectProtectedConfig } from "../../packages/mcp-rks/src/server/project.mjs";

const { computeCommitFiles } = await import("../../packages/mcp-rks/src/server/exec.mjs");

const roots = [];
const tempProject = () => {
  const root = makeTempDir("gov-path");
  roots.push(root);
  return root;
};
afterEach(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

describe("GOVERNANCE_PATH_PREFIXES", () => {
  it("is frozen and equals the four built-in prefixes in order", () => {
    expect(Object.isFrozen(GOVERNANCE_PATH_PREFIXES)).toBe(true);
    expect([...GOVERNANCE_PATH_PREFIXES]).toEqual([".routekit/", ".rks/", ".claude/", ".git/"]);
  });
});

describe("isGovernancePath", () => {
  it("matches every governance spelling with no .rks/protected-files.yml present", () => {
    const root = tempProject();
    expect(fs.existsSync(path.join(root, ".rks", "protected-files.yml"))).toBe(false);
    for (const p of [".routekit/hooks/x.mjs", ".rks/prompts/governor-po.md", ".claude/settings.json", ".git/config", ".routekit/command-policy.yaml", "./.rks/x", ".ROUTEKIT/x", ".rks\\x", ".rks", ".git"]) {
      expect(isGovernancePath(root, p), p).toBe(true);
    }
  });

  it("does not match ordinary paths or look-alikes", () => {
    const root = tempProject();
    expect(fs.existsSync(path.join(root, ".rks", "protected-files.yml"))).toBe(false);
    for (const p of ["dist/app.js", "notes/backlog.x.md", "docs/command-policy.yaml", ".rksx/a", "src/.rks-helper.js"]) {
      expect(isGovernancePath(root, p), p).toBe(false);
    }
  });

  it("honours project patterns on top of the floor", () => {
    const root = tempProject();
    // The shape loadProjectProtectedConfig returns for a temp project's .rks/protected-files.yml.
    fs.mkdirSync(path.join(root, ".rks"), { recursive: true });
    fs.writeFileSync(path.join(root, ".rks", "protected-files.yml"), "projectProtected:\n  - config/secret.yml\n");
    const cfg = loadProjectProtectedConfig(root);
    const patterns = [...(cfg.protected || []), ...(cfg.projectProtected || [])];
    expect(patterns).toEqual(["config/secret.yml"]);
    expect(isGovernancePath(root, "config/secret.yml", patterns)).toBe(true);
    expect(isGovernancePath(root, "config/secret.yml", ["config/secret.yml"])).toBe(true);
    expect(isGovernancePath(root, "config/secret.yml")).toBe(false);
    expect(isGovernancePath(root, "config/secret.yml", [])).toBe(false);
  });

  it("fails closed on non-string or empty input", () => {
    const root = tempProject();
    for (const bad of [undefined, null, 42, {}, ""]) {
      expect(isGovernancePath(root, bad), String(bad)).toBe(true);
    }
    for (const bad of [undefined, null, 42, {}, ""]) {
      expect(isGovernanceRelPath(bad), String(bad)).toBe(true);
    }
  });

  it("resolves the target against projectRoot before matching", () => {
    const root = tempProject();
    expect(fs.existsSync(path.join(root, ".rks", "protected-files.yml"))).toBe(false);
    expect(isGovernancePath(root, "src/../.rks/x")).toBe(true);
    expect(isGovernancePath(root, ".rks/../src/a.js")).toBe(false);
  });
});

describe("shared derivations exclude governance paths", () => {
  const step = (produces) => ({ action: "run_command", command: "node tools/build.mjs", produces });

  it("planDeclaredOutputs keeps only the non-governance entry", () => {
    const out = planDeclaredOutputs([step(["dist/app.js", ".routekit/command-policy.yaml", ".rks/x", "./.claude/settings.json", ".git/config", ".RKS/y"])]);
    expect([...out]).toEqual(["dist/app.js"]);
  });

  it("computeCommitFiles never includes a declared governance path", () => {
    const files = computeCommitFiles({ appliedFiles: ["src/a.js"], steps: [step(["dist/app.js", ".rks/x"])] });
    expect(files).toEqual(expect.arrayContaining(["src/a.js", "dist/app.js"]));
    expect(files).not.toContain(".rks/x");
  });

  it("computeUnexpectedFiles flags a governance path even when produces declares it", () => {
    const unexpected = computeUnexpectedFiles({ steps: [step([".claude/settings.json"])], modifiedFiles: [".claude/settings.json"] });
    expect(unexpected).toContain(".claude/settings.json");
  });
});
