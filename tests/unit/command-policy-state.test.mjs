/**
 * backlog.fix.command-policy-integrity-across-runs
 * Unit tests for captureCommandPolicyState / compareCommandPolicyState / restoreCommandPolicyState
 * and the isCommandPolicyTarget realpath rule. Fixtures live under TEMP_BASE (never inside the repo
 * worktree); git is spawned with spawnSync and an explicit timeout on every call.
 *
 * testRequirement -> test mapping (TRn = the story's nth testRequirement):
 *   TR1  "[TR1] the three state functions are exported"
 *   TR2  "[TR2] non-git capture records the worktree and null git fields"
 *   TR3  "[TR3] two captures of an untouched policy compare equal"
 *   TR4  "[TR4] a commit that does not touch the policy is not a change"
 *   TR5  "[TR5] rewritten bytes: parts [worktree], restored [worktree], bytes back"
 *   TR6  "[TR6] a deleted policy is reported and recreated"
 *   TR7  "[TR7] a policy created after a no-policy baseline is removed"
 *   TR8  "[TR8] a symlink with identical bytes is a change and is replaced by a regular file"
 *   TR9  "[TR9] a restore that cannot write reports the part in failed"
 *   TR10 "[TR10] a staged modification is an index change, restored to the baseline entry"
 *   TR11 "[TR11] git rm --cached is an index change, restored to the baseline entry"
 *   TR12 "[TR12] a committed change on an rks/ branch is a head change, reset with allowHeadReset"
 *   TR13 "[TR13] without allowHeadReset, or off the baseline ancestry, head fails and HEAD stays"
 *   TR14 "[TR14] symlinked directory and symlink file targets match the policy"
 *   TR15 "[TR15] a not-yet-existing leaf under a symlinked ancestor matches; no policy file = lexical only"
 */
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { TEMP_BASE } from "../helpers/tmp.mjs";
import * as runner from "../../packages/mcp-rks/src/exec/command-runner.mjs";

const {
  captureCommandPolicyState,
  compareCommandPolicyState,
  restoreCommandPolicyState,
  isCommandPolicyTarget,
  COMMAND_POLICY_RELATIVE_PATH,
} = runner;

const GIT_TIMEOUT = 15_000;
const git = (cwd, args) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout: GIT_TIMEOUT });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
};

const POLICY_A = 'command_policy:\n  auto_execute: ["node a.mjs"]\n';
const POLICY_B = 'command_policy:\n  auto_execute: ["node a.mjs", "node b.mjs"]\n';

const cleanup = [];
afterEach(() => {
  for (const p of cleanup.splice(0)) {
    try {
      fs.chmodSync(path.join(p, ".routekit"), 0o755);
      fs.chmodSync(path.join(p, ".routekit", "command-policy.yaml"), 0o644);
    } catch { /* not every fixture is chmodded */ }
    fs.rmSync(p, { recursive: true, force: true });
  }
});

function tempRoot(tag) {
  const dir = path.join(TEMP_BASE, `cps-${tag}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  cleanup.push(dir);
  return dir;
}

const policyPath = (root) => path.join(root, ".routekit", "command-policy.yaml");

function writePolicy(root, text) {
  fs.mkdirSync(path.join(root, ".routekit"), { recursive: true });
  fs.writeFileSync(policyPath(root), text);
}

/** A non-git root with a policy file. */
function plainRoot(tag, text = POLICY_A) {
  const root = tempRoot(tag);
  if (text !== null) writePolicy(root, text);
  return root;
}

/** A git work tree with the policy committed on staging, then checked out on an rks/ branch. */
function gitRoot(tag, { branch = "rks/fixture" } = {}) {
  const root = tempRoot(tag);
  writePolicy(root, POLICY_A);
  fs.writeFileSync(path.join(root, "other.txt"), "one\n");
  git(root, ["init", "-q", "-b", "staging"]);
  git(root, ["config", "user.email", "t@t"]);
  git(root, ["config", "user.name", "t"]);
  git(root, ["config", "commit.gpgsign", "false"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "baseline"]);
  if (branch) git(root, ["checkout", "-q", "-b", branch]);
  return root;
}

const lsEntry = (root) => git(root, ["ls-files", "-s", "--", COMMAND_POLICY_RELATIVE_PATH]).trim();
const headBlob = (root) => git(root, ["rev-parse", `HEAD:${COMMAND_POLICY_RELATIVE_PATH}`]).trim();

describe("command policy state (non-git root)", () => {
  it("[TR1] the three state functions are exported", () => {
    for (const name of ["captureCommandPolicyState", "compareCommandPolicyState", "restoreCommandPolicyState"]) {
      expect(typeof runner[name], name).toBe("function");
    }
  });

  it("[TR2] non-git capture records the worktree and null git fields", () => {
    const root = plainRoot("capture");
    const s = captureCommandPolicyState(root);
    expect(s.worktree.exists).toBe(true);
    expect(Buffer.from(s.worktree.bytes).toString("utf8")).toBe(POLICY_A);
    expect(s.worktree.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(s.index).toBeNull();
    expect(s.head).toBeNull();
    expect(s.headCommit).toBeNull();
  });

  it("[TR3] two captures of an untouched policy compare equal", () => {
    const root = plainRoot("untouched");
    const a = captureCommandPolicyState(root);
    const b = captureCommandPolicyState(root);
    expect(compareCommandPolicyState(a, b)).toEqual({ changed: false, parts: [] });
  });

  it("[TR5] rewritten bytes: parts [worktree], restored [worktree], bytes back", () => {
    const root = plainRoot("rewrite");
    const base = captureCommandPolicyState(root);
    fs.writeFileSync(policyPath(root), POLICY_B);
    const cmp = compareCommandPolicyState(base, captureCommandPolicyState(root));
    expect(cmp.changed).toBe(true);
    expect(cmp.parts).toEqual(["worktree"]);
    const rs = restoreCommandPolicyState(root, base, cmp.parts);
    expect(rs).toEqual({ restored: ["worktree"], failed: [] });
    expect(fs.readFileSync(policyPath(root), "utf8")).toBe(POLICY_A);
  });

  it("[TR6] a deleted policy is reported and recreated", () => {
    const root = plainRoot("delete");
    const base = captureCommandPolicyState(root);
    fs.rmSync(policyPath(root));
    const cmp = compareCommandPolicyState(base, captureCommandPolicyState(root));
    expect(cmp.parts).toEqual(["worktree"]);
    restoreCommandPolicyState(root, base, cmp.parts);
    expect(fs.readFileSync(policyPath(root), "utf8")).toBe(POLICY_A);
  });

  it("[TR7] a policy created after a no-policy baseline is removed", () => {
    const root = plainRoot("create", null);
    const base = captureCommandPolicyState(root);
    expect(base.worktree.exists).toBe(false);
    writePolicy(root, POLICY_B);
    const cmp = compareCommandPolicyState(base, captureCommandPolicyState(root));
    expect(cmp.parts).toEqual(["worktree"]);
    const rs = restoreCommandPolicyState(root, base, cmp.parts);
    expect(rs.restored).toEqual(["worktree"]);
    expect(fs.existsSync(policyPath(root))).toBe(false);
  });

  it("[TR8] a symlink with identical bytes is a change and is replaced by a regular file", () => {
    const root = plainRoot("symlink");
    const base = captureCommandPolicyState(root);
    const elsewhere = path.join(root, "elsewhere.yaml");
    fs.writeFileSync(elsewhere, POLICY_A);
    fs.rmSync(policyPath(root));
    fs.symlinkSync(elsewhere, policyPath(root));
    const cur = captureCommandPolicyState(root);
    expect(cur.worktree.sha256).toBe(base.worktree.sha256);
    const cmp = compareCommandPolicyState(base, cur);
    expect(cmp.parts).toContain("worktree");
    const rs = restoreCommandPolicyState(root, base, cmp.parts);
    expect(rs.restored).toEqual(["worktree"]);
    expect(fs.lstatSync(policyPath(root)).isSymbolicLink()).toBe(false);
    expect(fs.lstatSync(policyPath(root)).isFile()).toBe(true);
    expect(fs.readFileSync(policyPath(root), "utf8")).toBe(POLICY_A);
  });

  it("[TR9] a restore that cannot write reports the part in failed", () => {
    const root = plainRoot("unwritable");
    const base = captureCommandPolicyState(root);
    fs.writeFileSync(policyPath(root), POLICY_B);
    fs.chmodSync(policyPath(root), 0o444);
    fs.chmodSync(path.join(root, ".routekit"), 0o555);
    const rs = restoreCommandPolicyState(root, base, ["worktree"]);
    expect(rs.restored).not.toContain("worktree");
    expect(rs.failed).toHaveLength(1);
    expect(rs.failed[0].part).toBe("worktree");
    expect(typeof rs.failed[0].error).toBe("string");
    expect(rs.failed[0].error.length).toBeGreaterThan(0);
  });
});

describe("command policy state (git work tree)", () => {
  it("[TR4] a commit that does not touch the policy is not a change", () => {
    const root = gitRoot("nochange");
    const base = captureCommandPolicyState(root);
    expect(base.index).toMatchObject({ mode: "100644" });
    fs.writeFileSync(path.join(root, "other.txt"), "two\n");
    git(root, ["commit", "-q", "-am", "unrelated"]);
    const cur = captureCommandPolicyState(root);
    expect(cur.headCommit).not.toBe(base.headCommit);
    expect(compareCommandPolicyState(base, cur)).toEqual({ changed: false, parts: [] });
  });

  it("[TR10] a staged modification is an index change, restored to the baseline entry", () => {
    const root = gitRoot("stage");
    const base = captureCommandPolicyState(root);
    const entry = lsEntry(root);
    fs.writeFileSync(policyPath(root), POLICY_B);
    git(root, ["add", COMMAND_POLICY_RELATIVE_PATH]);
    const cmp = compareCommandPolicyState(base, captureCommandPolicyState(root));
    expect(cmp.parts).toContain("index");
    const rs = restoreCommandPolicyState(root, base, cmp.parts);
    expect(rs.failed).toEqual([]);
    expect(lsEntry(root)).toBe(entry);
    expect(fs.readFileSync(policyPath(root), "utf8")).toBe(POLICY_A);
  });

  it("[TR11] git rm --cached is an index change, restored to the baseline entry", () => {
    const root = gitRoot("rmcached");
    const base = captureCommandPolicyState(root);
    const entry = lsEntry(root);
    git(root, ["rm", "--cached", "-q", COMMAND_POLICY_RELATIVE_PATH]);
    const cmp = compareCommandPolicyState(base, captureCommandPolicyState(root));
    expect(cmp.parts).toEqual(["index"]);
    const rs = restoreCommandPolicyState(root, base, cmp.parts);
    expect(rs).toEqual({ restored: ["index"], failed: [] });
    expect(lsEntry(root)).toBe(entry);
  });

  it("[TR12] a committed change on an rks/ branch is a head change, reset with allowHeadReset", () => {
    const root = gitRoot("headreset");
    const base = captureCommandPolicyState(root);
    fs.writeFileSync(policyPath(root), POLICY_B);
    git(root, ["commit", "-q", "-am", "widen"]);
    const cmp = compareCommandPolicyState(base, captureCommandPolicyState(root));
    expect(cmp.parts).toContain("head");
    const rs = restoreCommandPolicyState(root, base, cmp.parts, { allowHeadReset: true });
    expect(rs.failed).toEqual([]);
    expect(rs.restored).toContain("head");
    expect(headBlob(root)).toBe(base.head);
    expect(lsEntry(root)).toContain(base.index.blob);
    expect(fs.readFileSync(policyPath(root), "utf8")).toBe(POLICY_A);
  });

  it("[TR13] without allowHeadReset, or off the baseline ancestry, head fails and HEAD stays", () => {
    const root = gitRoot("headrefuse");
    const base = captureCommandPolicyState(root);
    fs.writeFileSync(policyPath(root), POLICY_B);
    git(root, ["commit", "-q", "-am", "widen"]);
    const headBefore = git(root, ["rev-parse", "HEAD"]).trim();

    const noFlag = restoreCommandPolicyState(root, base, ["head"]);
    expect(noFlag.restored).not.toContain("head");
    expect(noFlag.failed.map((f) => f.part)).toEqual(["head"]);
    expect(typeof noFlag.failed[0].error).toBe("string");
    expect(git(root, ["rev-parse", "HEAD"]).trim()).toBe(headBefore);

    // A HEAD that does not descend from baseline.headCommit: an orphan branch.
    git(root, ["checkout", "-q", "--orphan", "rks/orphan"]);
    git(root, ["commit", "-q", "-m", "orphan"]);
    const orphanHead = git(root, ["rev-parse", "HEAD"]).trim();
    const offAncestry = restoreCommandPolicyState(root, base, ["head"], { allowHeadReset: true });
    expect(offAncestry.restored).not.toContain("head");
    expect(offAncestry.failed.map((f) => f.part)).toEqual(["head"]);
    expect(offAncestry.failed[0].error).toMatch(/descend/);
    expect(git(root, ["rev-parse", "HEAD"]).trim()).toBe(orphanHead);
  });
});

describe("isCommandPolicyTarget realpath rule", () => {
  it("[TR14] symlinked directory and symlink file targets match the policy", () => {
    const root = plainRoot("realpath");
    fs.symlinkSync(path.join(root, ".routekit"), path.join(root, "link-dir"));
    fs.symlinkSync(policyPath(root), path.join(root, "policy-link.yaml"));
    expect(isCommandPolicyTarget(root, "link-dir/command-policy.yaml")).toBe(true);
    expect(isCommandPolicyTarget(root, "policy-link.yaml")).toBe(true);
    // Controls: unrelated targets through the same link do not match.
    expect(isCommandPolicyTarget(root, "link-dir/other.yaml")).toBe(false);
    expect(isCommandPolicyTarget(root, "docs/command-policy.yaml")).toBe(false);
  });

  it("[TR15] a not-yet-existing leaf under a symlinked ancestor matches; no policy file = lexical only", () => {
    const root = plainRoot("leaf");
    // link-parent -> root, so link-parent/.routekit/command-policy.yaml names the policy through a
    // symlinked ancestor; link-parent/new-dir/x.yaml does not exist and must not match.
    fs.symlinkSync(root, path.join(root, "link-parent"));
    fs.symlinkSync(path.join(root, ".routekit"), path.join(root, "link-dir"));
    expect(isCommandPolicyTarget(root, "link-parent/.routekit/command-policy.yaml")).toBe(true);
    // Not-yet-existing leaves: the nearest existing ancestor is link-dir (realpath .routekit) or
    // link-parent/new-dir's parent (realpath root); joined with the remaining segments they name a
    // path that is not the policy, so they do not match.
    expect(isCommandPolicyTarget(root, "link-dir/sub/command-policy.yaml")).toBe(false);
    expect(isCommandPolicyTarget(root, "link-parent/new-dir/x.yaml")).toBe(false);
    // A leaf whose join DOES equal the policy realpath (compared case-insensitively, as the lexical
    // rule is): on a case-sensitive volume "COMMAND-POLICY.yaml" does not exist, so the nearest
    // existing ancestor (link-dir -> .routekit) is joined with the remaining segment; on a
    // case-insensitive volume it resolves directly. Either way it names the policy file.
    expect(isCommandPolicyTarget(root, "link-dir/COMMAND-POLICY.yaml")).toBe(true);

    const missingRoot = plainRoot("nopolicy", null);
    fs.mkdirSync(path.join(missingRoot, ".routekit"), { recursive: true });
    fs.symlinkSync(path.join(missingRoot, ".routekit"), path.join(missingRoot, "link-dir"));
    // No policy file: only the lexical rule applies, so the symlinked spelling does not match...
    expect(isCommandPolicyTarget(missingRoot, "link-dir/command-policy.yaml")).toBe(false);
    // ...while the lexical spellings still do.
    expect(isCommandPolicyTarget(missingRoot, ".routekit/command-policy.yaml")).toBe(true);
    expect(isCommandPolicyTarget(missingRoot, "./.routekit/command-policy.yaml")).toBe(true);
  });
});
