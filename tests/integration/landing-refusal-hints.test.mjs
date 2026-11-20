// backlog.fix.landing-refusal-hints-observed-branch-state
// Real git in temp repos under os.tmpdir(): a bare origin plus a work clone (exemplar:
// tests/integration/ship-non-github-remote-local-merge.test.mjs for runShip;
// tests/integration/story-ship-coverage-record-gate.test.mjs for runStoryShipTool;
// tests/integration/off-rail-ship-enforcement-gate.test.mjs for guardrailsOff/guardrailsOn gate beta).
// The landing gate is enabled through the temp repo's own .rks/project.json fullSuiteGate.
// Every claim a hint or message makes is read back from git (rev-parse, ls-remote,
// merge-base --is-ancestor); no source-text assertion. Every spawnSync carries timeout:.
//
// Harness (QA decision): a partial vi.mock of full-suite-gate.mjs keeps the config resolution real
// and replaces only the runner, whose per-test side effect (advance the target, or write
// .git/HEAD.lock) runs between landing preparation and landing verification. Git state stays real.
// This file deliberately imports and mocks no @routekit/telemetry specifier
// (tests/unit/telemetry-global-mock-triage.test.mjs): the suite-wide stub from tests/setup.mjs serves.
import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const h = vi.hoisted(() => ({
  // Gate runner stub: { result, before(projectRoot) } — used only when the temp repo enables the gate.
  gate: null,
  // rks_story_ship context: { root, branches } — null for the runShip and guardrailsOn cases.
  story: null,
}));

vi.mock("../../packages/mcp-rks/src/exec/full-suite-gate.mjs", async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    runFullSuiteGate: (projectRoot, options = {}) => {
      if (real.resolveFullSuiteGateConfig(projectRoot).enabled !== true || !h.gate) {
        return real.runFullSuiteGate(projectRoot, options);
      }
      if (h.gate.before) h.gate.before(projectRoot);
      return { ...h.gate.result };
    },
  };
});

// Short-circuit only the embedding step after commits (no ONNX model load); git semantics stay real.
vi.mock("@routekit/rag/tools", () => ({
  runRagEmbed: vi.fn().mockResolvedValue({ ok: true, addedEmbeddings: 0, removedCount: 0 }),
}));

vi.mock("../../packages/mcp-rks/src/server/project.mjs", async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    loadContext: async (...args) => (h.story
      ? { record: { root: h.story.root, id: "test-project" }, projectJson: { branches: { ...h.story.branches } } }
      : real.loadContext(...args)),
    getBranchConfig: (...args) => (h.story ? { ...h.story.branches } : real.getBranchConfig(...args)),
    getWorkflowConfig: (...args) => (h.story ? { autoMergeIntegration: false } : real.getWorkflowConfig(...args)),
  };
});

vi.mock("../../packages/mcp-rks/src/server/git-tools.mjs", async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    runCycleComplete: async (...args) => (h.story ? { ok: true, branch: h.story.branches.working } : real.runCycleComplete(...args)),
    runPromote: async (...args) => (h.story ? { ok: true } : real.runPromote(...args)),
  };
});

vi.mock("../../packages/mcp-rks/src/server/branch-protection.mjs", async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    assertNotOnProtectedBranch: (...args) => (h.story ? undefined : real.assertNotOnProtectedBranch(...args)),
  };
});

vi.mock("../../packages/mcp-rks/src/server/review.mjs", async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    loadReviewPolicy: (...args) => (h.story ? { enabled: false } : real.loadReviewPolicy(...args)),
  };
});

import { runShip } from "../../packages/mcp-rks/src/server/git/git-ship.mjs";
import { runStoryShipTool } from "../../packages/mcp-rks/src/server/story-ship.mjs";
import { guardrailsOff, guardrailsOn } from "../../packages/mcp-rks/src/server/guardrails-audit.mjs";
import { formatWithFrontmatter } from "../../packages/mcp-rks/src/shared/frontmatter.mjs";

const GIT_TIMEOUT_MS = 30_000;
const GIT_ID_ENV = {
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
};
const PASS = { ran: true, blocked: false, reason: "no_new_failures" };
const BLOCK = { ran: true, blocked: true, reason: "new_failures", newFailures: ["tests/a.test.mjs > broken"] };
const MERGE_CLAIM = /landing merge commit/;
const PUSHED_CLAIM = /origin's copy|pushed to origin/;

function git(cwd, args, { env, input } = {}) {
  return spawnSync("git", args, {
    cwd, encoding: "utf8", timeout: GIT_TIMEOUT_MS,
    env: { ...process.env, ...GIT_ID_ENV, ...(env || {}) },
    ...(input !== undefined ? { input } : {}),
  });
}
function gitOk(cwd, args, opts) {
  const r = git(cwd, args, opts);
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return (r.stdout || "").trim();
}
const revParse = (cwd, ref) => gitOk(cwd, ["rev-parse", ref]);
/** The sha origin holds for refs/heads/<branch>, read with ls-remote; "" when origin has no such ref. */
const lsRemote = (cwd, branch) => (gitOk(cwd, ["ls-remote", "origin", `refs/heads/${branch}`]).split(/\s+/)[0] || "");
const isAncestor = (cwd, a, b) => git(cwd, ["merge-base", "--is-ancestor", a, b]).status === 0;
const parentsOf = (cwd, sha) => gitOk(cwd, ["rev-list", "--parents", "-n", "1", sha]).split(/\s+/).slice(1);

function configIdentity(dir) {
  gitOk(dir, ["config", "user.email", "t@t"]);
  gitOk(dir, ["config", "user.name", "t"]);
  gitOk(dir, ["config", "commit.gpgsign", "false"]);
}

const dirs = [];
function tmpDir(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
}

let seq = 0;
/** Commit `file` onto refs/heads/<branch> with plumbing (a private index), leaving HEAD and the worktree alone. */
function commitOnBranch(repo, base, branch, file, msg) {
  const env = { GIT_INDEX_FILE: path.join(base, `index-${++seq}`) };
  const parent = revParse(repo, `refs/heads/${branch}`);
  gitOk(repo, ["read-tree", parent], { env });
  const blob = gitOk(repo, ["hash-object", "-w", "--stdin"], { input: `${file} ${seq}\n` });
  gitOk(repo, ["update-index", "--add", "--cacheinfo", `100644,${blob},${file}`], { env });
  const tree = gitOk(repo, ["write-tree"], { env });
  const commit = gitOk(repo, ["commit-tree", tree, "-p", parent, "-m", msg]);
  gitOk(repo, ["update-ref", `refs/heads/${branch}`, commit, parent]);
  return commit;
}

/** Push a new commit onto origin's <branch> from a second clone; returns the new origin tip. */
function advanceOrigin(fx, branch = "staging") {
  const other = path.join(fx.base, `other-${++seq}`);
  gitOk(fx.base, ["clone", "-q", "-b", branch, fx.bare, other]);
  configIdentity(other);
  fs.writeFileSync(path.join(other, `origin-${seq}.txt`), `origin ${seq}\n`);
  gitOk(other, ["add", "-A"]);
  gitOk(other, ["commit", "-q", "-m", `origin advance ${seq}`]);
  gitOk(other, ["push", "-q", "origin", branch]);
  return revParse(other, "HEAD");
}

function writeHook(hooksDir, name, body) {
  fs.mkdirSync(hooksDir, { recursive: true });
  fs.writeFileSync(path.join(hooksDir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}
/** pre-merge-commit hook failing only when the merge is made on <branch>. */
function failMergeCommitOn(repo, branch) {
  writeHook(path.join(repo, ".git", "hooks"), "pre-merge-commit",
    `[ "$(git rev-parse --abbrev-ref HEAD)" = "${branch}" ] && { echo "pre-merge-commit refused on ${branch}" >&2; exit 1; }\nexit 0`);
}
/** pre-receive hook in the bare origin rejecting one ref only. */
function rejectPushOf(bare, ref) {
  writeHook(path.join(bare, "hooks"), "pre-receive",
    `while read old new ref; do\n  if [ "$ref" = "${ref}" ]; then echo "PRE-RECEIVE-REJECTED ${ref}" >&2; exit 1; fi\ndone\nexit 0`);
}
const writeHeadLock = (repo) => fs.writeFileSync(path.join(repo, ".git", "HEAD.lock"), "");
const removeHeadLock = (repo) => fs.rmSync(path.join(repo, ".git", "HEAD.lock"), { force: true });

const landingOf = (steps) => (steps || []).find((s) => s.step === "landing_candidate");
const stepNames = (steps) => (steps || []).map((s) => s.step);

afterEach(() => {
  h.gate = null;
  h.story = null;
  while (dirs.length) {
    try { fs.rmSync(dirs.pop(), { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

// ─── rks_ship fixtures ──────────────────────────────────────────────────────────────────────────

/**
 * A bare origin (main, plus staging when targetOnOrigin) and a work clone. reuse: the clone sits on
 * rks/feat carrying a committed work commit (alreadyOnFeatureBranch). Otherwise it sits on staging
 * with an uncommitted feature.txt, so runShip creates a new (non rks/*) branch. targetAhead: the
 * target gets a commit the feature branch lacks before the ship, so landing preparation merges it.
 */
function shipFixture({ gate = true, targetOnOrigin = true, reuse = true, targetAhead = true } = {}) {
  const base = tmpDir("rks-landing-hints-ship-");
  const bare = path.join(base, "origin.git");
  const work = path.join(base, "work");
  gitOk(base, ["init", "--bare", "-q", "-b", "main", bare]);
  gitOk(base, ["clone", "-q", bare, work]);
  configIdentity(work);
  fs.writeFileSync(path.join(work, "README.md"), "seed\n");
  fs.mkdirSync(path.join(work, ".rks"), { recursive: true });
  fs.writeFileSync(path.join(work, ".rks", "project.json"), JSON.stringify(gate ? { fullSuiteGate: { enabled: true } } : {}, null, 2));
  gitOk(work, ["add", "-A"]);
  gitOk(work, ["commit", "-q", "-m", "seed"]);
  gitOk(work, ["push", "-q", "-u", "origin", "main"]);
  gitOk(work, ["checkout", "-q", "-b", "staging"]);
  if (targetOnOrigin) gitOk(work, ["push", "-q", "-u", "origin", "staging"]);
  const fx = { base, bare, work, branch: null, workCommit: null };
  if (reuse) {
    gitOk(work, ["checkout", "-q", "-b", "rks/feat"]);
    fs.writeFileSync(path.join(work, "feature.txt"), "feature\n");
    gitOk(work, ["add", "feature.txt"]);
    gitOk(work, ["commit", "-q", "-m", "feat: work"]);
    fx.branch = "rks/feat";
    fx.workCommit = revParse(work, "HEAD");
  } else {
    fs.writeFileSync(path.join(work, "feature.txt"), "feature\n");
  }
  if (targetAhead) {
    if (targetOnOrigin) advanceOrigin(fx);
    else commitOnBranch(work, base, "staging", "ahead.txt", "staging ahead of the feature branch");
  }
  return fx;
}

const ship = (fx) => runShip({ projectRoot: fx.work, message: "ship feature", scope: "test", type: "feat", files: fx.branch ? [] : ["feature.txt"] });

/** Landing preparation as the ship recorded it, checked to be a real merge commit when mergedTarget. */
function preparedLanding(res) {
  const landing = landingOf(res.steps);
  expect(landing, JSON.stringify(res, null, 2)).toBeTruthy();
  expect(landing.ok).toBe(true);
  return landing;
}

describe("rks_ship landing refusal hints", () => {
  it("local arm landing_verify: hint says the target was not merged or pushed, and origin's target does not contain the feature branch", async () => {
    const fx = shipFixture();
    let advanced = null;
    h.gate = { result: PASS, before: () => { advanced = advanceOrigin(fx); } };
    const res = await ship(fx);
    expect(res.ok).toBe(false);
    expect(res.failedStep, JSON.stringify(res, null, 2)).toBe("landing_verify");
    expect(res.hint).toContain("staging was not merged into and not pushed");
    expect(isAncestor(fx.work, revParse(fx.work, "refs/heads/rks/feat"), advanced)).toBe(false);
    expect(lsRemote(fx.work, "staging")).toBe(advanced);
  });

  it("local arm landing_verify: hint names the landing merge commit, and the feature branch tip is preparedSha", async () => {
    const fx = shipFixture();
    const targetAtPrep = lsRemote(fx.work, "staging");
    h.gate = { result: PASS, before: () => advanceOrigin(fx) };
    const res = await ship(fx);
    expect(res.failedStep).toBe("landing_verify");
    const landing = preparedLanding(res);
    expect(landing.mergedTarget).toBe(true);
    expect(res.hint).toMatch(MERGE_CLAIM);
    expect(res.hint).toContain("rks/feat");
    expect(res.hint).toContain(landing.preparedSha);
    expect(revParse(fx.work, "refs/heads/rks/feat")).toBe(landing.preparedSha);
    expect(parentsOf(fx.work, landing.preparedSha)).toContain(targetAtPrep);
    expect(landing.targetSha).toBe(targetAtPrep);
  });

  it("local arm landing_verify: hint says origin's feature branch holds the merge commit, and ls-remote shows preparedSha", async () => {
    const fx = shipFixture();
    h.gate = { result: PASS, before: () => advanceOrigin(fx) };
    const res = await ship(fx);
    expect(res.failedStep).toBe("landing_verify");
    const landing = preparedLanding(res);
    expect(res.hint).toContain(`origin's copy of rks/feat also holds the landing merge commit ${landing.preparedSha}`);
    expect(lsRemote(fx.work, "rks/feat")).toBe(landing.preparedSha);
  });

  it("local arm landing_verify on a new branch: no pushed claim, and origin has no feature branch", async () => {
    const fx = shipFixture({ reuse: false });
    h.gate = { result: PASS, before: () => advanceOrigin(fx) };
    const res = await ship(fx);
    expect(res.failedStep, JSON.stringify(res, null, 2)).toBe("landing_verify");
    const featureBranch = res.steps.find((s) => s.step === "branch")?.branch;
    expect(typeof featureBranch).toBe("string");
    expect(featureBranch.startsWith("rks/")).toBe(false);
    expect(typeof res.hint).toBe("string");
    expect(res.hint).not.toMatch(PUSHED_CLAIM);
    expect(lsRemote(fx.work, featureBranch)).toBe("");
  });

  it("local arm landing_verify with mergedTarget false: no merge-commit claim", async () => {
    const fx = shipFixture({ targetAhead: false });
    h.gate = { result: PASS, before: () => advanceOrigin(fx) };
    const res = await ship(fx);
    expect(res.failedStep).toBe("landing_verify");
    const landing = preparedLanding(res);
    expect(landing.mergedTarget).toBe(false);
    expect(res.hint).not.toMatch(MERGE_CLAIM);
    expect(res.hint).not.toContain(landing.preparedSha);
    expect(revParse(fx.work, "refs/heads/rks/feat")).toBe(fx.workCommit);
  });

  it("no-remote arm landing_verify: hint carries the three gated claims, each matching git", async () => {
    const fx = shipFixture({ targetOnOrigin: false });
    h.gate = { result: PASS, before: () => commitOnBranch(fx.work, fx.base, "staging", "moved.txt", "staging moved after the gate") };
    const res = await ship(fx);
    expect(res.failedStep, JSON.stringify(res, null, 2)).toBe("landing_verify");
    const landing = preparedLanding(res);
    expect(landing.mergedTarget).toBe(true);
    expect(res.hint).toContain("staging was not merged into and not pushed");
    expect(res.hint).toContain(`rks/feat now carries the landing merge commit ${landing.preparedSha}`);
    expect(res.hint).toContain(`origin's copy of rks/feat also holds the landing merge commit ${landing.preparedSha}`);
    expect(isAncestor(fx.work, "refs/heads/rks/feat", "refs/heads/staging")).toBe(false);
    expect(revParse(fx.work, "refs/heads/rks/feat")).toBe(landing.preparedSha);
    expect(lsRemote(fx.work, "rks/feat")).toBe(landing.preparedSha);
  });

  it("full-suite block: hint names the merge commit and says nothing was pushed", async () => {
    const fx = shipFixture();
    const originTarget = lsRemote(fx.work, "staging");
    h.gate = { result: BLOCK };
    const res = await ship(fx);
    expect(res.failedStep).toBe("full_suite_gate");
    const landing = preparedLanding(res);
    expect(landing.mergedTarget).toBe(true);
    expect(res.hint).toContain(`rks/feat now carries the landing merge commit ${landing.preparedSha}`);
    expect(res.hint).toMatch(/Nothing was pushed/);
    expect(revParse(fx.work, "refs/heads/rks/feat")).toBe(landing.preparedSha);
    expect(lsRemote(fx.work, "rks/feat")).not.toBe(landing.preparedSha);
    expect(lsRemote(fx.work, "staging")).toBe(originTarget);
  });

  it("local arm merge-step refusal: hint carries the three gated claims, each matching git", async () => {
    const fx = shipFixture();
    const originTarget = lsRemote(fx.work, "staging");
    failMergeCommitOn(fx.work, "staging");
    h.gate = { result: PASS };
    const res = await ship(fx);
    expect(res.failedStep, JSON.stringify(res, null, 2)).toBe("merge");
    expect(res.error.startsWith("Local merge failed")).toBe(true);
    const landing = preparedLanding(res);
    expect(landing.mergedTarget).toBe(true);
    expect(res.hint).toContain("staging was not merged into and not pushed");
    expect(res.hint).toContain(`rks/feat now carries the landing merge commit ${landing.preparedSha}`);
    expect(res.hint).toContain(`origin's copy of rks/feat also holds the landing merge commit ${landing.preparedSha}`);
    expect(revParse(fx.work, "refs/heads/rks/feat")).toBe(landing.preparedSha);
    expect(lsRemote(fx.work, "rks/feat")).toBe(landing.preparedSha);
    expect(lsRemote(fx.work, "staging")).toBe(originTarget);
  });

  it("feature-branch push failure: hint names the merge commit and makes no pushed claim", async () => {
    const fx = shipFixture();
    const originTarget = lsRemote(fx.work, "staging");
    rejectPushOf(fx.bare, "refs/heads/rks/feat");
    h.gate = { result: PASS };
    const res = await ship(fx);
    expect(res.ok).toBe(false);
    expect(res.error, JSON.stringify(res, null, 2)).toMatch(/^Push failed/);
    const landing = preparedLanding(res);
    expect(landing.mergedTarget).toBe(true);
    expect(res.hint).toContain(`rks/feat now carries the landing merge commit ${landing.preparedSha}`);
    expect(res.hint).toContain("staging was not merged into and not pushed");
    expect(res.hint).not.toMatch(PUSHED_CLAIM);
    expect(revParse(fx.work, "refs/heads/rks/feat")).toBe(landing.preparedSha);
    expect(lsRemote(fx.work, "rks/feat")).not.toBe(landing.preparedSha);
    expect(lsRemote(fx.work, "staging")).toBe(originTarget);
  });

  it("no-remote arm local merge failure: hint carries the three gated claims, each matching git", async () => {
    const fx = shipFixture({ targetOnOrigin: false });
    failMergeCommitOn(fx.work, "staging");
    h.gate = { result: PASS };
    const res = await ship(fx);
    expect(res.ok).toBe(false);
    expect(res.error, JSON.stringify(res, null, 2)).toMatch(/^Local merge failed/);
    const landing = preparedLanding(res);
    expect(landing.mergedTarget).toBe(true);
    expect(res.hint).toContain("staging was not merged into and not pushed");
    expect(res.hint).toContain(`rks/feat now carries the landing merge commit ${landing.preparedSha}`);
    expect(res.hint).toContain(`origin's copy of rks/feat also holds the landing merge commit ${landing.preparedSha}`);
    expect(revParse(fx.work, "refs/heads/staging")).toBe(landing.targetSha);
    expect(revParse(fx.work, "refs/heads/rks/feat")).toBe(landing.preparedSha);
    expect(lsRemote(fx.work, "rks/feat")).toBe(landing.preparedSha);
  });

  it("no-remote arm checkout failure: hint carries the three gated claims, each matching git", async () => {
    const fx = shipFixture({ targetOnOrigin: false });
    h.gate = { result: PASS, before: (root) => writeHeadLock(root) };
    const res = await ship(fx);
    removeHeadLock(fx.work);
    expect(res.ok).toBe(false);
    expect(res.error, JSON.stringify(res, null, 2)).toMatch(/^Checkout/);
    const landing = preparedLanding(res);
    expect(landing.mergedTarget).toBe(true);
    expect(res.hint).toContain("staging was not merged into and not pushed");
    expect(res.hint).toContain(`rks/feat now carries the landing merge commit ${landing.preparedSha}`);
    expect(res.hint).toContain(`origin's copy of rks/feat also holds the landing merge commit ${landing.preparedSha}`);
    expect(revParse(fx.work, "refs/heads/staging")).toBe(landing.targetSha);
    expect(revParse(fx.work, "refs/heads/rks/feat")).toBe(landing.preparedSha);
    expect(lsRemote(fx.work, "rks/feat")).toBe(landing.preparedSha);
  });

  it("push_target refusal: existing guidance kept, plus the merge-commit claim", async () => {
    const fx = shipFixture();
    rejectPushOf(fx.bare, "refs/heads/staging");
    h.gate = { result: PASS };
    const res = await ship(fx);
    expect(res.failedStep, JSON.stringify(res, null, 2)).toBe("push_target");
    const landing = preparedLanding(res);
    expect(landing.mergedTarget).toBe(true);
    expect(res.hint).toContain("git push origin staging");
    expect(res.hint).toContain("rks_cycle_complete");
    expect(res.hint).toContain(`rks/feat now carries the landing merge commit ${landing.preparedSha}`);
    expect(res.hint).toContain(`origin's copy of rks/feat also holds the landing merge commit ${landing.preparedSha}`);
    expect(res.hint).not.toMatch(/not merged into/);
    expect(revParse(fx.work, "refs/heads/rks/feat")).toBe(landing.preparedSha);
    expect(lsRemote(fx.work, "rks/feat")).toBe(landing.preparedSha);
  });
});

// ─── rks_story_ship fixtures ────────────────────────────────────────────────────────────────────

const STORY_ID = "backlog.feat.landing-hints-fixture";
const FEATURE = "rks/test-branch";
const THREE_BRANCH = { working: "staging", integration: "main", production: "prod" };
const TWO_BRANCH = { working: "staging", integration: "staging", production: "main" };

/**
 * staging (init + story note at executed, no testRequirements so the coverage-record gate does not
 * apply) -> rks/test-branch carrying the exec commit; the worktree ends on the feature branch.
 * workingAhead: staging gets a commit the feature branch lacks, so landing preparation merges it.
 * workingOnOrigin: a bare origin receives staging before the ship (the deliverFeatureBranch arm).
 */
function storyFixture({ gate = true, branches = THREE_BRANCH, workingAhead = true, workingOnOrigin = false } = {}) {
  const base = tmpDir("rks-landing-hints-story-");
  const dir = path.join(base, "repo");
  fs.mkdirSync(dir);
  gitOk(dir, ["init", "-q", "-b", "staging"]);
  configIdentity(dir);
  fs.mkdirSync(path.join(dir, "notes"), { recursive: true });
  fs.mkdirSync(path.join(dir, ".rks"), { recursive: true });
  fs.writeFileSync(path.join(dir, "README.md"), "# test\n");
  fs.writeFileSync(path.join(dir, "notes", `${STORY_ID}.md`), formatWithFrontmatter({ id: STORY_ID, status: "not-implemented", phase: "executed" }, "body\n"));
  fs.writeFileSync(path.join(dir, ".rks", "project.json"), JSON.stringify(gate ? { fullSuiteGate: { enabled: true } } : {}, null, 2));
  gitOk(dir, ["add", "-A"]);
  gitOk(dir, ["commit", "-q", "-m", "init"]);
  gitOk(dir, ["checkout", "-q", "-b", FEATURE]);
  fs.writeFileSync(path.join(dir, "work.mjs"), "export const x = 1;\n");
  gitOk(dir, ["add", "work.mjs"]);
  gitOk(dir, ["commit", "-q", "-m", `feat(exec): ${STORY_ID}`, "-m", `Story: ${STORY_ID}`]);
  const execCommit = revParse(dir, "HEAD");
  if (workingAhead) commitOnBranch(dir, base, "staging", "ahead.txt", "staging ahead of the feature branch");
  let bare = null;
  if (workingOnOrigin) {
    bare = path.join(base, "origin.git");
    gitOk(base, ["init", "--bare", "-q", "-b", "staging", bare]);
    gitOk(dir, ["remote", "add", "origin", bare]);
    gitOk(dir, ["push", "-q", "origin", "staging"]);
  }
  h.story = { root: dir, branches: { ...branches } };
  return { base, dir, bare, execCommit };
}

const storyShip = () => runStoryShipTool({ projectId: "test-project", problemId: STORY_ID });
const PRE_CHANGE_GATE_HINT = "Fix the new failing tests (fullSuiteGate.newFailures), or fix fullSuiteGate in .rks/project.json, then retry rks_story_ship";

describe("rks_story_ship landing refusal hints", () => {
  it("landing_verify with mergedTarget true: hint says working is untouched and currentBranch carries preparedSha", async () => {
    const fx = storyFixture();
    h.gate = { result: PASS, before: () => commitOnBranch(fx.dir, fx.base, "staging", "moved.txt", "staging moved after the gate") };
    const res = await storyShip();
    expect(res.ok).toBe(false);
    expect(res.failedStep, JSON.stringify(res, null, 2)).toBe("landing_verify");
    const landing = preparedLanding(res);
    expect(landing.mergedTarget).toBe(true);
    expect(res.hint).toContain("staging was untouched");
    expect(res.hint).toContain(`${FEATURE} now carries the landing merge commit ${landing.preparedSha}`);
    expect(revParse(fx.dir, `refs/heads/${FEATURE}`)).toBe(landing.preparedSha);
    expect(isAncestor(fx.dir, `refs/heads/${FEATURE}`, "refs/heads/staging")).toBe(false);
  });

  it("full-suite block with mergedTarget true: existing guidance kept, plus the merge-commit claim", async () => {
    const fx = storyFixture();
    h.gate = { result: BLOCK };
    const res = await storyShip();
    expect(res.failedStep, JSON.stringify(res, null, 2)).toBe("full_suite_gate");
    const landing = preparedLanding(res);
    expect(landing.mergedTarget).toBe(true);
    expect(res.hint).toContain("fix fullSuiteGate in .rks/project.json");
    expect(res.hint).toContain(`${FEATURE} now carries the landing merge commit ${landing.preparedSha}`);
    expect(revParse(fx.dir, `refs/heads/${FEATURE}`)).toBe(landing.preparedSha);
  });

  it("full-suite block with mergedTarget false: hint is unchanged", async () => {
    const fx = storyFixture({ workingAhead: false });
    h.gate = { result: BLOCK };
    const res = await storyShip();
    expect(res.failedStep, JSON.stringify(res, null, 2)).toBe("full_suite_gate");
    const landing = preparedLanding(res);
    expect(landing.mergedTarget).toBe(false);
    expect(res.hint.startsWith(PRE_CHANGE_GATE_HINT)).toBe(true);
    expect(res.hint).not.toMatch(MERGE_CLAIM);
    expect(res.hint).not.toContain(landing.preparedSha);
    expect(revParse(fx.dir, `refs/heads/${FEATURE}`)).toBe(fx.execCommit);
  });

  it("local_merge refusal in the workingBranchIsLocal arm: guidance kept, working not merged into, currentBranch carries preparedSha", async () => {
    const fx = storyFixture();
    h.gate = { result: PASS, before: (root) => writeHeadLock(root) };
    const res = await storyShip();
    removeHeadLock(fx.dir);
    expect(res.ok).toBe(false);
    expect(res.error, JSON.stringify(res, null, 2)).toMatch(/^Failed at local_merge/);
    const landing = preparedLanding(res);
    expect(landing.mergedTarget).toBe(true);
    expect(res.hint).toContain("Resolve merge conflicts and retry rks_story_ship");
    expect(res.hint).toContain("staging was not merged into");
    expect(res.hint).toContain(`${FEATURE} now carries the landing merge commit ${landing.preparedSha}`);
    expect(revParse(fx.dir, `refs/heads/${FEATURE}`)).toBe(landing.preparedSha);
    expect(revParse(fx.dir, "refs/heads/staging")).toBe(landing.targetSha);
    expect(isAncestor(fx.dir, `refs/heads/${FEATURE}`, "refs/heads/staging")).toBe(false);
  });

  it("local_merge refusal in the deliverFeatureBranch arm: guidance kept, working not merged into, currentBranch carries preparedSha", async () => {
    const fx = storyFixture({ branches: TWO_BRANCH, workingOnOrigin: true });
    const originWorking = lsRemote(fx.dir, "staging");
    expect(originWorking).toMatch(/^[0-9a-f]{40}$/);
    h.gate = { result: PASS, before: (root) => writeHeadLock(root) };
    const res = await storyShip();
    removeHeadLock(fx.dir);
    expect(res.ok).toBe(false);
    expect(res.error, JSON.stringify(res, null, 2)).toMatch(/^Failed at local_merge/);
    const landing = preparedLanding(res);
    expect(landing.mergedTarget).toBe(true);
    expect(res.hint).toContain("Resolve merge conflicts and retry rks_story_ship");
    expect(res.hint).toContain("staging was not merged into");
    expect(res.hint).toContain(`${FEATURE} now carries the landing merge commit ${landing.preparedSha}`);
    expect(revParse(fx.dir, `refs/heads/${FEATURE}`)).toBe(landing.preparedSha);
    expect(revParse(fx.dir, "refs/heads/staging")).toBe(landing.targetSha);
    expect(lsRemote(fx.dir, "staging")).toBe(originWorking);
    expect(isAncestor(fx.dir, `refs/heads/${FEATURE}`, "refs/heads/staging")).toBe(false);
  });

  it("local_merge refusal with mergedTarget false: no merge-commit claim", async () => {
    const fx = storyFixture({ workingAhead: false });
    h.gate = { result: PASS, before: (root) => writeHeadLock(root) };
    const res = await storyShip();
    removeHeadLock(fx.dir);
    expect(res.error, JSON.stringify(res, null, 2)).toMatch(/^Failed at local_merge/);
    const landing = preparedLanding(res);
    expect(landing.mergedTarget).toBe(false);
    expect(res.hint).toContain("Resolve merge conflicts and retry rks_story_ship");
    expect(res.hint).not.toMatch(MERGE_CLAIM);
    expect(res.hint).not.toContain(landing.preparedSha);
    expect(revParse(fx.dir, `refs/heads/${FEATURE}`)).toBe(fx.execCommit);
  });
});

// ─── rks_guardrails_on gate beta fixtures ───────────────────────────────────────────────────────

const OFFRAIL_STORY = "backlog.fix.fixture";
const IN_SCOPE = "packages/mcp-rks/src/example.mjs";

/** The gate-beta fixture of off-rail-ship-enforcement-gate.test.mjs, plus a gate-enabling project.json. */
function offRailFixture({ gate = true, advanceTargetOnBranchCommit = false, branches = null } = {}) {
  const base = tmpDir("rks-landing-hints-offrail-");
  const dir = path.join(base, "repo");
  const bare = path.join(base, "origin.git");
  fs.mkdirSync(dir);
  gitOk(base, ["init", "--bare", "-q", bare]);
  fs.mkdirSync(path.join(dir, "notes"), { recursive: true });
  fs.mkdirSync(path.join(dir, ".rks"), { recursive: true });
  fs.mkdirSync(path.join(dir, "packages", "mcp-rks", "src"), { recursive: true });
  fs.mkdirSync(path.join(dir, ".routekit", "hooks", "write"), { recursive: true });
  fs.mkdirSync(path.join(dir, ".routekit", "hooks", "read"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".gitignore"), [".rks/", ".routekit/hooks.bak/", ""].join("\n"));
  fs.writeFileSync(path.join(dir, ".routekit", "hooks", "write", "w.mjs"), "export default {};\n");
  fs.writeFileSync(path.join(dir, ".routekit", "hooks", "read", "r.mjs"), "export default {};\n");
  fs.writeFileSync(path.join(dir, ".routekit", "hooks-manifest.json"), JSON.stringify({ hooks: [{ name: "w", tier: "write" }, { name: "r", tier: "read" }] }, null, 2));
  fs.writeFileSync(path.join(dir, IN_SCOPE), "export const v = 1;\n");
  fs.writeFileSync(path.join(dir, "notes", `${OFFRAIL_STORY}.md`), [
    "---", `id: "${OFFRAIL_STORY}"`, 'phase: "arch-approved"', "targetFiles:",
    `  - path: "${IN_SCOPE}"`, '    op: "edit"', "---", "", "## Problem", "",
  ].join("\n"));
  const projectJson = { ...(gate ? { fullSuiteGate: { enabled: true } } : {}), ...(branches ? { branches: { ...branches } } : {}) };
  if (gate || branches) fs.writeFileSync(path.join(dir, ".rks", "project.json"), JSON.stringify(projectJson, null, 2));
  gitOk(dir, ["init", "-q"]);
  configIdentity(dir);
  gitOk(dir, ["checkout", "-q", "-b", "staging"]);
  gitOk(dir, ["add", "-A"]);
  gitOk(dir, ["commit", "-q", "-m", "chore: baseline"]);
  gitOk(dir, ["remote", "add", "origin", bare]);
  gitOk(dir, ["push", "-q", "-u", "origin", "staging"]);
  if (advanceTargetOnBranchCommit) {
    // The off-rail branch is cut from staging at ship time, so staging is moved by the first commit
    // made on an off-rail/* branch (the auto-ship's work commit): landing preparation then merges it.
    const marker = path.join(base, "staging-advanced");
    writeHook(path.join(dir, ".git", "hooks"), "post-commit", [
      'case "$(git rev-parse --abbrev-ref HEAD)" in off-rail/*) ;; *) exit 0 ;; esac',
      `[ -f "${marker}" ] && exit 0`,
      `: > "${marker}"`,
      "parent=$(git rev-parse refs/heads/staging)",
      'c=$(git commit-tree "$parent^{tree}" -p "$parent" -m "staging advanced after the off-rail branch was cut")',
      'git update-ref refs/heads/staging "$c" "$parent"',
    ].join("\n"));
  }
  return { base, dir, bare };
}

async function runOffRail(fx) {
  const off = await guardrailsOff(fx.dir, "test", "all", OFFRAIL_STORY, "test-project");
  expect(off.ok, JSON.stringify(off)).toBe(true);
  fs.writeFileSync(path.join(fx.dir, ".rks", "review-policy.yaml"), "enabled: false\n");
  fs.writeFileSync(path.join(fx.dir, IN_SCOPE), "export const v = 2;\n");
  return guardrailsOn(fx.dir, {}, "test-project");
}

describe("rks_guardrails_on gate beta landing halt messages", () => {
  it("full_suite_gate halt with mergedTarget true: message names preparedSha on top of commitId", async () => {
    const fx = offRailFixture({ advanceTargetOnBranchCommit: true });
    h.gate = { result: BLOCK };
    const res = await runOffRail(fx);
    expect(res.haltedAt, JSON.stringify(res, null, 2)).toBe("full_suite_gate");
    const landing = landingOf(res.shipSteps);
    expect(landing?.ok).toBe(true);
    expect(landing.mergedTarget).toBe(true);
    const branchName = res.recoveryBranch;
    expect(res.message).toContain(`${branchName} also carries the landing merge commit ${landing.preparedSha}`);
    expect(res.message).toContain(`on top of the work commit ${res.commitId}`);
    expect(revParse(fx.dir, `refs/heads/${branchName}`)).toBe(landing.preparedSha);
    expect(parentsOf(fx.dir, landing.preparedSha)).toContain(revParse(fx.dir, res.commitId));
  });

  it("landing_verify halt with mergedTarget true: message names preparedSha on top of commitId", async () => {
    const fx = offRailFixture({ advanceTargetOnBranchCommit: true });
    h.gate = { result: PASS, before: () => commitOnBranch(fx.dir, fx.base, "staging", "moved.txt", "staging moved after the gate") };
    const res = await runOffRail(fx);
    expect(res.haltedAt, JSON.stringify(res, null, 2)).toBe("landing_verify");
    const landing = landingOf(res.shipSteps);
    expect(landing.mergedTarget).toBe(true);
    const branchName = res.recoveryBranch;
    expect(res.message).toContain(`${branchName} also carries the landing merge commit ${landing.preparedSha}`);
    expect(res.message).toContain(`on top of the work commit ${res.commitId}`);
    expect(revParse(fx.dir, `refs/heads/${branchName}`)).toBe(landing.preparedSha);
    expect(parentsOf(fx.dir, landing.preparedSha)).toContain(revParse(fx.dir, res.commitId));
  });

  it("full_suite_gate halt with mergedTarget false: message unchanged", async () => {
    const fx = offRailFixture();
    h.gate = { result: BLOCK };
    const res = await runOffRail(fx);
    expect(res.haltedAt, JSON.stringify(res, null, 2)).toBe("full_suite_gate");
    const landing = landingOf(res.shipSteps);
    expect(landing.mergedTarget).toBe(false);
    expect(res.message).toBe(`Off-rail ship halted at full_suite_gate (${BLOCK.reason}). Work is committed on ${res.recoveryBranch}; staging is unchanged.`);
    expect(revParse(fx.dir, `refs/heads/${res.recoveryBranch}`)).toBe(revParse(fx.dir, res.commitId));
  });
});

// ─── rks_guardrails_on gate beta delivery failure ───────────────────────────────────────────────

/** The off-rail branches present in the repo, read back from git. */
const offRailBranchesOf = (dir) => gitOk(dir, ["for-each-ref", "--format=%(refname:short)", "refs/heads/off-rail/"]).split("\n").filter(Boolean);
/**
 * post-checkout hook, installed in the gate stub's before (after landing preparation, before
 * delivery): on the first checkout of <target> it moves every refs/heads/off-rail/* to an unrelated
 * root commit, so the off-rail branch is off preparedSha and the local merge that follows also
 * fails (unrelated histories).
 */
function moveOffRailOnCheckoutOf(fx, target) {
  const marker = path.join(fx.base, `offrail-moved-${++seq}`);
  writeHook(path.join(fx.dir, ".git", "hooks"), "post-checkout", [
    `[ "$(git rev-parse --abbrev-ref HEAD)" = "${target}" ] || exit 0`,
    `[ -f "${marker}" ] && exit 0`,
    `: > "${marker}"`,
    'c=$(git commit-tree "$(git mktree </dev/null)" -m "unrelated root commit")',
    'for r in $(git for-each-ref --format="%(refname)" refs/heads/off-rail/); do git update-ref "$r" "$c"; done',
    "exit 0",
  ].join("\n"));
}
const OFFRAIL_THREE_BRANCH = { working: "staging", integration: "main", production: "prod" };
const LOCAL_MERGE_FAILED = /^Local merge failed: /;

describe("rks_guardrails_on gate beta delivery failure landing merge commit", () => {
  async function localMergeFailure({ branches = null } = {}) {
    const fx = offRailFixture({ advanceTargetOnBranchCommit: true, branches });
    h.gate = { result: PASS, before: (root) => writeHeadLock(root) };
    const res = await runOffRail(fx);
    removeHeadLock(fx.dir);
    expect(res.shipError, JSON.stringify(res, null, 2)).toMatch(LOCAL_MERGE_FAILED);
    const landing = landingOf(res.shipSteps);
    expect(landing?.ok).toBe(true);
    expect(landing.mergedTarget).toBe(true);
    expect(stepNames(res.shipSteps)).toContain("landing_verify");
    return { fx, res, landing };
  }

  function expectLandingMergeCommit(fx, res, landing) {
    const offRail = offRailBranchesOf(fx.dir);
    expect(offRail).toHaveLength(1);
    const [branch] = offRail;
    expect(res.landingMergeCommit, JSON.stringify(res, null, 2)).toBeTruthy();
    expect(res.landingMergeCommit.branch).toBe(branch);
    expect(res.landingMergeCommit.sha).toBe(landing.preparedSha);
    expect(revParse(fx.dir, `refs/heads/${res.landingMergeCommit.branch}`)).toBe(res.landingMergeCommit.sha);
    expect(res.landingMergeCommit.message).toMatch(MERGE_CLAIM);
    expect(res.landingMergeCommit.message).toContain(branch);
    expect(res.landingMergeCommit.message).toContain(landing.preparedSha);
  }

  function expectPinnedObservable(res) {
    expect(res.shipError).toMatch(LOCAL_MERGE_FAILED);
    expect(res.shipError).not.toMatch(MERGE_CLAIM);
    expect(res.failedStage).toBe("integrate");
    expect(res.message).toBe("Failed to auto-ship off-rail changes: " + res.shipError + ". Manual intervention required.");
    expect(res.shipOutcome).toBe("failed");
  }

  function expectNoLandingMergeCommit(res) {
    expect(res).not.toHaveProperty("landingMergeCommit");
    expect(JSON.stringify(res)).not.toMatch(MERGE_CLAIM);
  }

  async function movedBranchFailure({ branches = null } = {}) {
    const fx = offRailFixture({ advanceTargetOnBranchCommit: true, branches });
    h.gate = { result: PASS, before: () => moveOffRailOnCheckoutOf(fx, "staging") };
    const res = await runOffRail(fx);
    expect(res.shipError, JSON.stringify(res, null, 2)).toMatch(LOCAL_MERGE_FAILED);
    const landing = landingOf(res.shipSteps);
    expect(landing?.ok).toBe(true);
    expect(landing.mergedTarget).toBe(true);
    expect(stepNames(res.shipSteps)).toContain("landing_verify");
    const offRail = offRailBranchesOf(fx.dir);
    expect(offRail).toHaveLength(1);
    expect(revParse(fx.dir, `refs/heads/${offRail[0]}`)).not.toBe(landing.preparedSha);
    expectNoLandingMergeCommit(res);
  }

  it("3-branch local merge failure with mergedTarget true: landingMergeCommit names the branch and preparedSha, matching git", async () => {
    const { fx, res, landing } = await localMergeFailure({ branches: OFFRAIL_THREE_BRANCH });
    expectLandingMergeCommit(fx, res, landing);
  });

  it("2-branch local merge failure with mergedTarget true: landingMergeCommit names the branch and preparedSha, matching git", async () => {
    const { fx, res, landing } = await localMergeFailure();
    expectLandingMergeCommit(fx, res, landing);
  });

  it("3-branch local merge failure: shipError, failedStage, message and shipOutcome unchanged", async () => {
    const { res } = await localMergeFailure({ branches: OFFRAIL_THREE_BRANCH });
    expectPinnedObservable(res);
  });

  it("2-branch local merge failure: shipError, failedStage, message and shipOutcome unchanged", async () => {
    const { res } = await localMergeFailure();
    expectPinnedObservable(res);
  });

  it("local merge failure with mergedTarget false: no landingMergeCommit and no merge-commit text", async () => {
    const fx = offRailFixture();
    h.gate = { result: PASS, before: (root) => writeHeadLock(root) };
    const res = await runOffRail(fx);
    removeHeadLock(fx.dir);
    expect(res.shipError, JSON.stringify(res, null, 2)).toMatch(LOCAL_MERGE_FAILED);
    const landing = landingOf(res.shipSteps);
    expect(landing?.ok).toBe(true);
    expect(landing.mergedTarget).toBe(false);
    expectNoLandingMergeCommit(res);
  });

  it("local merge failure with the gate disabled: no landingMergeCommit and no merge-commit text", async () => {
    // staging advances after the off-rail branch is cut, so delivery makes a true merge commit,
    // which pre-merge-commit refuses on staging (the gate stub's before is not invoked here).
    const fx = offRailFixture({ gate: false, advanceTargetOnBranchCommit: true });
    failMergeCommitOn(fx.dir, "staging");
    const res = await runOffRail(fx);
    expect(res.shipError, JSON.stringify(res, null, 2)).toMatch(LOCAL_MERGE_FAILED);
    expect(stepNames(res.shipSteps)).not.toContain("landing_candidate");
    expectNoLandingMergeCommit(res);
  });

  it("2-branch push failure with mergedTarget true: no landingMergeCommit and no merge-commit text", async () => {
    const fx = offRailFixture({ advanceTargetOnBranchCommit: true });
    const originStaging = lsRemote(fx.dir, "staging");
    h.gate = { result: PASS, before: () => rejectPushOf(fx.bare, "refs/heads/staging") };
    const res = await runOffRail(fx);
    expect(res.shipError, JSON.stringify(res, null, 2)).toMatch(/^Push failed: /);
    const landing = landingOf(res.shipSteps);
    expect(landing?.ok).toBe(true);
    expect(landing.mergedTarget).toBe(true);
    expectNoLandingMergeCommit(res);
    expect(lsRemote(fx.dir, "staging")).toBe(originStaging);
    expect(isAncestor(fx.dir, landing.preparedSha, "refs/heads/staging")).toBe(true);
  });

  it("3-branch local merge failure with the branch moved off preparedSha: no landingMergeCommit and no merge-commit text", async () => {
    await movedBranchFailure({ branches: OFFRAIL_THREE_BRANCH });
  });

  it("2-branch local merge failure with the branch moved off preparedSha: no landingMergeCommit and no merge-commit text", async () => {
    await movedBranchFailure();
  });
});

// ─── gate disabled ──────────────────────────────────────────────────────────────────────────────

const landingKeys = (obj) => Object.keys(obj).filter((k) => /landing|featureBranchPushed/i.test(k));

describe("gate disabled adds no landing hint", () => {
  it("rks_ship with the gate absent: no hint and no new field", async () => {
    const fx = shipFixture({ gate: false, reuse: false, targetAhead: false });
    const res = await ship(fx);
    expect(res.ok, JSON.stringify(res, null, 2)).toBe(true);
    expect(res).not.toHaveProperty("hint");
    expect(landingKeys(res)).toEqual([]);
    expect(stepNames(res.steps)).not.toContain("landing_candidate");
    const featureSha = res.steps.find((s) => s.step === "commit")?.fullCommitId;
    expect(isAncestor(fx.work, featureSha, lsRemote(fx.work, "staging"))).toBe(true);
  });

  it("rks_story_ship with the gate absent: no new field and no merge-commit text", async () => {
    storyFixture({ gate: false, branches: TWO_BRANCH, workingAhead: false });
    const res = await storyShip();
    expect(res.ok, JSON.stringify(res, null, 2)).toBe(true);
    expect(landingKeys(res)).toEqual([]);
    expect(stepNames(res.steps)).not.toContain("landing_candidate");
    expect(res.hint ?? "").not.toMatch(MERGE_CLAIM);
    expect(JSON.stringify(res)).not.toMatch(MERGE_CLAIM);
  });

  it("rks_guardrails_on with the gate absent: no new field and no merge-commit text", async () => {
    const fx = offRailFixture({ gate: false });
    const res = await runOffRail(fx);
    expect(res.autoShipped, JSON.stringify(res, null, 2)).toBe(true);
    expect(res.haltedAt).toBeUndefined();
    expect(landingKeys(res)).toEqual([]);
    expect(res).not.toHaveProperty("fullSuiteGate");
    expect(stepNames(res.shipSteps)).not.toContain("landing_candidate");
    expect(res.message).not.toMatch(MERGE_CLAIM);
    expect(isAncestor(fx.dir, res.commitId, lsRemote(fx.dir, "staging"))).toBe(true);
  });

  it("rks_ship refusals with the gate absent: push failure has no hint and push_target hint is unchanged", async () => {
    const pushFx = shipFixture({ gate: false });
    rejectPushOf(pushFx.bare, "refs/heads/rks/feat");
    const pushRes = await ship(pushFx);
    expect(pushRes.error, JSON.stringify(pushRes, null, 2)).toMatch(/^Push failed/);
    expect(pushRes).not.toHaveProperty("hint");
    expect(landingKeys(pushRes)).toEqual([]);
    expect(lsRemote(pushFx.work, "rks/feat")).toBe("");

    const targetFx = shipFixture({ gate: false });
    rejectPushOf(targetFx.bare, "refs/heads/staging");
    const targetRes = await ship(targetFx);
    expect(targetRes.failedStep, JSON.stringify(targetRes, null, 2)).toBe("push_target");
    const commitId = revParse(targetFx.work, "refs/heads/staging");
    expect(targetRes.unpushedMergeCommit).toBe(commitId);
    expect(targetRes.hint).toBe(`The merge of rks/feat into staging is local only (merge commit ${commitId} was not pushed) and rks/feat was kept. Retry with \`git push origin staging\`, then run rks_cycle_complete.`);
    expect(landingKeys(targetRes)).toEqual([]);
  });

  it("rks_story_ship local_merge refusal with the gate absent: hint has no merge-commit text", async () => {
    const fx = storyFixture({ gate: false, workingAhead: false });
    // working checked out in a linked worktree, so localMerge's `git checkout staging` fails.
    gitOk(fx.dir, ["worktree", "add", "-q", path.join(fx.base, "linked"), "staging"]);
    const stagingBefore = revParse(fx.dir, "refs/heads/staging");
    const res = await storyShip();
    expect(res.ok).toBe(false);
    expect(res.error, JSON.stringify(res, null, 2)).toMatch(/^Failed at local_merge/);
    expect(res.hint).toContain("Resolve merge conflicts and retry rks_story_ship");
    expect(stepNames(res.steps)).not.toContain("landing_candidate");
    expect(res.hint).not.toMatch(MERGE_CLAIM);
    expect(revParse(fx.dir, "refs/heads/staging")).toBe(stagingBefore);
  });
});
