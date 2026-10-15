/**
 * S8 planner/exec handler family - integration tier (backlog.feat.server-mjs-planner-exec-handler-family).
 * Pattern: tests/integration/server-handler-ship.test.mjs. createServer() + InMemoryTransport against
 * a remote-less os.tmpdir git fixture bound through ROUTEKIT_PROJECT_ROOT / ROUTEKIT_PROJECT_ID.
 * Entry points are vi.fn; child_process.spawn is mocked so no plan worker starts.
 *
 * Preflight (finding f): runPreflight runs before the registry seam. RKS_SKIP_PREFLIGHT is truthy-checked
 * in preflight.mjs, but the value "1" ALSO forces rks_plan onto its sync path (server.mjs _syncPlan).
 * _skipTokenValidation is already true here because NODE_ENV is test, so no case exercises the
 * token-gate refusal. Every case that reaches rks_plan, rks_exec or rks_apply states its preflight
 * strategy, and saves and restores RKS_SKIP_PREFLIGHT and RKS_SKIP_LLM in try/finally.
 *
 * PI-TR7 expected notes are committed literals captured from the pre-move build-base server;
 * the capture commit sha is recorded in a comment beside them. Only created/updated are normalized.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

const h = vi.hoisted(() => ({
  runAnalyzeTool: vi.fn(), runPlanTool: vi.fn(), runExecTool: vi.fn(), runApplyTool: vi.fn(),
  runExecAbortTool: vi.fn(), runRefineTool: vi.fn(), runRefineApplyTool: vi.fn(),
  runRksReadyTool: vi.fn(), runPlanReadyTool: vi.fn(), validateStory: vi.fn(),
  approve: vi.fn(), runReview: vi.fn(), spawn: vi.fn(),
}));

vi.mock("@routekit/rag/tools", () => ({
  runRagEmbed: vi.fn().mockResolvedValue({ ok: true, addedEmbeddings: 0, removedCount: 0 }),
}));
vi.mock("../../packages/mcp-rks/src/server/planner.mjs", async (io) => ({ ...(await io()), runAnalyzeTool: h.runAnalyzeTool, runPlanTool: h.runPlanTool }));
vi.mock("../../packages/mcp-rks/src/server/exec.mjs", async (io) => ({ ...(await io()), runExecTool: h.runExecTool, runApplyTool: h.runApplyTool, runExecAbortTool: h.runExecAbortTool }));
vi.mock("../../packages/mcp-rks/src/server/refine.mjs", async (io) => ({ ...(await io()), runRefineTool: h.runRefineTool, runRefineApplyTool: h.runRefineApplyTool, runRksReadyTool: h.runRksReadyTool }));
vi.mock("../../packages/mcp-rks/src/server/plan-ready.mjs", async (io) => ({ ...(await io()), runPlanReadyTool: h.runPlanReadyTool }));
vi.mock("../../packages/mcp-rks/src/server/story-validator-v2.mjs", async (io) => ({ ...(await io()), validateStory: h.validateStory }));
vi.mock("../../packages/mcp-rks/src/server/approve.mjs", async (io) => ({ ...(await io()), approve: h.approve }));
vi.mock("../../packages/mcp-rks/src/server/review.mjs", async (io) => ({ ...(await io()), runReview: h.runReview }));
// Only spawn is replaced; spawnSync stays real for the fixture git helper.
vi.mock("child_process", async (io) => ({ ...(await io()), spawn: h.spawn }));

import { createSession, endSession, getSession, setProjectRoot } from "../../packages/mcp-rks/src/shared/governor-token.mjs";
import { getNextState, transitionOnResult } from "../../packages/mcp-rks/src/shared/governor-state.mjs";
import { loadContext } from "../../packages/mcp-rks/src/server/project.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SELF_ABS = fileURLToPath(import.meta.url);
const WORKER_ABS = path.join(REPO_ROOT, "packages/mcp-rks/bin/plan-worker.mjs");
const GIT_TIMEOUT_MS = 15_000;
const PROJECT_ID = "s8-planner-handler-fixture";
const BASE = "develop";
const FEATURE = "feature/s8-planner";
const STORY = "backlog.s8-fixture-story";
const ENTRY = [
  "runAnalyzeTool", "runPlanTool", "runExecTool", "runApplyTool", "runExecAbortTool", "runRefineTool",
  "runRefineApplyTool", "runRksReadyTool", "runPlanReadyTool", "validateStory", "approve", "runReview",
];

// Fixture git helper: every spawnSync carries timeout (PI-TR9).
function git(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout: GIT_TIMEOUT_MS });
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

// ── PI-TR7 expected notes ─────────────────────────────────────────────────────────────────────
// Captured from the PRE-MOVE build-base server at commit 9da4b66d5dc2f2db0a7d889797adfbb0b20ffa00
// (before server.mjs was edited), through createServer() + InMemoryTransport against an os.tmpdir
// fixture, with exactly the two STORY_CREATE_INPUTS below. Committed verbatim; only the created:
// and updated: integers are normalized at comparison time (they are Date.now()).
const STORY_CREATE_INPUTS = {
  withTemplate: { name: "s8-widget", title: "S8 widget", desc: "S8 capture with template", template: "react-component" },
  noTemplate: { name: "s8-plain" },
};
const EXPECTED_STORY_NOTES = {
  withTemplate: `---
id: "backlog.feat.s8-widget"
title: "S8 widget"
desc: "S8 capture with template"
created: 1791828074879
updated: 1791828074879
status: "not-implemented"
targetFiles:
  - path: "src/components/s8-widget.tsx"
    op: "create"
    desc: "s8-widget component"
  - path: "src/components/s8-widget.test.tsx"
    op: "create"
    desc: "s8-widget unit tests"
phase: "draft"
---

## Problem

Describe what problem this component solves.

## Goal

A reusable s8-widget component that...

## Target Files

- src/components/s8-widget.tsx
- src/components/s8-widget.test.tsx

## Acceptance Criteria

- [ ] Component renders correctly
- [ ] Props are properly typed
- [ ] Unit tests cover main scenarios
- [ ] Accessibility considerations addressed
`,
  noTemplate: `---
id: "backlog.feat.s8-plain"
title: "Add s8-plain"
desc: "Story for s8-plain"
created: 1791828074880
updated: 1791828074880
status: "not-implemented"
targetFiles:
phase: "draft"
---

## Problem

Describe the problem clearly and concisely.

## Goal

Describe the desired outcome.

## Target Files

- (add target files)

## Acceptance Criteria

- [ ] (clear, testable criteria)
`,
};
// Normalizes ONLY the integer on the created: and updated: lines.
const normalizeTimestamps = (s) => s.replace(/^(created|updated): \d+$/gm, "$1: <TS>");

let fix;
let before;
const saved = {};

beforeAll(() => {
  before = repoSnapshot();
  fix = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rks-s8-planner-int-")));
  fs.mkdirSync(path.join(fix, ".rks"), { recursive: true });
  fs.mkdirSync(path.join(fix, "notes"), { recursive: true });
  fs.writeFileSync(path.join(fix, ".rks", "project.json"), JSON.stringify({ id: PROJECT_ID, root: fix, kgFile: ".rks/kg.yaml", baseBranch: BASE }));
  fs.writeFileSync(path.join(fix, ".rks", "kg.yaml"), "{}\n");
  // Ignore everything but the two tracked files: session, marker, run and note writes made
  // during the run never dirty the fixture worktree or move its HEAD.
  fs.writeFileSync(path.join(fix, ".gitignore"), "*\n!.gitignore\n!a.txt\n");
  fs.writeFileSync(path.join(fix, "notes", `${STORY}.md`), `---\nid: "${STORY}"\ntitle: "S8 fixture story"\nphase: "arch-approved"\n---\n\n## Problem\n\nS8 fixture.\n`);
  git(fix, ["init", "-b", BASE]);
  git(fix, ["config", "user.email", "s8@example.com"]);
  git(fix, ["config", "user.name", "S8"]);
  fs.writeFileSync(path.join(fix, "a.txt"), "a v1\n");
  git(fix, ["add", ".gitignore", "a.txt"]);
  git(fix, ["commit", "-m", "init"]);
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
  h.runPlanReadyTool.mockImplementation(async () => ({ ok: true, ready: true, issues: [], warnings: [] }));
  h.spawn.mockReset();
  h.spawn.mockImplementation(() => ({ pid: 424242, on: vi.fn(), unref: vi.fn() }));
});

async function rawCallTool(name, args) {
  const { createServer } = await import("../../packages/mcp-rks/src/server.mjs");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const server = createServer();
  const client = new Client({ name: "s8-planner", version: "0.0.0" }, { capabilities: {} });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  try {
    return await client.callTool({ name, arguments: args });
  } finally {
    await client.close().catch(() => {});
  }
}
async function callTool(name, args) {
  const r = await rawCallTool(name, args);
  const text = r.content?.[0]?.text ?? "";
  try {
    return JSON.parse(text);
  } catch {
    return { ok: false, raw: text };
  }
}
function sessionAt(opts, state) {
  const { token } = createSession({ projectId: PROJECT_ID, ...opts });
  const session = getSession(token);
  session.state = state;
  return { token, session };
}
async function withEnv(vars, fn) {
  const prev = {};
  for (const k of Object.keys(vars)) prev[k] = process.env[k];
  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}
const markerPath = () => path.join(fix, ".rks", "pending-plan.json");
const writeMarker = (m) => fs.writeFileSync(markerPath(), JSON.stringify(m, null, 2));
const runsDir = () => path.join(fix, ".rks", "runs");
const clearRuns = () => fs.rmSync(runsDir(), { recursive: true, force: true });
function deadPid() {
  const r = spawnSync(process.execPath, ["-e", ""], { timeout: GIT_TIMEOUT_MS });
  expect(r.pid).toBeGreaterThan(0);
  return r.pid;
}
const fixtureBranch = () => git(fix, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
const fixtureHead = () => git(fix, ["rev-parse", "HEAD"]).trim();

describe("S8 planner handler family (integration)", { timeout: 30_000 }, () => {
  it("PI-TR1 fixture safety preconditions and before snapshot", () => {
    expect(process.env.NODE_ENV).toBe("test");
    expect(git(fix, ["remote"]).trim()).toBe("");
    expect(isUnder(fs.realpathSync(fix), REPO_ROOT)).toBe(false);
    expect(fixtureBranch()).toBe(BASE);
    expect(Object.keys(before.phases).length).toBeGreaterThan(0);
  });

  it("PI-TR2 untokened projection sweep under RKS_SKIP_PREFLIGHT=1", async () => {
    // Preflight: RKS_SKIP_PREFLIGHT="1" (saved and restored). Of these nine only rks_apply has a
    // preflight table entry; rks_plan is not called here, so the sync-path coupling does not apply.
    const ctx = await loadContext(PROJECT_ID);
    expect(ctx.record.root).toBe(fix);
    const CASES = {
      rks_analyze: ["runAnalyzeTool", {}, { projectId: PROJECT_ID }],
      rks_validate_story: ["validateStory", { problemId: STORY }, { projectId: PROJECT_ID, problemId: STORY, projectRoot: fix }],
      rks_exec_abort: ["runExecAbortTool", { reason: "s8" }, { projectId: PROJECT_ID, reason: "s8" }],
      rks_apply: ["runApplyTool", { label: "s8" }, { projectId: PROJECT_ID, label: "s8" }],
      rks_refine: ["runRefineTool", { problemId: STORY, trigger: "design" }, { projectRoot: fix, projectId: PROJECT_ID, problemId: STORY, trigger: "design" }],
      rks_ready: ["runRksReadyTool", { problemId: STORY }, { projectRoot: fix, problemId: STORY, projectId: PROJECT_ID }],
      rks_review: ["runReview", { problemId: STORY }, { projectId: PROJECT_ID, problemId: STORY, targetBranch: "staging" }],
      rks_plan_ready: ["runPlanReadyTool", { problemId: STORY }, { projectId: PROJECT_ID, problemId: STORY, projectRoot: fix, readOnly: false }],
      rks_approve: ["approve", { planId: "s8-plan", confirm: true }, { projectRoot: fix, planId: "s8-plan", confirm: true, reason: undefined }],
    };
    const sentinel = sessionAt({ problemId: STORY }, "planned");
    try {
      await withEnv({ RKS_SKIP_PREFLIGHT: "1" }, async () => {
        for (const [tool, [fn, extra, expected]] of Object.entries(CASES)) {
          for (const name of ENTRY) h[name].mockClear();
          const verbatim = { ok: true, via: fn, s8: tool };
          h[fn].mockImplementationOnce(async () => verbatim);
          expect(await callTool(tool, { projectId: PROJECT_ID, ...extra }), tool).toEqual(verbatim);
          expect(h[fn], tool).toHaveBeenCalledTimes(1);
          expect(h[fn].mock.calls[0][0], tool).toStrictEqual(expected);
          for (const other of ENTRY) if (other !== fn) expect(h[other], `${tool} -> ${other}`).not.toHaveBeenCalled();
        }
      });
      // rks_validate_story reached the mocked validateStory (asserted in the loop), not the
      // TOOL_TO_AGENT_MAP story-agent auto-route: no agent ran, and the payload is the mock's.
      expect(sentinel.session.state).toBe("planned");
    } finally {
      endSession(sentinel.token);
    }
  });

  it("PI-TR3 rks_exec and rks_apply preflight refusal off the base branch", async () => {
    // Preflight: RKS_SKIP_PREFLIGHT deleted (restored); the fixture is on FEATURE, which is
    // neither the base branch nor rks/*, so the branch check refuses before the registry seam.
    git(fix, ["checkout", "-b", FEATURE]);
    try {
      await withEnv({ RKS_SKIP_PREFLIGHT: undefined }, async () => {
        expect(fixtureBranch()).toBe(FEATURE);
        for (const tool of ["rks_exec", "rks_apply"]) {
          expect(await callTool(tool, { projectId: PROJECT_ID }), tool).toEqual({
            ok: false,
            preflightFailed: true,
            errors: [{ check: "branch", message: `${tool} should run from "${BASE}" branch, currently on "${FEATURE}"` }],
            warnings: [],
          });
        }
      });
      for (const name of ENTRY) expect(h[name], name).not.toHaveBeenCalled();
    } finally {
      git(fix, ["checkout", BASE]);
      git(fix, ["branch", "-D", FEATURE]);
    }
  });

  it("PI-TR4 rks_plan async worker spawn (AC7)", async () => {
    // Preflight: RKS_SKIP_PREFLIGHT="true" (truthy, not "1", so preflight passes without forcing
    // the sync path); RKS_SKIP_LLM deleted. Both restored.
    const { token, session } = sessionAt({ problemId: STORY }, "refining");
    try {
      await withEnv({ RKS_SKIP_PREFLIGHT: "true", RKS_SKIP_LLM: undefined }, async () => {
        expect(process.env.RKS_SKIP_PREFLIGHT).not.toBe("1");
        expect(process.env.RKS_SKIP_LLM).not.toBe("1");
        const res = await callTool("rks_plan", { projectId: PROJECT_ID, problemId: STORY, _governorToken: token });
        expect(res).toMatchObject({ ok: true, status: "planning", workerPid: 424242, problemId: STORY });
      });
      expect(h.runPlanReadyTool).toHaveBeenCalledTimes(1);
      expect(h.spawn).toHaveBeenCalledTimes(1);
      const [cmd, argv, opts] = h.spawn.mock.calls[0];
      expect(cmd).toBe("node");
      expect(argv[0]).toBe(WORKER_ABS);
      expect(fs.existsSync(argv[0])).toBe(true);
      expect(opts.env.ROUTEKIT_PROJECT_ROOT).toBe(fix);
      expect(opts.cwd).toBe(fix);
      expect(fs.existsSync(markerPath())).toBe(true);
      const marker = JSON.parse(fs.readFileSync(markerPath(), "utf8"));
      expect(marker).toMatchObject({ projectId: PROJECT_ID, problemId: STORY, pid: 424242 });
      expect(h.runPlanTool).not.toHaveBeenCalled();
      // Entry transition only; no result transition on the async path.
      expect(session.state).toBe(getNextState("story", "refining", "rks_plan"));
    } finally {
      endSession(token);
      fs.rmSync(markerPath(), { force: true });
      for (const n of fs.readdirSync(path.join(fix, ".rks"))) if (n.startsWith("plan-params-")) fs.rmSync(path.join(fix, ".rks", n), { force: true });
    }
  });

  it("PI-TR5 rks_plan_review disk-marker cases on a real session", async () => {
    const failed = transitionOnResult("story", "planning", "plan.failed");
    expect(failed).not.toBe("planning");
    const base = () => ({ planKey: `${PROJECT_ID}:s8`, projectId: PROJECT_ID, startedAt: Date.now() });
    const review = async (state) => {
      const s = sessionAt({ problemId: STORY }, state);
      try {
        const res = await callTool("rks_plan_review", { projectId: PROJECT_ID, _governorToken: s.token });
        return { res, state: getSession(s.token)?.state ?? s.session.state };
      } finally {
        endSession(s.token);
      }
    };

    // done-failed
    writeMarker({ ...base(), done: true, ok: false, error: "s8-worker-failed", pid: deadPid() });
    let r = await review("planning");
    expect(r.res).toMatchObject({ ok: false, error: "s8-worker-failed" });
    expect(r.state).toBe(failed);
    expect(fs.existsSync(markerPath())).toBe(false);

    // orphaned (dead pid, no plan.json)
    clearRuns();
    writeMarker({ ...base(), pid: deadPid() });
    r = await review("planning");
    expect(r.res).toMatchObject({ ok: false, status: "failed", orphanedPlan: true });
    expect(r.state).toBe(failed);
    expect(fs.existsSync(markerPath())).toBe(false);

    // alive (process.pid): marker kept, state unchanged
    writeMarker({ ...base(), pid: process.pid });
    r = await review("planning");
    expect(r.res).toMatchObject({ ok: true, status: "planning", workerPid: process.pid });
    expect(typeof r.res.recommendedNextPollMs).toBe("number");
    expect(r.state).toBe("planning");
    expect(fs.existsSync(markerPath())).toBe(true);
    fs.rmSync(markerPath(), { force: true });

    // done-ok, no problemId on the marker (ensureExecStartPhase not entered), run dir in the fixture
    const runDir = path.join(runsDir(), "20261012-000000_s8-disk");
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, "plan.json"), JSON.stringify({ steps: [{ action: "create_file", path: "src/s8.txt", content: "s8\n" }] }, null, 2));
    try {
      writeMarker({ ...base(), done: true, ok: true, pid: deadPid() });
      r = await review("planning");
      expect(r.res.resolved).toMatchObject({ runDir, planPath: path.join(runDir, "plan.json"), identifiedBy: "latest" });
      expect(typeof r.res.ok).toBe("boolean");
      expect(r.state).toBe(transitionOnResult("story", "planning", r.res.ok ? "plan.ok" : "plan.failed"));
      expect(fs.existsSync(markerPath())).toBe(false);
    } finally {
      clearRuns();
    }
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it("PI-TR6 real-session chain state (AC6)", async () => {
    // Preflight for rks_exec: fixture checked out on its base branch with RKS_SKIP_PREFLIGHT deleted.
    // rks_refine_apply and rks_plan_ready have no preflight table entry. rks_plan is not called here.
    await withEnv({ RKS_SKIP_PREFLIGHT: undefined }, async () => {
      expect(fixtureBranch()).toBe(BASE);
      const executing = getNextState("story", "planned", "rks_exec");

      for (const [result, key] of [[{ ok: true }, "exec.ok"], [{ ok: false, error: "s8" }, "exec.failed"]]) {
        const s = sessionAt({ problemId: STORY }, "planned");
        try {
          h.runExecTool.mockImplementationOnce(async () => ({ ...result }));
          const res = await callTool("rks_exec", { projectId: PROJECT_ID, _governorToken: s.token });
          const expected = transitionOnResult("story", executing, key);
          expect(res._governorState, key).toEqual({ from: executing, to: expected });
          expect(s.session.state, key).toBe(expected);
        } finally {
          endSession(s.token);
        }
      }

      // dryRun: no entry transition and no result transition.
      {
        const s = sessionAt({ problemId: STORY }, "planned");
        try {
          h.runExecTool.mockImplementationOnce(async () => ({ ok: true, dryRun: true }));
          expect(await callTool("rks_exec", { projectId: PROJECT_ID, dryRun: true, _governorToken: s.token })).toEqual({ ok: true, dryRun: true });
          expect(s.session.state).toBe("planned");
        } finally {
          endSession(s.token);
        }
      }

      // rks_refine_apply decomposed with children: child queue set on the session.
      {
        const s = sessionAt({ problemId: STORY }, "refining");
        try {
          const children = [{ childId: "backlog.s8-c1" }, { childId: "backlog.s8-c2" }];
          h.runRefineApplyTool.mockImplementationOnce(async () => ({ ok: true, decomposed: true, children }));
          const res = await callTool("rks_refine_apply", { projectId: PROJECT_ID, problemId: STORY, refinements: [], _governorToken: s.token });
          const entry = getNextState("story", "refining", "rks_refine_apply");
          const expected = transitionOnResult("story", entry, "refine_apply.decomposed");
          expect(s.session.state).toBe(expected);
          expect(res._governorState).toEqual({ from: entry, to: expected });
          expect(s.session.childQueue.map((c) => c.childId)).toEqual(["backlog.s8-c1", "backlog.s8-c2"]);
          expect(s.session.activeChildIndex).toBe(0);
        } finally {
          endSession(s.token);
        }
      }

      // rks_plan_ready: open-flow token -> readOnly true; story-flow token -> readOnly false.
      {
        const open = sessionAt({ flowType: "open" }, "writing");
        const story = sessionAt({ problemId: STORY }, "refining");
        try {
          h.runPlanReadyTool.mockClear();
          await callTool("rks_plan_ready", { projectId: PROJECT_ID, problemId: STORY, _governorToken: open.token });
          await callTool("rks_plan_ready", { projectId: PROJECT_ID, problemId: STORY, _governorToken: story.token });
          expect(h.runPlanReadyTool.mock.calls.map(([a]) => a.readOnly)).toEqual([true, false]);
          expect(open.session.state).toBe("writing");
          expect(story.session.state).toBe("refining");
        } finally {
          endSession(open.token);
          endSession(story.token);
        }
      }

      // Untokened calls leave a sentinel session unchanged.
      {
        const sentinel = sessionAt({ problemId: STORY }, "planned");
        try {
          h.runExecTool.mockImplementationOnce(async () => ({ ok: true }));
          expect(await callTool("rks_exec", { projectId: PROJECT_ID })).toEqual({ ok: true });
          h.runRefineApplyTool.mockImplementationOnce(async () => ({ ok: true, decomposed: true, children: [{ childId: "backlog.s8-x" }] }));
          await callTool("rks_refine_apply", { projectId: PROJECT_ID, problemId: STORY, refinements: [] });
          h.runRefineApplyTool.mockImplementationOnce(async () => ({ ok: true, status: "refine_noop" }));
          expect(await callTool("rks_refine_apply", { projectId: PROJECT_ID, problemId: STORY, refinements: [] })).toEqual({ ok: true, status: "refine_noop" });
          await callTool("rks_plan_ready", { projectId: PROJECT_ID, problemId: STORY });
          expect(sentinel.session.state).toBe("planned");
          expect(sentinel.session.childQueue).toBeUndefined();
          expect(sentinel.session.consecutiveNoopCounts).toEqual({});
        } finally {
          endSession(sentinel.token);
        }
      }
    });
  });

  it("PI-TR7 rks_story_create byte equality (AC8)", async () => {
    for (const [label, input] of Object.entries(STORY_CREATE_INPUTS)) {
      const notePath = path.join(fix, "notes", `backlog.feat.${input.name}.md`);
      try {
        const res = await callTool("rks_story_create", { projectId: PROJECT_ID, ...input });
        expect(res, label).toMatchObject({ ok: true, filename: `backlog.feat.${input.name}`, path: `notes/backlog.feat.${input.name}.md`, template: input.template ?? null });
        const actual = fs.readFileSync(notePath, "utf8");
        expect(actual, label).toMatch(/^created: \d+$/m);
        expect(actual, label).toMatch(/^updated: \d+$/m);
        expect(normalizeTimestamps(actual), label).toBe(normalizeTimestamps(EXPECTED_STORY_NOTES[label]));
      } finally {
        fs.rmSync(notePath, { force: true });
      }
    }
  });

  it("PI-TR10 rks_plan sync path plan.ok/plan.failed on a real session (AC6)", async () => {
    // Preflight: RKS_SKIP_PREFLIGHT deleted; satisfied by the fixture on its base branch with
    // notes/<STORY>.md present. RKS_SKIP_LLM="1" selects the sync path. Both restored.
    const headBefore = fixtureHead();
    await withEnv({ RKS_SKIP_LLM: "1", RKS_SKIP_PREFLIGHT: undefined }, async () => {
      expect(fixtureBranch()).toBe(BASE);
      expect(fs.existsSync(path.join(fix, "notes", `${STORY}.md`))).toBe(true);
      const planning = getNextState("story", "refining", "rks_plan");
      for (const [result, key] of [[{ ok: true, via: "s8-plan" }, "plan.ok"], [{ ok: false, error: "s8-plan-failed" }, "plan.failed"]]) {
        const s = sessionAt({ problemId: STORY }, "refining");
        try {
          h.runPlanTool.mockImplementationOnce(async () => ({ ...result }));
          const res = await callTool("rks_plan", { projectId: PROJECT_ID, problemId: STORY, _governorToken: s.token });
          const expected = transitionOnResult("story", planning, key);
          expect(getSession(s.token)?.state ?? s.session.state, key).toBe(expected);
          expect(res._governorState, key).toEqual({ from: planning, to: expected });
        } finally {
          endSession(s.token);
        }
      }
    });
    expect(h.runPlanTool).toHaveBeenCalledTimes(2);
    expect(h.spawn).not.toHaveBeenCalled();
    expect(fixtureHead()).toBe(headBefore);
  });

  it("PI-TR11 rks_plan_review no-run-dir and no-plan.json throws on a real session (AC6)", async () => {
    // rks_plan_review has no preflight.mjs table entry; RKS_SKIP_PREFLIGHT deleted and restored.
    const failed = transitionOnResult("story", "planning", "plan.failed");
    expect(failed).not.toBe("planning");
    await withEnv({ RKS_SKIP_PREFLIGHT: undefined }, async () => {
      expect(fs.existsSync(markerPath())).toBe(false);
      clearRuns();
      // (a) no run dir for the slug
      {
        const s = sessionAt({ problemId: STORY }, "planning");
        try {
          const err = await callTool("rks_plan_review", { projectId: PROJECT_ID, label: "s8-missing", _governorToken: s.token }).catch((e) => e);
          expect(err).toBeInstanceOf(McpError);
          expect(err.code).toBe(ErrorCode.InvalidParams);
          expect(err.message).toContain("No plan found for 's8-missing'");
          expect(getSession(s.token)?.state ?? s.session.state).toBe(failed);
        } finally {
          endSession(s.token);
        }
      }
      // (b) a run dir for the slug but no plan.json
      const runDir = path.join(runsDir(), "20261012-000000_s8-noplan");
      fs.mkdirSync(runDir, { recursive: true });
      try {
        const s = sessionAt({ problemId: STORY }, "planning");
        try {
          const err = await callTool("rks_plan_review", { projectId: PROJECT_ID, label: "s8-noplan", _governorToken: s.token }).catch((e) => e);
          expect(err).toBeInstanceOf(McpError);
          expect(err.code).toBe(ErrorCode.InvalidParams);
          expect(err.message).toContain(`Plan generation was interrupted (no plan.json in ${path.basename(runDir)})`);
          expect(getSession(s.token)?.state ?? s.session.state).toBe(failed);
        } finally {
          endSession(s.token);
        }
      } finally {
        clearRuns();
      }
    });
  });

  it("PI-TR12 rks_exec exec.no_actions/exec.error throws on a real session (AC6)", async () => {
    // Preflight: fixture on its base branch with RKS_SKIP_PREFLIGHT deleted (restored).
    await withEnv({ RKS_SKIP_PREFLIGHT: undefined }, async () => {
      expect(fixtureBranch()).toBe(BASE);
      const executing = getNextState("story", "planned", "rks_exec");
      const cases = [
        [new McpError(ErrorCode.InvalidRequest, "s8: plan contains a note step"), "exec.no_actions", "s8: plan contains a note step"],
        [new Error("s8 exec boom"), "exec.error", "s8 exec boom"],
      ];
      for (const [thrown, key, message] of cases) {
        const s = sessionAt({ problemId: STORY }, "planned");
        try {
          h.runExecTool.mockImplementationOnce(async () => { throw thrown; });
          const err = await callTool("rks_exec", { projectId: PROJECT_ID, _governorToken: s.token }).catch((e) => e);
          expect(err, key).toBeInstanceOf(Error);
          expect(err.message, key).toContain(message);
          const state = getSession(s.token)?.state ?? s.session.state;
          expect(state, key).toBe(transitionOnResult("story", executing, key));
          expect(state, key).not.toBe("planned");
          expect(state, key).not.toBe(executing);
        } finally {
          endSession(s.token);
        }
      }
    });
  });

  it("PI-TR13 rks_refine_apply noop/inapplicable self-loops on a real session (AC6)", async () => {
    // rks_refine_apply has no preflight.mjs table entry; RKS_SKIP_PREFLIGHT deleted and restored.
    await withEnv({ RKS_SKIP_PREFLIGHT: undefined }, async () => {
      const s = sessionAt({ problemId: STORY }, "refining");
      try {
        expect(s.session.consecutiveNoopCounts).toEqual({});
        const args = { projectId: PROJECT_ID, problemId: STORY, refinements: [], _governorToken: s.token };
        h.runRefineApplyTool.mockImplementationOnce(async () => ({ ok: true, status: "refine_noop" }));
        const noop = await callTool("rks_refine_apply", args);
        expect(noop._governorState).toEqual({ from: "refining", to: "refining", transitioned: false, resultKey: "refine_apply.noop" });
        expect(s.session.state).toBe(transitionOnResult("story", "refining", "refine_apply.noop"));
        expect(s.session.consecutiveNoopCounts["refine_apply.noop"]).toBe(1);

        h.runRefineApplyTool.mockImplementationOnce(async () => ({ ok: true, status: "refine_inapplicable" }));
        const inapplicable = await callTool("rks_refine_apply", args);
        expect(inapplicable._governorState).toMatchObject({ resultKey: "refine_apply.inapplicable", transitioned: false });
        expect(s.session.state).toBe(transitionOnResult("story", "refining", "refine_apply.inapplicable"));
        expect(s.session.consecutiveNoopCounts).toEqual({});
      } finally {
        endSession(s.token);
      }
    });
  });

  it("PI-TR9 every subprocess spawn in this file carries a timeout", () => {
    const src = fs.readFileSync(SELF_ABS, "utf8");
    const lines = src
      .split("\n")
      .map((l) => l.replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\\n]|\\.)*`/g, '""'))
      .map((l) => { const i = l.indexOf("//"); return i === -1 ? l : l.slice(0, i); });
    const SPAWN_FAMILY_RE = /(?<![\w.])(spawnSync|spawn|execSync|execFileSync|execFile|exec|fork|execa)\s*\(/g;
    let calls = 0;
    for (let i = 0; i < lines.length; i++) {
      for (const m of lines[i].matchAll(SPAWN_FAMILY_RE)) {
        if (/function\s+$/.test(lines[i].slice(0, m.index))) continue;
        calls++;
        // Collect the call text until its parentheses balance.
        let depth = 0;
        let text = "";
        outer: for (let j = i; j < lines.length; j++) {
          const seg = j === i ? lines[j].slice(m.index) : lines[j];
          for (const ch of seg) {
            text += ch;
            if (ch === "(") depth++;
            else if (ch === ")" && --depth === 0) break outer;
          }
          text += "\n";
        }
        expect(text, `line ${i + 1}`).toMatch(/\btimeout\s*:/);
      }
    }
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it("PI-TR8 repository snapshot unchanged, fixture removed", () => {
    expect(repoSnapshot()).toEqual(before);
    expect(git(fix, ["remote"]).trim()).toBe("");
    // No real plan worker: spawn is a vi.fn and was reached only by the PI-TR4 async case, with the
    // worker script; the planner entry point is a vi.fn throughout.
    expect(vi.isMockFunction(h.spawn)).toBe(true);
    expect(vi.isMockFunction(h.runPlanTool)).toBe(true);
    fs.rmSync(fix, { recursive: true, force: true });
    expect(fs.existsSync(fix)).toBe(false);
  });
});
