import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// backlog.chore.codify-semver-versioning-policy
// Standing repo invariant: the root and workspace sub-package versions never drift. rks_release
// bumps root + packages/mcp-rks + packages/cli in lockstep (git-release.mjs), so any manual edit
// that diverges them reddens CI here — independent of the release path.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const versionOf = (rel) => JSON.parse(fs.readFileSync(path.join(repoRoot, rel), "utf8")).version;

describe("workspace version-sync invariant", () => {
  const root = versionOf("package.json");

  it("root package.json has a semver version", () => {
    expect(root).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("packages/mcp-rks/package.json matches the root version (no drift)", () => {
    expect(versionOf("packages/mcp-rks/package.json")).toBe(root);
  });

  it("packages/cli/package.json matches the root version (no drift)", () => {
    expect(versionOf("packages/cli/package.json")).toBe(root);
  });
});

describe("versioning policy is documented", () => {
  const readme = fs.readFileSync(path.join(repoRoot, "README.md"), "utf8");
  const releaseSkill = fs.readFileSync(path.join(repoRoot, ".claude/skills/release/SKILL.md"), "utf8");

  it("README has the PATCH/MINOR/MAJOR policy + the intended-vs-broken sharpening test", () => {
    expect(readme).toMatch(/## Versioning/);
    for (const bump of ["PATCH", "MINOR", "MAJOR"]) expect(readme).toContain(bump);
    expect(readme).toMatch(/fixing broken behavior is a patch/i);
    expect(readme).toMatch(/changing or adding intended behavior is a minor/i);
  });

  it("the release skill references the versioning policy + lockstep bump", () => {
    expect(releaseSkill).toMatch(/versioning policy/i);
    expect(releaseSkill).toMatch(/lockstep/i);
  });
});
