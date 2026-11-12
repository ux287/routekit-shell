/**
 * backlog.feat.escalation-safe-side-effecting-agents - guards 2 and 3 for ship.
 * Mock tier: real git in os.tmpdir() repos with a local bare origin, recording gh fake.
 * Run: npx vitest run --config vitest.config.mock.mjs tests/integration/ship-side-effect-guards.test.mjs
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ghCalls = [];
let pr = {};
vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    spawnSync: (cmd, args = [], opts = {}) => {
      if (cmd === "gh") {
        ghCalls.push(args);
        if (args[0] === "pr" && args[1] === "merge") { pr = { ...pr, state: "MERGED" }; return { status: 0, stdout: "", stderr: "" }; }
        return { status: 0, stdout: JSON.stringify(pr), stderr: "" };
      }
      return actual.spawnSync(cmd, args, { timeout: 15_000, ...opts });
    },
  };
});

const { spawnSync: realSpawn } = await vi.importActual("child_process");
const shipModule = await import("../../packages/mcp-rks/src/agents/ship.mjs");
// Every factory call here carries a storyId, so these guard tests exercise the story-linked path.
// The storyless path (unlinked reason 'infrastructure') is covered in ship-storyless-unlinked-reason.test.mjs.
const createShipAgent = (opts) => shipModule.createShipAgent({ storyId: "backlog.t.s", ...opts });

import { fileURLToPath } from "node:url";
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const GREEN = [{ __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }];
const RED = [{ __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "FAILURE" }];
const PENDING = [{ __typename: "CheckRun", name: "ci", status: "IN_PROGRESS", conclusion: null }];

function git(cwd, ...args) {
  const r = realSpawn("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", timeout: 15_000 });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}
function makeRepoWithOrigin() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "rks-ship-guard-"));
  expect(fs.realpathSync(base).startsWith(fs.realpathSync(REPO_ROOT))).toBe(false);
  const origin = path.join(base, "origin.git");
  const work = path.join(base, "work");
  git(base, "init", "-q", "--bare", origin);
  git(base, "clone", "-q", origin, work);
  // Repo-local identity: production local_merge / prepare_and_push commit through
  // their own git calls, which do not see this helper's -c flags. CI runners have
  // no global identity (backlog.fix.mock-tier-temp-repo-git-identity).
  git(work, "config", "user.name", "t");
  git(work, "config", "user.email", "t@t");
  git(work, "config", "commit.gpgsign", "false");
  git(work, "checkout", "-q", "-b", "staging");
  fs.writeFileSync(path.join(work, "a.txt"), "a\n");
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", "init");
  git(work, "push", "-q", "origin", "staging");
  git(work, "checkout", "-q", "-b", "feature/x");
  return { base, origin, work };
}
const tool = (cfg, name) => cfg.tools.find((t) => t.name === name);
const mergeCalls = () => ghCalls.filter((a) => a[0] === "pr" && a[1] === "merge");

let repo;
beforeEach(() => { ghCalls.length = 0; pr = {}; repo = makeRepoWithOrigin(); });
afterEach(() => { fs.rmSync(repo.base, { recursive: true, force: true }); });

describe("merge_pr refuses unless CI is green and the PR is mergeable", () => {
  for (const [label, rollup, mergeable] of [
    ["REGRESSION GUARD (git-release.mjs:135): red CI", RED, "MERGEABLE"],
    ["REGRESSION GUARD (git-release.mjs:133): pending CI", PENDING, "MERGEABLE"],
    ["red-first: conflicting", GREEN, "CONFLICTING"],
    ["red-first: unknown mergeability", GREEN, "UNKNOWN"],
    ["red-first: no CI checks", [], "MERGEABLE"],
  ]) {
    it(`${label}: structured refusal, no merge performed`, async () => {
      pr = { number: 7, state: "OPEN", mergeable, statusCheckRollup: rollup };
      const stagingBefore = git(repo.origin, "rev-parse", "staging");
      const res = await tool(createShipAgent({ projectId: "t", projectRoot: repo.work }), "merge_pr").execute({ prNumber: 7 });
      // merge_pr's refusal shape today is { error, hint } (ship.mjs:364); assert on merged/error, not ok.
      expect(res.merged).not.toBe(true);
      expect(res.error ?? res.refused).toBeTruthy();
      expect(JSON.stringify(res)).toMatch(/refus|mergeable|CI/i);
      expect(mergeCalls()).toHaveLength(0);
      expect(git(repo.origin, "rev-parse", "staging")).toBe(stagingBefore);
    });
  }

  it("positive control: green and mergeable -> merge proceeds exactly once", async () => {
    pr = { number: 7, state: "OPEN", mergeable: "MERGEABLE", statusCheckRollup: GREEN };
    const res = await tool(createShipAgent({ projectId: "t", projectRoot: repo.work }), "merge_pr").execute({ prNumber: 7 });
    expect(mergeCalls()).toHaveLength(1);
    expect(res.merged).toBe(true);
  });

  it("red-first: PR already MERGED -> no pr merge invocation, reports already merged", async () => {
    pr = { number: 7, state: "MERGED", mergeable: "UNKNOWN", statusCheckRollup: GREEN };
    const res = await tool(createShipAgent({ projectId: "t", projectRoot: repo.work }), "merge_pr").execute({ prNumber: 7 });
    expect(mergeCalls()).toHaveLength(0);
    expect(res.merged).toBe(true);
    expect(JSON.stringify(res)).toMatch(/already/i);
  });
});

describe("local_merge refuses on a dirty tree or an unexpected base (target is local-only)", () => {
  // QA: local_merge only acts when the target has no remote (ship.mjs:378), so it gets a repo with no origin.
  let local;
  beforeEach(() => {
    local = fs.mkdtempSync(path.join(os.tmpdir(), "rks-local-merge-"));
    expect(fs.realpathSync(local).startsWith(fs.realpathSync(REPO_ROOT))).toBe(false);
    git(local, "init", "-q", "-b", "staging");
    git(local, "config", "user.name", "t");
    git(local, "config", "user.email", "t@t");
    git(local, "config", "commit.gpgsign", "false");
    fs.writeFileSync(path.join(local, "a.txt"), "a\n");
    git(local, "add", "-A");
    git(local, "commit", "-q", "-m", "init");
    git(local, "branch", "main");
    git(local, "checkout", "-q", "-b", "feature/x");
    fs.writeFileSync(path.join(local, "c.txt"), "c\n");
    git(local, "add", "-A");
    git(local, "commit", "-q", "-m", "feat: c");
  });
  afterEach(() => { fs.rmSync(local, { recursive: true, force: true }); });

  it("red-first: dirty tree -> refusal; refs, HEAD and file unchanged", async () => {
    fs.writeFileSync(path.join(local, "a.txt"), "uncommitted\n");
    const before = git(local, "for-each-ref");
    const res = await tool(createShipAgent({ projectId: "t", projectRoot: local }), "local_merge").execute({});
    expect(res.merged).not.toBe(true);
    expect(JSON.stringify(res)).toMatch(/dirty|uncommitted/i);
    expect(git(local, "for-each-ref")).toBe(before);
    expect(git(local, "rev-parse", "--abbrev-ref", "HEAD")).toBe("feature/x");
    expect(fs.readFileSync(path.join(local, "a.txt"), "utf8")).toBe("uncommitted\n");
  });

  it("red-first: HEAD on main -> refusal; main neither merged into staging nor deleted", async () => {
    git(local, "checkout", "-q", "main");
    const before = git(local, "for-each-ref");
    const res = await tool(createShipAgent({ projectId: "t", projectRoot: local }), "local_merge").execute({});
    expect(res.merged).not.toBe(true);
    expect(JSON.stringify(res)).toMatch(/base|branch/i);
    expect(git(local, "for-each-ref")).toBe(before);
  });

  it("positive control: a clean feature branch merges", async () => {
    const res = await tool(createShipAgent({ projectId: "t", projectRoot: local }), "local_merge").execute({});
    expect(res.merged).toBe(true);
  });
});

describe("sync_staging refuses on an unexpected base or a dirty tree (target has a remote)", () => {
  beforeEach(() => {
    git(repo.work, "checkout", "-q", "staging");
    git(repo.work, "checkout", "-q", "-b", "main");
    fs.writeFileSync(path.join(repo.work, "m.txt"), "m\n");
    git(repo.work, "add", "-A");
    git(repo.work, "commit", "-q", "-m", "release");
    git(repo.work, "checkout", "-q", "feature/x");
  });

  it("red-first: HEAD on feature/x -> refusal; local and origin refs unchanged", async () => {
    const before = git(repo.work, "for-each-ref");
    const originBefore = git(repo.origin, "for-each-ref");
    const res = await tool(createShipAgent({ projectId: "t", projectRoot: repo.work }), "sync_staging").execute({});
    expect(res.synced).not.toBe(true);
    expect(JSON.stringify(res)).toMatch(/base|branch/i);
    expect(git(repo.work, "for-each-ref")).toBe(before);
    expect(git(repo.origin, "for-each-ref")).toBe(originBefore);
  });

  it("REGRESSION GUARD (runPromote refuses at git-release.mjs:1474): dirty staging -> refusal", async () => {
    git(repo.work, "checkout", "-q", "staging");
    fs.writeFileSync(path.join(repo.work, "a.txt"), "uncommitted\n");
    const before = git(repo.work, "for-each-ref");
    const res = await tool(createShipAgent({ projectId: "t", projectRoot: repo.work }), "sync_staging").execute({});
    expect(res.synced).not.toBe(true);
    expect(JSON.stringify(res)).toMatch(/dirty|uncommitted/i);
    expect(git(repo.work, "for-each-ref")).toBe(before);
    expect(fs.readFileSync(path.join(repo.work, "a.txt"), "utf8")).toBe("uncommitted\n");
  });

  it("positive control: clean staging with main one commit ahead syncs", async () => {
    git(repo.work, "checkout", "-q", "staging");
    const res = await tool(createShipAgent({ projectId: "t", projectRoot: repo.work }), "sync_staging").execute({});
    expect(res.synced).toBe(true);
  });
});

describe("an escalated rerun does not repeat a side effect", () => {
  it("merge_pr invoked by the primary run and again by the escalated run merges once", async () => {
    pr = { number: 7, state: "OPEN", mergeable: "MERGEABLE", statusCheckRollup: GREEN };
    const first = await tool(createShipAgent({ projectId: "t", projectRoot: repo.work }), "merge_pr").execute({ prNumber: 7 });
    const second = await tool(createShipAgent({ projectId: "t", projectRoot: repo.work }), "merge_pr").execute({ prNumber: 7 });
    expect(mergeCalls()).toHaveLength(1);
    // merge_pr's success shape is { merged: true, commitId } (ship.mjs:365) - no ok field.
    expect(first.merged).toBe(true);
    expect(second.merged).toBe(true);
    expect(JSON.stringify(second)).toMatch(/already/i);
  });

  // REGRESSION GUARD: already true today (ship.mjs:254-256 return committed false when there is nothing to commit).
  it("prepare_and_push invoked twice pushes one commit", async () => {
    fs.writeFileSync(path.join(repo.work, "b.txt"), "b\n");
    const cfg = () => createShipAgent({ projectId: "t", projectRoot: repo.work });
    await tool(cfg(), "prepare_and_push").execute({ branchName: "feature/x", commitMessage: "feat: b" });
    const second = await tool(cfg(), "prepare_and_push").execute({ branchName: "feature/x", commitMessage: "feat: b" });
    expect(git(repo.origin, "rev-list", "--count", "staging..feature/x")).toBe("1");
    expect(second.committed).toBe(false);
    expect(second.pushed).toBe(false);
  });
});
