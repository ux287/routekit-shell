/**
 * backlog.fix.run-command-honest-and-usable — Defect A, unit tier.
 *
 * Drives the REAL command-runner exports; no vi.mock of command-runner.mjs. The only stub is the
 * spawn collaborator (scripts/lib/spawn-managed.mjs), so every skip-path case can assert that NOTHING
 * was started. Every case here is a skip path or the fix-plan refusal.
 *
 * TR43 also drives the REAL applyFixPlan from server/fix-planner.mjs (never mocked). Only its LLM
 * collaborator (../llm/planner.mjs) is stubbed, as tests/unit/fix-planner.test.mjs does, because the
 * module imports it at load time.
 *
 * Not duplicated here (pinned by tests/unit/command-runner-shell-syntax.test.mjs, which this story does
 * not modify): the default-policy deep-equality, the /shell/i reason match and the precedence of shell
 * syntax over the confirmation tier.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { makeTempDir } from "../helpers/tmp.mjs";

vi.mock("../../scripts/lib/spawn-managed.mjs", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, spawnManaged: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })) };
});
vi.mock("../../packages/mcp-rks/src/llm/planner.mjs", () => ({
  runLlmPlanner: vi.fn(async () => null),
}));

import { spawnManaged } from "../../scripts/lib/spawn-managed.mjs";
import {
  classifyCommand,
  handleRunCommandStep,
  loadCommandPolicy,
} from "../../packages/mcp-rks/src/exec/command-runner.mjs";
import { applyFixPlan } from "../../packages/mcp-rks/src/server/fix-planner.mjs";

const POLICY_PATH = ".routekit/command-policy.yaml";
const POLICY_KEY = "command_policy";
const REASONS = ["requires_plan_approval", "shell_syntax_rejected", "requires_explicit_confirmation", "unknown_command"];

/** One command per skip reason, under defaults (no policy file). */
const SKIP_CASES = [
  { reason: "unknown_command", command: "node tools/x-capture/build.mjs", planApproved: true },
  { reason: "requires_explicit_confirmation", command: "rm -rf build", planApproved: true },
  { reason: "shell_syntax_rejected", command: "npm run build && touch PWNED", planApproved: true },
  { reason: "requires_plan_approval", command: "git add .", planApproved: false },
];

let bareRoot;
const extraRoots = [];

function policyRootWith(yamlText) {
  const root = makeTempDir("rc-skip-honesty-policy");
  extraRoots.push(root);
  fs.mkdirSync(path.join(root, ".routekit"), { recursive: true });
  fs.writeFileSync(path.join(root, ".routekit", "command-policy.yaml"), yamlText);
  return root;
}

beforeEach(() => {
  bareRoot = makeTempDir("rc-skip-honesty");
  vi.mocked(spawnManaged).mockClear();
});

afterEach(() => {
  fs.rmSync(bareRoot, { recursive: true, force: true });
  for (const r of extraRoots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

const run = (command, opts = {}) =>
  handleRunCommandStep(command, { projectRoot: bareRoot, planApproved: true, timeout: 15_000, ...opts });

describe("TR1/TR6: the four skip reasons are non-executed outcomes", () => {
  it("each of the four reasons returns command, classification and reason, and never executed or exec", async () => {
    const seen = new Set();
    for (const c of SKIP_CASES) {
      const r = await run(c.command, { planApproved: c.planApproved });
      expect(r.reason, c.command).toBe(c.reason);
      expect(r.command, c.command).toBe(c.command);
      expect(typeof r.classification, c.command).toBe("string");
      expect(r.skipped, c.command).toBe(true);
      expect(r.executed, c.command).not.toBe(true);
      expect(r, c.command).not.toHaveProperty("exec");
      seen.add(r.reason);
    }
    expect([...seen].sort()).toEqual([...REASONS].sort());
  });

  it("TR6: no subprocess is started on any skip path", async () => {
    for (const c of SKIP_CASES) {
      const r = await run(c.command, { planApproved: c.planApproved });
      expect(r, c.command).not.toHaveProperty("exec");
    }
    expect(spawnManaged).not.toHaveBeenCalled();
  });
});

describe("TR2: every skip outcome carries a reason-specific hint", () => {
  it("unknown_command names the policy file and key, the specific-script rule and the bare-runner refusal", async () => {
    const r = await run("node tools/x-capture/build.mjs");
    expect(r.reason).toBe("unknown_command");
    const hint = String(r.hint);
    expect(hint).toContain(POLICY_PATH);
    expect(hint).toContain(POLICY_KEY);
    expect(hint).toMatch(/SPECIFIC script or subcommand/i);
    expect(hint).toMatch(/bare interpreter or script-runner entries[^.]*refused/i);
  });

  it("shell_syntax_rejected says the command runs without a shell and does NOT name the policy file", async () => {
    const r = await run("npm run build && touch PWNED");
    expect(r.reason).toBe("shell_syntax_rejected");
    expect(String(r.hint)).toMatch(/without a shell/i);
    expect(String(r.hint)).not.toContain(POLICY_PATH);
  });

  it("requires_plan_approval names the plan-approval tier", async () => {
    const r = await run("git add .", { planApproved: false });
    expect(r.reason).toBe("requires_plan_approval");
    expect(String(r.hint)).toContain("execute_with_plan_approval");
  });

  it("the four hints are pairwise distinct", async () => {
    const hints = [];
    for (const c of SKIP_CASES) {
      const r = await run(c.command, { planApproved: c.planApproved });
      expect(typeof r.hint, c.command).toBe("string");
      expect(r.hint.length, c.command).toBeGreaterThan(0);
      hints.push(r.hint);
    }
    expect(new Set(hints).size).toBe(hints.length);
  });
});

describe("TR2b: the unknown_command hint names a refused runner entry when there is one", () => {
  it("a bare 'node' auto_execute entry is named verbatim from the observed refusedEntry", async () => {
    const root = policyRootWith(`${POLICY_KEY}:\n  auto_execute: ["node"]\n`);
    const r = await handleRunCommandStep("node tools/build.mjs", { projectRoot: root, planApproved: true, timeout: 15_000 });
    expect(r.reason).toBe("unknown_command");
    expect(r.refusedEntry).toBeTruthy();
    expect(r.refusedEntry.reason).toBe("runner_entry");
    const hint = String(r.hint);
    expect(hint).toContain(`"${r.refusedEntry.entry}"`);
    expect(hint).toContain(r.refusedEntry.tier);
    expect(hint).toMatch(/refused as a bare interpreter or script-runner entry/i);
    expect(REASONS).toContain(r.reason);
    expect(spawnManaged).not.toHaveBeenCalled();
  });

  it("under defaults (no refusedEntry) the hint names no refused entry but keeps the TR2 statements", async () => {
    const r = await run("node tools/build.mjs");
    expect(r.reason).toBe("unknown_command");
    expect(r).not.toHaveProperty("refusedEntry");
    const hint = String(r.hint);
    expect(hint).not.toMatch(/refused as a bare interpreter or script-runner entry/i);
    expect(hint).toContain(POLICY_PATH);
    expect(hint).toContain(POLICY_KEY);
    expect(hint).toMatch(/bare interpreter or script-runner entries[^.]*refused/i);
  });
});

describe("TR2c: the requires_explicit_confirmation hint names its real source", () => {
  it("(a) built-in veto: 'rm -rf build' under defaults and under an empty confirmation list says no policy edit lifts it", async () => {
    const emptyConfirm = policyRootWith(`${POLICY_KEY}:\n  auto_execute: []\n  require_explicit_confirmation: []\n`);
    const results = [
      await run("rm -rf build"),
      await handleRunCommandStep("rm -rf build", { projectRoot: emptyConfirm, planApproved: true, timeout: 15_000 }),
    ];
    for (const r of results) {
      expect(r.reason).toBe("requires_explicit_confirmation");
      const hint = String(r.hint);
      expect(hint).toMatch(/built in/i);
      expect(hint).toMatch(/no policy edit lifts it/i);
      expect(hint).not.toContain(POLICY_PATH);
    }
    expect(spawnManaged).not.toHaveBeenCalled();
  });

  it("(b) policy entry: 'frobnicate --now' names the policy file, key, tier and the matching entry", async () => {
    const root = policyRootWith(`${POLICY_KEY}:\n  auto_execute: []\n  require_explicit_confirmation: ["frobnicate"]\n`);
    const r = await handleRunCommandStep("frobnicate --now", { projectRoot: root, planApproved: true, timeout: 15_000 });
    expect(r.reason).toBe("requires_explicit_confirmation");
    const hint = String(r.hint);
    expect(hint).toContain(POLICY_PATH);
    expect(hint).toContain(POLICY_KEY);
    expect(hint).toContain("require_explicit_confirmation");
    expect(hint).toContain('"frobnicate"');
    expect(hint).not.toMatch(/no policy edit lifts it/i);
    const builtin = await run("rm -rf build");
    expect(hint).not.toBe(builtin.hint);
    expect(spawnManaged).not.toHaveBeenCalled();
  });
});

describe("TR4/TR5: the defaults are not widened, and the hinted mechanism actually works", () => {
  it("TR4: the motivating child-project command is unknown under defaults", () => {
    expect(classifyCommand("node tools/x-capture/build.mjs", loadCommandPolicy(bareRoot))).toBe("unknown");
  });

  it("TR5: a specific-script entry under command_policy admits the command; any other top-level key does not", () => {
    const good = policyRootWith(`${POLICY_KEY}:\n  auto_execute: ["node tools/build.mjs"]\n`);
    expect(classifyCommand("node tools/build.mjs", loadCommandPolicy(good))).toBe("auto_execute");
    const wrongKey = policyRootWith(`policy:\n  auto_execute: ["node tools/build.mjs"]\n`);
    expect(classifyCommand("node tools/build.mjs", loadCommandPolicy(wrongKey))).toBe("unknown");
  });
});

describe("TR43: applyFixPlan refuses a run_command step instead of reporting success", () => {
  let projectRoot;
  let runDir;
  beforeEach(() => {
    projectRoot = makeTempDir("rc-fixplan");
    runDir = path.join(projectRoot, ".rks", "runs", "2026-honesty_fix");
    fs.mkdirSync(runDir, { recursive: true });
  });
  afterEach(() => { fs.rmSync(projectRoot, { recursive: true, force: true }); });

  it("a fix plan carrying a run_command returns ok:false naming the command; the attempt log keeps the skip line and the error", async () => {
    const res = await applyFixPlan({
      projectId: "rc-fixplan",
      projectRoot,
      runDir,
      attemptNumber: 2,
      plan: { steps: [
        { action: "create_file", path: "a.txt", content: "x" },
        { action: "run_command", command: "node tools/build.mjs" },
      ] },
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("node tools/build.mjs");
    const log = fs.readFileSync(path.join(runDir, "apply", "attempt-2.log"), "utf8");
    expect(log).toContain("skip: run_command");
    expect(log).toContain(res.error);
    expect(spawnManaged).not.toHaveBeenCalled();
  });

  it("positive control: without the run_command the same plan succeeds, and a note-only plan still succeeds", async () => {
    const res = await applyFixPlan({
      projectId: "rc-fixplan", projectRoot, runDir, attemptNumber: 3,
      plan: { steps: [{ action: "create_file", path: "a.txt", content: "x" }] },
    });
    expect(res.ok).toBe(true);
    expect(res.appliedFiles).toEqual(["a.txt"]);
    const noteOnly = await applyFixPlan({
      projectId: "rc-fixplan", projectRoot, runDir, attemptNumber: 4,
      plan: { steps: [{ action: "note", target: "notes/x.md" }] },
    });
    expect(noteOnly.ok).toBe(true);
  });
});
