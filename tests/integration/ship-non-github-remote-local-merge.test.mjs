// backlog.feat.rks-ship-local-merge-on-non-github-remote
//
// Drives the real runShip against a local bare-repository origin (a non-GitHub URL). A stub `gh`
// that records every invocation to a marker file and exits 1 is prepended to process.env.PATH
// inside each test only (setup() sets it, afterEach restores it), so the PR path is observable
// without touching GitHub.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
// Resolves to the shared stub from tests/setup.mjs; triaged in tests/unit/telemetry-global-mock-triage.test.mjs VERDICTS.
import { ensureTelemetryStorage } from "@routekit/telemetry";

// Short-circuit only the embedding step after commits (no ONNX model load); git semantics stay real.
vi.mock("@routekit/rag/tools", () => ({
  runRagEmbed: vi.fn().mockResolvedValue({ ok: true, addedEmbeddings: 0, removedCount: 0 }),
}));

import { runShip } from "../../packages/mcp-rks/src/server/git/git-ship.mjs";

const T = 15_000;
const GIT_ENV = {
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
};
const git = (cwd, ...args) => spawnSync("git", args, { cwd, encoding: "utf8", timeout: T, env: { ...process.env, ...GIT_ENV } });
function gitOk(cwd, ...args) {
  const r = git(cwd, ...args);
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

const HOOK_MARKER = "PRE-RECEIVE-REJECTED-rks-ship-test-marker";

let base, bare, work, ghMarker, savedPath;

function commitFile(name, content, msg) {
  fs.writeFileSync(path.join(work, name), content);
  gitOk(work, "add", name);
  gitOk(work, "commit", "-m", msg);
  return gitOk(work, "rev-parse", "HEAD");
}

function setup({ pullRequests, pushTarget = true, diverge = false } = {}) {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "rks-ship-nongh-"));
  bare = path.join(base, "origin.git");
  work = path.join(base, "work");
  gitOk(base, "init", "--bare", "-b", "main", bare);
  gitOk(base, "clone", bare, work);
  gitOk(work, "config", "user.email", "t@t");
  gitOk(work, "config", "user.name", "t");
  fs.writeFileSync(path.join(work, "README.md"), "seed\n");
  fs.mkdirSync(path.join(work, ".rks"), { recursive: true });
  const projectJson = pullRequests === undefined ? {} : { ship: { pullRequests } };
  fs.writeFileSync(path.join(work, ".rks", "project.json"), JSON.stringify(projectJson, null, 2));
  // project.json is committed so the tree is clean apart from the feature file (runGitPR
  // refuses on uncommitted changes, which would mask whether gh is reached).
  gitOk(work, "add", "-A");
  gitOk(work, "commit", "-m", "seed");
  gitOk(work, "push", "-u", "origin", "main");
  gitOk(work, "checkout", "-b", "staging");
  if (pushTarget) gitOk(work, "push", "-u", "origin", "staging");

  let divergence = null;
  if (diverge) {
    // origin/staging gets commit R; local staging is reset and gets a distinct commit L.
    const remoteSha = commitFile("remote-only.txt", "r\n", "remote-only commit");
    gitOk(work, "push", "origin", "staging");
    gitOk(work, "reset", "--hard", "HEAD~1");
    const localSha = commitFile("local-only.txt", "l\n", "local-only commit");
    divergence = { remoteSha, localSha };
  }

  const binDir = path.join(base, "bin");
  fs.mkdirSync(binDir);
  ghMarker = path.join(base, "gh-calls.log");
  fs.writeFileSync(path.join(binDir, "gh"), `#!/bin/sh\necho "$@" >> "${ghMarker}"\nexit 1\n`, { mode: 0o755 });
  savedPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${savedPath}`;

  fs.writeFileSync(path.join(work, "feature.txt"), "feature\n");
  return divergence;
}

function installRejectingPreReceive() {
  const hook = path.join(bare, "hooks", "pre-receive");
  fs.writeFileSync(hook, `#!/bin/sh\necho "${HOOK_MARKER}" >&2\nexit 1\n`, { mode: 0o755 });
}

const ship = () => runShip({ projectRoot: work, message: "ship feature", scope: "test", type: "feat", files: ["feature.txt"] });
const featureSha = (res) => res.steps.find((s) => s.step === "commit")?.fullCommitId;
const bareRef = (ref) => git(bare, "rev-parse", "--verify", "--quiet", `refs/heads/${ref}`);

beforeEach(() => {
  vi.mocked(ensureTelemetryStorage)().emit.mockClear();
});

afterEach(() => {
  if (savedPath !== undefined) process.env.PATH = savedPath;
  if (base) fs.rmSync(base, { recursive: true, force: true });
  base = savedPath = undefined;
});

describe("rks_ship on a non-GitHub origin", () => {
  it("auto (absent): merges locally, pushes the target, never invokes gh", async () => {
    setup();
    const res = await ship();
    expect(res.ok, JSON.stringify(res, null, 2)).toBe(true);
    expect(fs.existsSync(ghMarker)).toBe(false);
    expect(res.steps).toContainEqual(expect.objectContaining({ step: "pr", skipped: true, reason: "non_github_remote" }));
    expect(res.steps).toContainEqual(expect.objectContaining({ step: "merge", ok: true, localMerge: true, pushed: true }));

    const sha = featureSha(res);
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    const remoteTarget = bareRef("staging");
    expect(remoteTarget.status).toBe(0);
    // The remote target's history contains the feature commit.
    expect(git(bare, "merge-base", "--is-ancestor", sha, remoteTarget.stdout.trim()).status).toBe(0);
    expect(git(bare, "log", "--format=%s", "staging").stdout).toContain("ship feature");
  });

  it("never: local path with reason pull_requests_never, gh never invoked", async () => {
    setup({ pullRequests: "never" });
    const res = await ship();
    expect(res.ok, JSON.stringify(res, null, 2)).toBe(true);
    expect(fs.existsSync(ghMarker)).toBe(false);
    expect(res.steps).toContainEqual(expect.objectContaining({ step: "pr", skipped: true, reason: "pull_requests_never" }));
    expect(res.steps).toContainEqual(expect.objectContaining({ step: "merge", ok: true, localMerge: true, pushed: true }));
    expect(git(bare, "merge-base", "--is-ancestor", featureSha(res), "staging").status).toBe(0);
  });

  it("always: gh is invoked with pr create --base staging (runGitPR path unchanged)", async () => {
    setup({ pullRequests: "always" });
    const res = await ship();
    // The stub gh exits 1, so runGitPR fails exactly as it does on a non-GitHub remote today.
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/^PR creation failed/);
    expect(fs.existsSync(ghMarker)).toBe(true);
    const calls = fs.readFileSync(ghMarker, "utf8");
    expect(calls.startsWith("pr create --base staging ")).toBe(true);
    expect(res.steps.find((s) => s.step === "merge")).toBeUndefined();
  });

  it("rejected push of the target (pre-receive hook exits 1): ok false, failedStep push_target, hook message in error, merge kept locally, ship.failed recorded", async () => {
    setup();
    const remoteBefore = bareRef("staging").stdout.trim();
    installRejectingPreReceive();
    const res = await ship();

    expect(res.ok).toBe(false);
    expect(res.failedStep).toBe("push_target");
    expect(res.error).toContain(HOOK_MARKER);
    expect(fs.existsSync(ghMarker)).toBe(false);

    // The local target still carries the merge of the feature commit; the remote is unchanged.
    const sha = featureSha(res);
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(git(work, "merge-base", "--is-ancestor", sha, "refs/heads/staging").status).toBe(0);
    expect(git(work, "rev-list", "--parents", "-n", "1", "refs/heads/staging").stdout.trim().split(/\s+/)).toHaveLength(3);
    expect(bareRef("staging").stdout.trim()).toBe(remoteBefore);

    const emit = vi.mocked(ensureTelemetryStorage)().emit;
    const failed = emit.mock.calls.filter((c) => c[0] === "ship.failed" && c[2]?.step === "push_target");
    expect(failed).toHaveLength(1);
    expect(failed[0][2]).toMatchObject({ step: "push_target" });
    expect(failed[0][2].error).toContain(HOOK_MARKER);

    // backlog.fix.ship-local-merge-push-target-hint: observed HEAD, unpushed merge commit, retry hint.
    expect(res.headBranch).toBe("staging");
    expect(res.headBranch).toBe(gitOk(work, "rev-parse", "--abbrev-ref", "HEAD"));

    const localStaging = gitOk(work, "rev-parse", "refs/heads/staging");
    expect(res.unpushedMergeCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(res.unpushedMergeCommit).toBe(localStaging);
    expect(gitOk(work, "rev-list", "--parents", "-n", "1", res.unpushedMergeCommit).split(/\s+/)).toHaveLength(3);

    const mergeStep = res.steps.find((s) => s.step === "merge");
    expect(mergeStep).toBeDefined();
    expect(res.unpushedMergeCommit).toBe(mergeStep.commitId);
    expect(mergeStep.pushed).toBe(false);
    expect(mergeStep.localMerge).toBe(true);
    expect(mergeStep.commitId).not.toBeNull();

    expect(typeof res.hint).toBe("string");
    expect(res.hint).toContain("git push origin staging");
    expect(res.hint).toContain("rks_cycle_complete");

    // Feature branch kept locally; remote staging unchanged.
    expect(typeof mergeStep.from).toBe("string");
    expect(git(work, "rev-parse", "--verify", `refs/heads/${mergeStep.from}`).status).toBe(0);
    expect(bareRef("staging").stdout.trim()).toBe(remoteBefore);
  });

  it("successful local-merge ship carries no hint, headBranch or unpushedMergeCommit", async () => {
    setup();
    const res = await ship();
    expect(res.ok, JSON.stringify(res, null, 2)).toBe(true);
    expect(res).not.toHaveProperty("hint");
    expect(res).not.toHaveProperty("headBranch");
    expect(res).not.toHaveProperty("unpushedMergeCommit");
  });

  it("diverged local target vs origin/<target>: refused before merge, both SHAs unchanged, gh never invoked", async () => {
    const { remoteSha, localSha } = setup({ diverge: true });
    const res = await ship();

    expect(res.ok).toBe(false);
    expect(res.error).toContain("staging");
    expect(res.error).toMatch(/diverged from origin/);
    expect(gitOk(work, "rev-parse", "refs/heads/staging")).toBe(localSha);
    expect(bareRef("staging").stdout.trim()).toBe(remoteSha);
    expect(fs.existsSync(ghMarker)).toBe(false);
    expect(res.steps.find((s) => s.step === "merge")).toBeUndefined();
  });

  it("target absent on the remote: existing has-no-remote local-merge reason, bare repo still has no target ref", async () => {
    setup({ pushTarget: false });
    const res = await ship();

    expect(res.ok, JSON.stringify(res, null, 2)).toBe(true);
    expect(res.steps).toContainEqual(expect.objectContaining({ step: "pr", skipped: true, reason: "staging has no remote — used local merge" }));
    expect(bareRef("staging").status).not.toBe(0);
    expect(fs.existsSync(ghMarker)).toBe(false);
  });
});
