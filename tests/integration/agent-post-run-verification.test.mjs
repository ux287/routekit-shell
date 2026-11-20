/**
 * backlog.feat.escalation-safe-side-effecting-agents - guard 1, per agent (ship, story, recovery).
 * Mock tier: real git in os.tmpdir() repos, recording gh fake, scripted LLM client.
 * Run: npx vitest run --config vitest.config.mock.mjs tests/integration/agent-post-run-verification.test.mjs
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ghCalls = [];
let ghState = { pr: null };
vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    spawnSync: (cmd, args = [], opts = {}) => {
      if (cmd === "gh") {
        ghCalls.push(args);
        if (ghState.fail) return { status: 1, stdout: "", stderr: "gh: simulated failure" };
        return { status: 0, stdout: JSON.stringify(ghState.pr ?? {}), stderr: "" };
      }
      return actual.spawnSync(cmd, args, { timeout: 15_000, ...opts });
    },
  };
});

const { spawnSync: realSpawn } = await vi.importActual("child_process");
const { runAgent } = await import("../../packages/mcp-rks/src/agents/runner.mjs");
const { createShipAgent } = await import("../../packages/mcp-rks/src/agents/ship.mjs");
const { createStoryAgent } = await import("../../packages/mcp-rks/src/agents/story.mjs");
const { createRecoveryAgent } = await import("../../packages/mcp-rks/src/agents/recovery.mjs");

import { fileURLToPath } from "node:url";
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const HAIKU = "claude-haiku-5-5";
const SONNET = "claude-sonnet-5-5";

function git(cwd, ...args) {
  const r = realSpawn("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", timeout: 15_000 });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}
function makeTempRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rks-verify-"));
  expect(fs.realpathSync(root).startsWith(fs.realpathSync(REPO_ROOT))).toBe(false);
  git(root, "init", "-q", "-b", "staging");
  fs.writeFileSync(path.join(root, "a.txt"), "a\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "init");
  return root;
}
function scriptedClient(calls, final) {
  return { messages: { create: async (args) => { calls.push(args.model); return { content: [{ type: "text", text: JSON.stringify(final(calls.length)) }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }; } } };
}
const collector = () => ({ emit: () => {} });

let root;
beforeEach(() => { ghCalls.length = 0; ghState = { pr: null }; root = makeTempRepo(); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe("ship: claims are checked against git and gh, not the agent output", () => {
  // QA: not a HEAD comparison - a successful merge_pr checks out staging (git-release.mjs:140), so a
  // correct data.branch differs from HEAD. The check is that a claimed, unmerged branch exists locally or on origin.
  it("claimed branch exists neither locally nor on origin -> ok:false naming branch, escalated", async () => {
    const calls = [];
    const cfg = createShipAgent({ projectId: "t", projectRoot: root });
    const result = await runAgent({ ...cfg, _testCollector: collector(), _testClient: scriptedClient(calls, () => ({ ok: true, summary: "s", data: { branch: "feature/not-real" } })) });
    expect(calls).toEqual([HAIKU, SONNET]);
    expect(result.ok).toBe(false);
    expect(String(result.error)).toMatch(/branch/i);
  });

  it("claimed merged:true while the gh fake reports the PR OPEN -> ok:false naming merged", async () => {
    ghState.pr = { number: 7, state: "OPEN", mergedAt: null };
    const calls = [];
    const cfg = createShipAgent({ projectId: "t", projectRoot: root });
    const result = await runAgent({ ...cfg, _testCollector: collector(), _testClient: scriptedClient(calls, () => ({ ok: true, summary: "s", data: { prNumber: 7, merged: true } })) });
    expect(result.ok).toBe(false);
    expect(String(result.error)).toMatch(/merged/i);
  });

  it("claims that match observed state pass with one call", async () => {
    const calls = [];
    const branch = git(root, "rev-parse", "--abbrev-ref", "HEAD");
    const cfg = createShipAgent({ projectId: "t", projectRoot: root });
    const result = await runAgent({ ...cfg, _testCollector: collector(), _testClient: scriptedClient(calls, () => ({ ok: true, summary: "s", data: { branch } })) });
    expect(calls).toEqual([HAIKU]);
    expect(result.ok).toBe(true);
  });
});

describe("story: reported phase is checked against the note on disk", () => {
  it("reported phase planned while the note says ready -> ok:false naming phase", async () => {
    fs.mkdirSync(path.join(root, "notes"), { recursive: true });
    fs.writeFileSync(path.join(root, "notes", "backlog.t.s.md"), "---\nid: backlog.t.s\nphase: ready\n---\n");
    const calls = [];
    const cfg = createStoryAgent({ projectId: "t", storyId: "backlog.t.s", action: "advance", projectRoot: root });
    const result = await runAgent({ ...cfg, _testCollector: collector(), _testClient: scriptedClient(calls, () => ({ ok: true, summary: "s", data: { storyId: "backlog.t.s", phase: "planned", phaseAdvanced: { from: "ready", to: "planned" } } })) });
    expect(result.ok).toBe(false);
    expect(String(result.error)).toMatch(/phase/i);
  });
});

describe("unobservable state leaves ok unchanged and is reported as unverified", () => {
  it("ship: gh pr view fails -> ok true, one call, verification.observed false naming gh", async () => {
    ghState.fail = true;
    const calls = [];
    const cfg = createShipAgent({ projectId: "t", projectRoot: root });
    const result = await runAgent({ ...cfg, _testCollector: collector(), _testClient: scriptedClient(calls, () => ({ ok: true, summary: "s", data: { prNumber: 7, merged: true } })) });
    expect(calls).toEqual([HAIKU]);
    expect(result.ok).toBe(true);
    expect(result.verification?.observed).toBe(false);
    expect(String(result.verification?.reason)).toMatch(/gh/i);
  });

  it("story: note file absent -> ok true, one call, verification.observed false naming the note", async () => {
    const calls = [];
    const cfg = createStoryAgent({ projectId: "t", storyId: "backlog.t.missing", action: "advance", projectRoot: root });
    const result = await runAgent({ ...cfg, _testCollector: collector(), _testClient: scriptedClient(calls, () => ({ ok: true, summary: "s", data: { storyId: "backlog.t.missing", phase: "planned" } })) });
    expect(calls).toEqual([HAIKU]);
    expect(result.ok).toBe(true);
    expect(result.verification?.observed).toBe(false);
    expect(String(result.verification?.reason)).toMatch(/note/i);
  });
});

describe("recovery: reported git fix is checked against git state", () => {
  it("fixes claims git area ok while the tree is still dirty -> ok:false naming the mismatch", async () => {
    fs.writeFileSync(path.join(root, "a.txt"), "dirty\n");
    const calls = [];
    const cfg = createRecoveryAgent({ projectId: "t", projectRoot: root });
    const result = await runAgent({ ...cfg, _testCollector: collector(), _testClient: scriptedClient(calls, () => ({ ok: true, summary: "s", toolsUsed: ["fix_git"], data: { diagnosis: { gitHealthy: true }, fixes: [{ area: "git", action: "clean dirty state", ok: true }], remainingIssues: [] } })) });
    expect(result.ok).toBe(false);
    expect(String(result.error)).toMatch(/git|dirty/i);
  });

  it("the same claim on a clean tree passes with one call", async () => {
    const calls = [];
    const cfg = createRecoveryAgent({ projectId: "t", projectRoot: root });
    const result = await runAgent({ ...cfg, _testCollector: collector(), _testClient: scriptedClient(calls, () => ({ ok: true, summary: "s", toolsUsed: ["fix_git"], data: { diagnosis: { gitHealthy: true }, fixes: [], remainingIssues: [] } })) });
    expect(calls).toEqual([HAIKU]);
    expect(result.ok).toBe(true);
  });

  // backlog.fix.recovery-verifier-diagnosis-only-dirty-tree: a dirty tree refutes only a claimed
  // clean-up (limb a) or a claimed nothing-wrong (limb b), never gitHealthy:true alone.
  const dirty = () => fs.writeFileSync(path.join(root, "a.txt"), "dirty\n");
  const output = ({ toolsUsed = ["diagnose"], issues, fixes, remainingIssues = [] } = {}) => {
    const diagnosis = { gitHealthy: true };
    if (issues !== undefined) diagnosis.issues = issues;
    const data = { diagnosis, remainingIssues };
    if (fixes !== undefined) data.fixes = fixes;
    return { ok: true, summary: "s", toolsUsed, data };
  };
  const run = async (out) => {
    const calls = [];
    const cfg = createRecoveryAgent({ projectId: "t", projectRoot: root });
    const result = await runAgent({ ...cfg, _testCollector: collector(), _testClient: scriptedClient(calls, () => out) });
    return { calls, result };
  };
  const CLEAN_UP_REFUTED = /claimed git clean-up refuted/i;
  const NO_ISSUES_REFUTED = /no-issues claim refuted/i;

  const diagnosisOnly = output({ issues: ["git: 1 dirty files"] });
  const claimedCleanUp = output({ toolsUsed: ["diagnose", "fix_git"], issues: ["git: 1 dirty files"], fixes: [{ area: "git", action: "clean dirty state", ok: true }] });
  const claimedStash = output({ toolsUsed: ["diagnose", "fix_git"], issues: ["git: 1 dirty files"], fixes: [{ area: "git", action: "stash uncommitted changes", ok: true }] });
  const claimedCommit = output({ toolsUsed: ["diagnose", "fix_git"], issues: ["git: 1 dirty files"], fixes: [{ area: "git", action: "commit pending changes", ok: true }] });
  const gitOk = output({ issues: ["git: ok"] });
  const nothingWrongAbsent = output({});
  const nothingWrongEmpty = output({ issues: [] });

  it("diagnosis-only run on a dirty tree (gitHealthy true + 'git: 1 dirty files', no fixes) passes, not escalated", async () => {
    dirty();
    const { calls, result } = await run(diagnosisOnly);
    expect(calls).toEqual([HAIKU]);
    expect(result.ok).toBe(true);
  });

  it("acknowledgement without the git prefix ('working tree has uncommitted changes') passes", async () => {
    dirty();
    const { calls, result } = await run(output({ issues: ["working tree has uncommitted changes"] }));
    expect(calls).toEqual([HAIKU]);
    expect(result.ok).toBe(true);
  });

  it("claimed clean-up on an acknowledged dirty tree is still refuted", async () => {
    dirty();
    const { result } = await run(claimedCleanUp);
    expect(result.ok).toBe(false);
    expect(String(result.error)).toMatch(/clean/i);
    expect(String(result.error)).toMatch(CLEAN_UP_REFUTED);
  });

  it("claimed stash on an acknowledged dirty tree is refuted (limb a vocabulary includes stash)", async () => {
    dirty();
    const { result } = await run(claimedStash);
    expect(result.ok).toBe(false);
    expect(String(result.error)).toMatch(CLEAN_UP_REFUTED);
    expect(String(result.error)).toMatch(/stash uncommitted changes/);
  });

  it("claimed commit on an acknowledged dirty tree is refuted (limb a vocabulary includes commit)", async () => {
    dirty();
    const { result } = await run(claimedCommit);
    expect(result.ok).toBe(false);
    expect(String(result.error)).toMatch(CLEAN_UP_REFUTED);
    expect(String(result.error)).toMatch(/commit pending changes/);
  });

  it("claimed nothing wrong (issues absent, and separately []) on a dirty tree is refuted with a distinct no-issues error", async () => {
    dirty();
    for (const out of [nothingWrongAbsent, nothingWrongEmpty]) {
      const { result } = await run(out);
      expect(result.ok).toBe(false);
      expect(String(result.error)).toMatch(NO_ISSUES_REFUTED);
      expect(String(result.error)).not.toMatch(CLEAN_UP_REFUTED);
    }
    const { result: cleanUp } = await run(claimedCleanUp);
    const { result: noIssues } = await run(nothingWrongEmpty);
    expect(String(noIssues.error)).not.toBe(String(cleanUp.error));
  });

  it("a git-prefixed issue ('git: ok') is not an acknowledgement -> refuted as the no-issues claim", async () => {
    dirty();
    const { result } = await run(gitOk);
    expect(result.ok).toBe(false);
    expect(String(result.error)).toMatch(NO_ISSUES_REFUTED);
  });

  it("a non-claim fix does not trigger limb (a): failed git clean-up, and a successful non-git fix, both pass", async () => {
    dirty();
    for (const fixes of [[{ area: "git", action: "clean dirty state", ok: false }], [{ area: "locks", action: "reset stale lock", ok: true }]]) {
      const { result } = await run(output({ toolsUsed: ["diagnose", "fix_git"], issues: ["git: 1 dirty files"], fixes }));
      expect(result.ok).toBe(true);
    }
  });

  it("on a clean tree every one of the above outputs passes with one call", async () => {
    for (const out of [diagnosisOnly, claimedCleanUp, claimedStash, claimedCommit, gitOk, nothingWrongAbsent, nothingWrongEmpty]) {
      const { calls, result } = await run(out);
      expect(calls).toEqual([HAIKU]);
      expect(result.ok).toBe(true);
    }
  });

  it("a failed git status yields cannot-observe (observed false, reason 'git status failed')", () => {
    fs.writeFileSync(path.join(root, ".git", "index"), "garbage, not a git index\n");
    const cfg = createRecoveryAgent({ projectId: "t", projectRoot: root });
    const verdict = cfg.verify({ ok: true, data: { diagnosis: { gitHealthy: true }, remainingIssues: [] } });
    expect(verdict.observed).toBe(false);
    expect(String(verdict.reason).startsWith("git status failed")).toBe(true);
  });

  it("diagnose semantics unchanged: a dirty-only tree reports gitHealthy true plus 'git: 1 dirty files'", async () => {
    dirty();
    const cfg = createRecoveryAgent({ projectId: "t", projectRoot: root });
    const out = await cfg.tools.find((t) => t.name === "diagnose").execute();
    const diagnosis = out.diagnosis ?? out;
    expect(diagnosis.gitHealthy).toBe(true);
    expect(diagnosis.issues).toContain("git: 1 dirty files");
  });
});
