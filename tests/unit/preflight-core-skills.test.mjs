/**
 * Witness for backlog.fix.shell-self-sync-skill-wipe-health-gate — preflight stops lying.
 *
 * On the clean-machine UAT box every distributable skill had been deleted. rks could not route a
 * single thing: no /build, no /ship, no /research. `rks_preflight` reported 7/7 checks green, because
 * not one of them looked at `.claude/skills`. A health oracle that certifies a corpse is worse than
 * having none, because it ends the investigation — the user asked the tool whether it was okay, the
 * tool said yes, and the real problem stayed invisible for a whole round.
 *
 * Two false negatives are fixed here, and both are witnessed against the REAL exported functions
 * (`loadSkillsManifest` / `findMissingSkills`) and the REAL branch semantics — no source-text greps.
 * (`preflight.test.mjs` asserts by regex over preflight's own source; that is pre-existing debt and
 * this file deliberately does not extend it.)
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { loadSkillsManifest, findMissingSkills } from "../../packages/mcp-rks/src/shared/skills-manifest.mjs";
import { checkGitReadiness } from "../../packages/mcp-rks/src/server/preflight.mjs";

let tmp;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rks-preflight-skills-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function makeClone({ skills = ["arch", "build", "promote"], present = ["arch", "build", "promote"] } = {}) {
  fs.mkdirSync(path.join(tmp, ".routekit"), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, ".routekit", "skills-manifest.json"),
    JSON.stringify({ version: 1, skills, shellOnly: ["promote"] }),
  );
  for (const s of present) {
    const d = path.join(tmp, ".claude", "skills", s);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "SKILL.md"), `# ${s}\n`);
  }
  return tmp;
}

describe("core_skills — the check that was not there", () => {
  it("a HEALTHY clone reports every distributable skill present", () => {
    const root = makeClone();
    const m = loadSkillsManifest(root);
    expect(m.ok).toBe(true);
    expect(findMissingSkills(root, m.distributable)).toEqual([]);
  });

  it("THE UAT STATE: distributable skills deleted, `promote` spared → reported MISSING", () => {
    // This is the fingerprint from the real incident, and it is the reason we know our own code did
    // it: `promote` is the one skill the distribution rule excludes, so a self-targeted sync spares
    // exactly it. A manual `rm -rf` would have taken it too.
    const root = makeClone({ present: ["promote"] });

    const m = loadSkillsManifest(root);
    const missing = findMissingSkills(root, m.distributable);

    expect(missing).toEqual(["arch", "build"]);
    expect(missing.length).toBeGreaterThan(0); // → preflight's core_skills check FAILS
    // And the tell-tale: the excluded skill is still sitting there.
    expect(fs.existsSync(path.join(root, ".claude", "skills", "promote", "SKILL.md"))).toBe(true);
  });

  it("an EMPTY SKILL.md is missing, not present (the wipe leaves husks behind)", () => {
    const root = makeClone({ present: ["arch", "promote"] });
    const husk = path.join(root, ".claude", "skills", "build");
    fs.mkdirSync(husk, { recursive: true });
    fs.writeFileSync(path.join(husk, "SKILL.md"), "");
    expect(findMissingSkills(root, ["arch", "build"])).toEqual(["build"]);
  });

  it("a clone with NO manifest degrades to a stated non-check, not a silent green", () => {
    // A child scaffolded before the manifest shipped legitimately has none. It must not FAIL — but
    // preflight must say the check did not run, rather than report a pass it never earned.
    fs.mkdirSync(path.join(tmp, ".claude", "skills"), { recursive: true });
    const m = loadSkillsManifest(tmp);
    expect(m.ok).toBe(false);
    expect(m.reason).toBe("manifest_missing");
  });
});

describe("working_branch — a detached HEAD is not healthy", () => {
  // Driven through the REAL exported checkGitReadiness against a REAL detached git repo. Asserting a
  // locally re-implemented `onWorking` here would be a mirror of the rule, green even if the rule
  // broke — the exact debt this repo keeps paying for.
  //
  // `git rev-parse --abbrev-ref HEAD` SUCCEEDS when detached and returns the literal string "HEAD".
  // The old check was `workingBranch ? currentBranch === workingBranch : !!currentBranch` — so with
  // NO working branch configured, `!!"HEAD"` is truthy and a detached clone read as GREEN. That is
  // the state the README's own "pin to a tag for stability" advice produces, and the state the UAT
  // box was in.
  const TIMEOUT = 20_000;
  const g = (cwd, args) => spawnSync("git", args, { cwd, encoding: "utf8", timeout: TIMEOUT });

  function detachedRepo() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rks-detached-"));
    g(root, ["init", "-b", "staging"]);
    g(root, ["config", "user.email", "t@t"]);
    g(root, ["config", "user.name", "t"]);
    fs.writeFileSync(path.join(root, "f.txt"), "one\n");
    g(root, ["add", "-A"]);
    g(root, ["commit", "-m", "one"]);
    const sha = g(root, ["rev-parse", "HEAD"]).stdout.trim();
    g(root, ["checkout", sha]); // ← detach, exactly as `git checkout <tag>` does
    return { root, sha };
  }

  // checkGitReadiness returns the checks ARRAY directly.
  const workingBranchCheck = (root, projectJson) =>
    checkGitReadiness({ projectRoot: root, projectJson, timeoutMs: TIMEOUT }).find(
      (c) => c.name === "working_branch",
    );

  it("the fixture really is detached (positive control — otherwise this proves nothing)", () => {
    const { root } = detachedRepo();
    try {
      expect(g(root, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim()).toBe("HEAD");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("FAILS on a detached HEAD when a working branch IS configured", () => {
    const { root } = detachedRepo();
    try {
      const check = workingBranchCheck(root, { branches: { working: "staging" } });
      expect(check.passed).toBe(false);
      expect(check.hint).toMatch(/detached/i);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("FAILS on a detached HEAD when NO working branch is configured — THIS FAILED OPEN BEFORE", () => {
    const { root } = detachedRepo();
    try {
      const check = workingBranchCheck(root, {}); // no branches.working, no baseBranch
      expect(check.passed).toBe(false); // was TRUE: `!!"HEAD"` is truthy
      expect(check.detail).toBe("detached HEAD");
      expect(check.hint).toMatch(/detached/i);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("still PASSES on a real branch, in both configurations (no regression)", () => {
    const { root } = detachedRepo();
    try {
      g(root, ["checkout", "staging"]); // re-attach
      expect(workingBranchCheck(root, { branches: { working: "staging" } }).passed).toBe(true);
      expect(workingBranchCheck(root, {}).passed).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("still FAILS on the wrong branch (no regression)", () => {
    const { root } = detachedRepo();
    try {
      g(root, ["checkout", "staging"]);
      expect(workingBranchCheck(root, { branches: { working: "main" } }).passed).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
