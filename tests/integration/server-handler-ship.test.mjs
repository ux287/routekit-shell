/**
 * S7 ship/workflow family: real-session evidence through createServer() for the nine handlers
 * moved into packages/mcp-rks/src/server/handlers/ship.mjs
 * (backlog.feat.server-mjs-ship-handler-family, SI-TR1..SI-TR8). Every ship entry point is a
 * vi.fn EXCEPT runGitMerge inside SI-TR3/SI-TR4, which runs for real ONLY against an
 * os.tmpdir() git fixture that has no remote (asserted) and does not lie under the repository.
 * The real repository's HEAD, branch, porcelain, stash list and every notes/ phase line are
 * snapshotted before and after, so a body that escaped the fixture fails here. Every spawn
 * carries an explicit timeout. Under vitest NODE_ENV is "test", so server.mjs skips the
 * protected-tool gate and an untokened call reaches the registry without an agent auto-route.
 * NODE_ENV does NOT skip runPreflight, which server.mjs runs before the registry seam: its
 * release_ready check refuses rks_release off "staging", so SI-TR2 pins that refusal with
 * RKS_SKIP_PREFLIGHT unset and drives runRelease with RKS_SKIP_PREFLIGHT="1" (saved, restored).
 * Argument projection and spy-level chain-state pass-through: tests/unit/server-handler-ship.test.mjs.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const h = vi.hoisted(() => ({
  runShip: vi.fn(),
  runGitPR: vi.fn(),
  runGitMerge: vi.fn(),
  runCycleComplete: vi.fn(),
  runPromote: vi.fn(),
  runSyncStaging: vi.fn(),
  runStagingMerge: vi.fn(),
  runRelease: vi.fn(),
  runStoryShipTool: vi.fn(),
  actual: {},
}));

vi.mock("@routekit/rag/tools", () => ({
  runRagEmbed: vi.fn().mockResolvedValue({ ok: true, addedEmbeddings: 0, removedCount: 0 }),
}));
// Every ship entry point is routed through a vi.fn. runGitMerge is switched to the REAL
// implementation only inside SI-TR3/SI-TR4, against the remote-less fixture.
vi.mock("../../packages/mcp-rks/src/server/git-tools.mjs", async (importOriginal) => {
  const actual = await importOriginal();
  h.actual.runGitMerge = actual.runGitMerge;
  return {
    ...actual,
    runShip: (...a) => h.runShip(...a),
    runGitPR: (...a) => h.runGitPR(...a),
    runGitMerge: (...a) => h.runGitMerge(...a),
    runCycleComplete: (...a) => h.runCycleComplete(...a),
    runPromote: (...a) => h.runPromote(...a),
    runSyncStaging: (...a) => h.runSyncStaging(...a),
    runStagingMerge: (...a) => h.runStagingMerge(...a),
    runRelease: (...a) => h.runRelease(...a),
  };
});
vi.mock("../../packages/mcp-rks/src/server/story-ship.mjs", async (importOriginal) => ({
  ...(await importOriginal()),
  runStoryShipTool: (...a) => h.runStoryShipTool(...a),
}));

import { createSession, endSession, getSession, setChildQueue, setProjectRoot } from "../../packages/mcp-rks/src/shared/governor-token.mjs";
import { isTerminal } from "../../packages/mcp-rks/src/shared/governor-state.mjs";
import { getBranchConfig, loadContext } from "../../packages/mcp-rks/src/server/project.mjs";

const ENTRY = ["runShip", "runGitPR", "runGitMerge", "runCycleComplete", "runPromote", "runSyncStaging", "runStagingMerge", "runRelease", "runStoryShipTool"];
const GIT_TIMEOUT_MS = 15_000;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PROJECT_ID = "s7-ship-handler-fixture";
const BASE = "develop";
const FEATURE = "feature/s7-ship-handler";
const TRACKED = "a.txt";
const STORY = "backlog.s7-fixture-story";

function git(dir, args) {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf8", timeout: GIT_TIMEOUT_MS });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}
function notesPhases() {
  const dir = path.join(REPO_ROOT, "notes");
  const out = {};
  for (const name of fs.readdirSync(dir).filter((n) => n.endsWith(".md")).sort()) {
    const m = fs.readFileSync(path.join(dir, name), "utf8").match(/^phase:.*$/m);
    if (m) out[name] = m[0];
  }
  return out;
}
const repoSnapshot = () => ({
  head: git(REPO_ROOT, ["rev-parse", "HEAD"]).trim(),
  branch: git(REPO_ROOT, ["rev-parse", "--abbrev-ref", "HEAD"]).trim(),
  porcelain: git(REPO_ROOT, ["status", "--porcelain"]),
  stashes: git(REPO_ROOT, ["stash", "list"]),
  phases: notesPhases(),
});
const isUnder = (child, parent) => {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

let fix;
let before;
const saved = {};

beforeAll(() => {
  before = repoSnapshot();
  fix = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rks-s7-ship-int-")));
  fs.mkdirSync(path.join(fix, ".rks"), { recursive: true });
  fs.writeFileSync(path.join(fix, ".rks", "project.json"), JSON.stringify({ id: PROJECT_ID, root: fix, kgFile: ".rks/kg.yaml", baseBranch: BASE }));
  fs.writeFileSync(path.join(fix, ".rks", "kg.yaml"), "{}\n");
  // Ignore everything but the two tracked files: session, audit and telemetry writes made
  // during the run must not dirty the worktree runGitMerge checks before it merges.
  fs.writeFileSync(path.join(fix, ".gitignore"), "*\n!.gitignore\n!a.txt\n");
  git(fix, ["init", "-b", BASE]);
  git(fix, ["config", "user.email", "s7@example.com"]);
  git(fix, ["config", "user.name", "S7"]);
  fs.writeFileSync(path.join(fix, TRACKED), "a v1\n");
  git(fix, ["add", ".gitignore", TRACKED]);
  git(fix, ["commit", "-m", "init"]);
  git(fix, ["checkout", "-b", FEATURE]);
  fs.writeFileSync(path.join(fix, TRACKED), "a v2 (s7 feature)\n");
  git(fix, ["add", TRACKED]);
  git(fix, ["commit", "-m", "s7 feature"]);
  saved.root = process.env.ROUTEKIT_PROJECT_ROOT;
  saved.id = process.env.ROUTEKIT_PROJECT_ID;
  process.env.ROUTEKIT_PROJECT_ROOT = fix;
  process.env.ROUTEKIT_PROJECT_ID = PROJECT_ID;
  // Session persistence goes to the fixture, never to the real repository's .rks/.
  setProjectRoot(fix);
});

afterAll(() => {
  if (saved.root === undefined) delete process.env.ROUTEKIT_PROJECT_ROOT;
  else process.env.ROUTEKIT_PROJECT_ROOT = saved.root;
  if (saved.id === undefined) delete process.env.ROUTEKIT_PROJECT_ID;
  else process.env.ROUTEKIT_PROJECT_ID = saved.id;
  if (fix) fs.rmSync(fix, { recursive: true, force: true });
});

beforeEach(() => {
  for (const name of ENTRY) {
    h[name].mockReset();
    h[name].mockImplementation(async () => ({ ok: true, via: name }));
  }
});

async function callTool(name, args) {
  const { createServer } = await import("../../packages/mcp-rks/src/server.mjs");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const server = createServer();
  const client = new Client({ name: "s7-ship", version: "0.0.0" }, { capabilities: {} });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  try {
    const r = await client.callTool({ name, arguments: args });
    const text = r.content?.[0]?.text ?? "";
    try {
      return JSON.parse(text);
    } catch {
      return { ok: false, raw: text };
    }
  } finally {
    await client.close().catch(() => {});
  }
}
const realMerge = () => h.runGitMerge.mockImplementation((...a) => h.actual.runGitMerge(...a));
function sessionAt(opts, state) {
  const { token } = createSession({ projectId: PROJECT_ID, ...opts });
  const session = getSession(token);
  session.state = state;
  return { token, session };
}

const DISPATCH = {
  rks_story_ship: { fn: "runStoryShipTool", extra: { problemId: STORY } },
  rks_cycle_complete: { fn: "runCycleComplete", extra: {} },
  rks_promote: { fn: "runPromote", extra: { from: FEATURE, to: BASE, push: false } },
  rks_ship: { fn: "runShip", extra: { message: "s7 ship", files: [TRACKED] } },
  rks_staging_pr: { fn: "runGitPR", extra: { problemId: STORY } },
  rks_git_merge: { fn: "runGitMerge", extra: {} },
  rks_sync_staging: { fn: "runSyncStaging", extra: {} },
  rks_staging_merge: { fn: "runStagingMerge", extra: { prNumber: 7 } },
  rks_release: { fn: "runRelease", extra: {} },
};
const projection = (ctx) => ({
  rks_story_ship: { projectId: PROJECT_ID, problemId: STORY },
  rks_cycle_complete: { projectRoot: fix, projectId: PROJECT_ID, discardLocalCommits: false },
  rks_promote: { projectRoot: fix, projectId: PROJECT_ID, from: FEATURE, to: BASE, push: false },
  rks_ship: { projectRoot: fix, projectId: PROJECT_ID, message: "s7 ship", type: "feat", files: [TRACKED], stageAll: false, branchType: "feature" },
  rks_staging_pr: { projectRoot: fix, targetBranch: getBranchConfig(ctx.record, ctx.projectJson).integration, projectId: PROJECT_ID, problemId: STORY, autoMerge: false },
  rks_git_merge: { projectRoot: fix, targetBranch: ctx.projectJson.baseBranch, deleteBranch: false },
  rks_sync_staging: { projectRoot: fix, strategy: "auto", projectRecord: ctx.record, projectJson: ctx.projectJson },
  rks_staging_merge: { projectRoot: fix, prNumber: 7 },
  rks_release: { projectRoot: fix, version: "patch", projectId: PROJECT_ID, projectRecord: ctx.record, projectJson: ctx.projectJson, enforcementOverride: null },
});

describe("S7 moved ship handlers through createServer()", { timeout: 30_000 }, () => {
  it("SI-TR1 test env; the fixture has no remote and does not lie under the repository; the snapshot saw notes phases", () => {
    expect(process.env.NODE_ENV).toBe("test");
    expect(git(fix, ["remote"]).trim()).toBe("");
    expect(isUnder(fix, REPO_ROOT)).toBe(false);
    expect(git(fix, ["rev-parse", "--abbrev-ref", "HEAD"]).trim()).toBe(FEATURE);
    expect(Object.keys(before.phases).length).toBeGreaterThan(0);
  });

  // rks_release is excluded here: runPreflight's release_ready check refuses it while the
  // fixture is on FEATURE. The two rks_release cases below pin that refusal and the
  // RKS_SKIP_PREFLIGHT="1" dispatch separately.
  const NON_RELEASE = Object.keys(DISPATCH).filter((t) => t !== "rks_release");
  it.each(NON_RELEASE)("SI-TR2 untokened %s passes its real schema and reaches only its own mocked entry point", async (tool) => {
    const { fn, extra } = DISPATCH[tool];
    const sentinel = sessionAt({ flowType: "ship" }, "merging");
    try {
      const ctx = await loadContext(PROJECT_ID);
      expect(ctx.projectJson.baseBranch, "fixture precondition").toBe(BASE);
      expect(await callTool(tool, { projectId: PROJECT_ID, ...extra })).toEqual({ ok: true, via: fn });
      expect(h[fn]).toHaveBeenCalledTimes(1);
      expect(h[fn].mock.calls[0][0]).toMatchObject(projection(ctx)[tool]);
      for (const other of ENTRY) if (other !== fn) expect(h[other], other).not.toHaveBeenCalled();
      expect(sentinel.session.state).toBe("merging");
    } finally {
      endSession(sentinel.token);
    }
  });

  it("SI-TR2 untokened rks_release off staging returns the unchanged release_ready preflight refusal and never reaches runRelease", async () => {
    const prevSkip = process.env.RKS_SKIP_PREFLIGHT;
    delete process.env.RKS_SKIP_PREFLIGHT;
    const sentinel = sessionAt({ flowType: "ship" }, "merging");
    try {
      expect(git(fix, ["rev-parse", "--abbrev-ref", "HEAD"]).trim(), "fixture precondition").toBe(FEATURE);
      expect(await callTool("rks_release", { projectId: PROJECT_ID })).toEqual({
        ok: false,
        preflightFailed: true,
        errors: [{ check: "release_ready", message: `rks_release must run from "staging", currently on "${FEATURE}"` }],
        warnings: [],
      });
      for (const name of ENTRY) expect(h[name], name).not.toHaveBeenCalled();
      expect(sentinel.session.state).toBe("merging");
    } finally {
      endSession(sentinel.token);
      if (prevSkip === undefined) delete process.env.RKS_SKIP_PREFLIGHT;
      else process.env.RKS_SKIP_PREFLIGHT = prevSkip;
    }
  });

  it("SI-TR2 untokened rks_release with RKS_SKIP_PREFLIGHT=1 passes its real schema and reaches only runRelease", async () => {
    const prevSkip = process.env.RKS_SKIP_PREFLIGHT;
    process.env.RKS_SKIP_PREFLIGHT = "1";
    const sentinel = sessionAt({ flowType: "ship" }, "merging");
    try {
      const ctx = await loadContext(PROJECT_ID);
      expect(ctx.projectJson.baseBranch, "fixture precondition").toBe(BASE);
      expect(await callTool("rks_release", { projectId: PROJECT_ID })).toEqual({ ok: true, via: "runRelease" });
      expect(h.runRelease).toHaveBeenCalledTimes(1);
      expect(h.runRelease.mock.calls[0][0]).toMatchObject(projection(ctx).rks_release);
      for (const other of ENTRY) if (other !== "runRelease") expect(h[other], other).not.toHaveBeenCalled();
      expect(sentinel.session.state).toBe("merging");
    } finally {
      endSession(sentinel.token);
      if (prevSkip === undefined) delete process.env.RKS_SKIP_PREFLIGHT;
      else process.env.RKS_SKIP_PREFLIGHT = prevSkip;
    }
  });

  it("SI-TR3 ship token - staging_pr (mocked) to pr_created, REAL git_merge in the fixture to merging, cycle_complete (mocked) to shipped", async () => {
    realMerge();
    const { token, session } = sessionAt({ flowType: "ship" }, "committed");
    try {
      expect(await callTool("rks_staging_pr", { projectId: PROJECT_ID, problemId: STORY, _governorToken: token })).toEqual({ ok: true, via: "runGitPR" });
      expect(session.state).toBe("pr_created");

      const featureHead = git(fix, ["rev-parse", FEATURE]).trim();
      const merge = await callTool("rks_git_merge", { projectId: PROJECT_ID, _governorToken: token });
      expect(merge.ok, JSON.stringify(merge)).toBe(true);
      expect(merge.sourceBranch).toBe(FEATURE);
      expect(merge.targetBranch).toBe(BASE);
      expect(git(fix, ["rev-parse", "--abbrev-ref", "HEAD"]).trim()).toBe(BASE);
      git(fix, ["merge-base", "--is-ancestor", featureHead, "HEAD"]); // throws unless merged
      expect(git(fix, ["remote"]).trim()).toBe("");
      expect(session.state).toBe("merging");

      expect(await callTool("rks_cycle_complete", { projectId: PROJECT_ID, _governorToken: token })).toEqual({ ok: true, via: "runCycleComplete" });
      expect(h.runCycleComplete.mock.calls[0][0]).toEqual({ projectRoot: fix, projectId: PROJECT_ID, discardLocalCommits: false });
      expect(session.state).toBe("shipped");
      expect(isTerminal("ship", "shipped")).toBe(true);
      expect(getSession(token)).toBeNull();
    } finally {
      endSession(token);
    }
  });

  it("SI-TR4 ship token - the REAL runGitMerge refuses staging with no git mutation (failed); a failing staging_pr is failed", async () => {
    realMerge();
    const headBefore = git(fix, ["rev-parse", "HEAD"]).trim();
    const branchBefore = git(fix, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
    const a = sessionAt({ flowType: "ship" }, "pr_created");
    const b = sessionAt({ flowType: "ship" }, "committed");
    try {
      const refused = await callTool("rks_git_merge", { projectId: PROJECT_ID, targetBranch: "staging", _governorToken: a.token });
      expect(refused.ok).toBe(false);
      expect(refused.error).toMatch(/Direct merge to staging not allowed/);
      expect(a.session.state).toBe("failed");
      expect(getSession(a.token)).toBeNull();
      expect(git(fix, ["rev-parse", "HEAD"]).trim()).toBe(headBefore);
      expect(git(fix, ["rev-parse", "--abbrev-ref", "HEAD"]).trim()).toBe(branchBefore);

      h.runGitPR.mockImplementation(async () => ({ ok: false, error: "s7-pr-refused" }));
      expect(await callTool("rks_staging_pr", { projectId: PROJECT_ID, problemId: STORY, _governorToken: b.token })).toEqual({ ok: false, error: "s7-pr-refused" });
      expect(b.session.state).toBe("failed");
    } finally {
      endSession(a.token);
      endSession(b.token);
    }
  });

  it("SI-TR5 story token at executed - rks_ship ok false returns to executed (retryable); ok reaches shipped", async () => {
    const { token, session } = sessionAt({ problemId: STORY }, "executed");
    try {
      h.runShip.mockImplementation(async () => ({ ok: false, error: "s7-ship-failed" }));
      const failed = await callTool("rks_ship", { projectId: PROJECT_ID, message: "s7", files: [TRACKED], _governorToken: token });
      expect(failed).toEqual({ ok: false, error: "s7-ship-failed", _governorState: { from: "shipping", to: "executed" } });
      expect(session.state).toBe("executed");

      h.runShip.mockImplementation(async () => ({ ok: true, via: "runShip" }));
      const ok = await callTool("rks_ship", { projectId: PROJECT_ID, message: "s7", files: [TRACKED], _governorToken: token });
      expect(ok).toEqual({ ok: true, via: "runShip", _governorState: { from: "shipping", to: "shipped" } });
      expect(session.state).toBe("shipped");
      expect(getSession(token)).toBeNull();
    } finally {
      endSession(token);
    }
  });

  it("SI-TR6 story token in child_active - child 1 completes and advances; the last child sets shipped directly", async () => {
    const { token, session } = sessionAt({ problemId: "backlog.s7-parent" }, "child_active");
    try {
      expect(setChildQueue(token, [{ childId: "backlog.s7-c1" }, { childId: "backlog.s7-c2" }])).toEqual({ ok: true, childCount: 2 });
      const args = { projectId: PROJECT_ID, message: "s7 child", files: [TRACKED], _governorToken: token };

      const first = await callTool("rks_ship", args);
      expect(first).toEqual({ ok: true, via: "runShip", _childComplete: { nextChildId: "backlog.s7-c2", index: 1, total: 2 } });
      expect(session.state).toBe("child_active");
      expect(session.childQueue[0].childState).toBe("complete");
      expect(session.activeChildIndex).toBe(1);

      const last = await callTool("rks_ship", args);
      expect(last).toEqual({ ok: true, via: "runShip", _governorState: { from: "child_active", to: "shipped" }, _childComplete: { allComplete: true, total: 2 } });
      expect(session.state).toBe("shipped");
      expect(session.childQueue[1].childState).toBe("complete");
    } finally {
      endSession(token);
    }
  });

  it("SI-TR7 a thrown runShip reaches the caller and the catch path returns the chain from shipping to executed", async () => {
    h.runShip.mockImplementation(async () => { throw new Error("boom-s7-ship"); });
    const { token } = sessionAt({ problemId: STORY }, "executed");
    try {
      await expect(callTool("rks_ship", { projectId: PROJECT_ID, message: "s7", files: [TRACKED], _governorToken: token })).rejects.toThrow(/boom-s7-ship/);
      expect(getSession(token).state).toBe("executed");
    } finally {
      endSession(token);
    }
  });

  it("SI-TR8 the real repository's HEAD, branch, status, stash list and notes phases are unchanged by this file", () => {
    expect(repoSnapshot()).toEqual(before);
  });
});
