/**
 * backlog.fix.command-policy-integrity-across-runs
 * Drives runApplyTool and runExecTool on a git fixture (pattern: tests/integration/exec-run-command-produces.test.mjs,
 * which mocks loadContext via project.mjs and embedScopedFiles via @routekit/rag). Fixture shape (ARCH Item 3c):
 * (1) the project test command is set through .rks/project.json testCommand { cmd, args } (resolveTestCommand);
 *     the runner appends the story testFiles to args (none here);
 * (2) that command also runs the pre-apply baseline, so the fixture script rewrites the policy ONLY when a
 *     file the plan creates exists;
 * (3) verification runs only when appliedFiles.length > 0, so each such plan has a create_file step;
 * (4) a failing verification reaches generateFixPlan and runRefineTool: generateFixPlan is mocked to return
 *     null (loop exit) and runRefineTool is mocked, so the mock tier makes no LLM call.
 * Every git spawn carries an explicit timeout, including those inside the fixture scripts and hook.
 *
 * Telemetry: tests/setup.mjs mocks @routekit/telemetry suite-wide. This file escapes BOTH specifiers with
 * vi.unmock (the sanctioned escape, which keeps it UN-SHADOWED for tests/unit/telemetry-global-mock-triage),
 * gives the REAL collector an in-memory storage (nothing is written to disk) and records every emitted event
 * through addListener. exec.command_policy_changed events are read off that record.
 *
 * Collaborators mocked: loadContext (so the live projects/index.jsonl is never read or written), embedScopedFiles,
 * generateFixPlan, runRefineTool, guardrailsOff/guardrailsOn (guardrailsOff returns { ok: true }, guardrailsOn is a
 * spy returning { ok: true }). rollback, loadCommandPolicy and restoreCommandPolicyState are WRAPPED (delegating
 * vi.fn, one per module): every call reaches the real function unless a test queues a mockImplementationOnce.
 *
 * testRequirement -> test mapping (TRn = the story's nth testRequirement):
 *   TR21 "[TR21] force mode on a git fixture: no rollback, operator work survives"
 *   TR22 "[TR22] rolledBack is derived from the recorded rollback result"
 *   TR23 "[TR23] propagation through the widened exec.diverged condition"
 *   TR24 "[TR24] rewrite + stage via an admitted script"
 *   TR25 "[TR25] git rm --cached"
 *   TR26 "[TR26] git checkout <ref> -- policy"
 *   TR27 "[TR27] a committed policy change is reset"
 *   TR28 "[TR28] preCommand route rolls back"
 *   TR29 "[TR29] capture mismatch refusal rolls back"
 *   TR30 "[TR30] post-apply change before commit"
 *   TR31 "[TR31] another failure keeps its status and restores"
 *   TR32 "[TR32] positive control"
 *   TR33 "[TR33] telemetry rule (i)"
 *   TR34 "[TR34] restore-failed case under rule (i)"
 *   TR35 "[TR35] finalized exit with a git hook commit"
 *   TR36 "[TR36] throw path"
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.unmock("@routekit/telemetry");
vi.unmock("@routekit/telemetry/collector");

const h = vi.hoisted(() => ({ root: null, rollbacks: [] }));

vi.mock("../../packages/mcp-rks/src/server/project.mjs", async (importOriginal) => ({
  ...(await importOriginal()),
  loadContext: vi.fn(async (projectId) => ({ record: { id: projectId, root: h.root }, projectJson: { baseBranch: "staging" } })),
}));
vi.mock("@routekit/rag", async (importOriginal) => ({
  ...(await importOriginal()),
  embedScopedFiles: vi.fn(async () => ({ ok: true, filesEmbedded: 0 })),
}));
vi.mock("../../packages/mcp-rks/src/server/fix-planner.mjs", async (importOriginal) => ({
  ...(await importOriginal()),
  generateFixPlan: vi.fn(async () => null),
}));
vi.mock("../../packages/mcp-rks/src/server/refine.mjs", async (importOriginal) => ({
  ...(await importOriginal()),
  runRefineTool: vi.fn(async () => ({ ok: true, suggestions: [] })),
}));
vi.mock("../../packages/mcp-rks/src/server/guardrails-audit.mjs", async (importOriginal) => ({
  ...(await importOriginal()),
  guardrailsOff: vi.fn(async () => ({ ok: true })),
  guardrailsOn: vi.fn(async () => ({ ok: true })),
}));
vi.mock("../../packages/mcp-rks/src/server/test-runner.mjs", async (importOriginal) => {
  const orig = await importOriginal();
  return {
    ...orig,
    rollback: vi.fn(async (projectRoot, opts) => {
      const ret = await orig.rollback(projectRoot, opts);
      h.rollbacks.push({ opts, ret });
      return ret;
    }),
  };
});
vi.mock("../../packages/mcp-rks/src/exec/command-runner.mjs", async (importOriginal) => {
  const orig = await importOriginal();
  return {
    ...orig,
    loadCommandPolicy: vi.fn((...args) => orig.loadCommandPolicy(...args)),
    restoreCommandPolicyState: vi.fn((...args) => orig.restoreCommandPolicyState(...args)),
  };
});

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { getTelemetryCollector } from "@routekit/telemetry/collector";
import { TEMP_BASE } from "../helpers/tmp.mjs";
import { parseFrontmatter } from "../../packages/mcp-rks/src/shared/frontmatter.mjs";
import { noteSubjectDigest } from "../../packages/mcp-rks/src/workflow/arch-verdict.mjs";

const { runApplyTool, runExecTool } = await import("../../packages/mcp-rks/src/server/exec.mjs");
const { generateFixPlan } = await import("../../packages/mcp-rks/src/server/fix-planner.mjs");
const { guardrailsOff, guardrailsOn } = await import("../../packages/mcp-rks/src/server/guardrails-audit.mjs");
const runner = await import("../../packages/mcp-rks/src/exec/command-runner.mjs");

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const EXEC_SRC = fs.readFileSync(path.join(REPO_ROOT, "packages/mcp-rks/src/server/exec.mjs"), "utf8");

const GIT_TIMEOUT = 15_000;
const git = (cwd, args) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout: GIT_TIMEOUT });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
};

// ---------------------------------------------------------------------------
// Telemetry: the real collector, an in-memory storage, and a listener record.
// ---------------------------------------------------------------------------
const telemetry = getTelemetryCollector();
telemetry.setStorage({ write: async () => {} });
const events = [];
telemetry.addListener((e) => events.push(e));
const policyEvents = () => events.filter((e) => e.type === "exec.command_policy_changed");

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------
const POLICY_REL = ".routekit/command-policy.yaml";
const BASE_POLICY = [
  "command_policy:",
  '  auto_execute: ["node widen.mjs", "node mark.mjs", "node stage.mjs", "node commit-policy.mjs", "node pre-marker.mjs"]',
  '  execute_with_plan_approval: ["git rm --cached", "git checkout"]',
  '  require_explicit_confirmation: ["rm"]',
  "",
].join("\n");
const WIDE_POLICY = BASE_POLICY.replace('"node widen.mjs"', '"node widen.mjs", "node evil.mjs"');
const HOOK_POLICY = BASE_POLICY.replace('"node widen.mjs"', '"node widen.mjs", "node hook.mjs"');

const spawnLine = (args) => `spawnSync("git", ${JSON.stringify(args)}, { timeout: ${GIT_TIMEOUT}, stdio: "ignore" });`;
const SCRIPTS = {
  "widen.mjs": `import fs from "node:fs";\nfs.writeFileSync(${JSON.stringify(POLICY_REL)}, ${JSON.stringify(WIDE_POLICY)});\n`,
  "mark.mjs": 'import fs from "node:fs";\nfs.writeFileSync("marker.txt", "ran\\n");\n',
  "pre-marker.mjs": 'import fs from "node:fs";\nfs.writeFileSync("pre-marker.txt", "ran\\n");\n',
  "stage.mjs": [
    'import fs from "node:fs";',
    'import { spawnSync } from "node:child_process";',
    `fs.writeFileSync(${JSON.stringify(POLICY_REL)}, ${JSON.stringify(WIDE_POLICY)});`,
    spawnLine(["add", POLICY_REL]),
    "",
  ].join("\n"),
  "commit-policy.mjs": [
    'import fs from "node:fs";',
    'import { spawnSync } from "node:child_process";',
    `fs.writeFileSync(${JSON.stringify(POLICY_REL)}, ${JSON.stringify(WIDE_POLICY)});`,
    spawnLine(["add", POLICY_REL]),
    spawnLine(["commit", "-q", "-m", "widen policy"]),
    "",
  ].join("\n"),
  // The project test command. It touches the policy only when the plan-created file exists, so the
  // pre-apply baseline (which runs the same command) never sees a change.
  "tester.mjs": [
    'import fs from "node:fs";',
    "const args = process.argv.slice(2);",
    'if (fs.existsSync("plan-created.txt")) {',
    `  if (args.includes("--rewrite")) fs.writeFileSync(${JSON.stringify(POLICY_REL)}, ${JSON.stringify(WIDE_POLICY)});`,
    '  console.log("fixture tests ran");',
    '  process.exit(args.includes("--fail") ? 1 : 0);',
    "}",
    'console.log("fixture baseline ran");',
    "process.exit(0);",
    "",
  ].join("\n"),
};

const STORY = "backlog.fix.cpi-fixture";
const cleanup = [];

/** A temp git repo on staging with the policy, the scripts and other.txt committed as the baseline. */
function makeRepo(tag, { testArgs = null, preCommands = null } = {}) {
  const root = path.join(TEMP_BASE, `cpi-${tag}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(path.join(root, ".routekit"), { recursive: true });
  cleanup.push(root);
  fs.writeFileSync(path.join(root, POLICY_REL), BASE_POLICY);
  for (const [name, text] of Object.entries(SCRIPTS)) fs.writeFileSync(path.join(root, name), text);
  fs.writeFileSync(path.join(root, "other.txt"), "one\n");
  fs.writeFileSync(path.join(root, ".gitignore"), ".rks/\n");
  if (testArgs) {
    fs.mkdirSync(path.join(root, ".rks"), { recursive: true });
    fs.writeFileSync(path.join(root, ".rks", "project.json"), JSON.stringify({ testCommand: { cmd: process.execPath, args: ["tester.mjs", ...testArgs] } }));
  }
  if (preCommands) {
    fs.mkdirSync(path.join(root, "notes"), { recursive: true });
    // backlog.fix.precommands-arch-digest-binding: exec runs preCommands only under a gated, unchanged ARCH
    // approval, so the note carries arch_subject computed with noteSubjectDigest over the note including
    // its preCommands, and arch_subject_version 2.
    const note = `---\nid: "${STORY}"\ntitle: "fixture"\nphase: "executing"\npreCommands: ${JSON.stringify(preCommands)}\n---\n\nbody\n`;
    const subject = noteSubjectDigest(parseFrontmatter(note));
    fs.writeFileSync(path.join(root, "notes", `${STORY}.md`), note.replace("\n---\n\nbody", `\narch_verdict: "approved"\narch_subject: "${subject}"\narch_subject_version: "2"\n---\n\nbody`));
  }
  git(root, ["init", "-q", "-b", "staging"]);
  git(root, ["config", "user.email", "t@t"]);
  git(root, ["config", "user.name", "t"]);
  git(root, ["config", "commit.gpgsign", "false"]);
  git(root, ["config", "core.hooksPath", ".git/hooks"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "baseline"]);
  h.root = root;
  return root;
}

function writePlan(root, label, steps, extra = {}) {
  const runDir = path.join(root, ".rks", "runs", `2026-11-04T00-00-00-000Z_${label}`);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, "plan.json"), JSON.stringify({ slug: label, status: "executable", steps, ...extra }, null, 2));
  fs.writeFileSync(path.join(runDir, "run.json"), JSON.stringify({ projectId: "cpi", timestamps: {}, telemetry: { outcome: "planned" } }));
  return label;
}

const CREATE = { action: "create_file", path: "plan-created.txt", content: "created\n", title: "create the plan file" };
const runCmd = (command, extra = {}) => ({ action: "run_command", command, title: `run ${command}`, ...extra });

const policyBytes = (root) => fs.readFileSync(path.join(root, POLICY_REL), "utf8");
const lsEntry = (root) => git(root, ["ls-files", "-s", "--", POLICY_REL]).trim();
const headPolicyBlob = (root) => git(root, ["rev-parse", `HEAD:${POLICY_REL}`]).trim();
const headSha = (root) => git(root, ["rev-parse", "HEAD"]).trim();
const currentBranch = (root) => git(root, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
const newCommits = (root, base) => git(root, ["rev-list", "--branches", "--tags", `^${base}`]).split("\n").filter(Boolean);
// backlog.fix.exec-rollback-orphans-created-files: the ONE shared derivation exec uses at every rollback
// site (test-runner.mjs deriveRolledBack), not a local copy of the old restored-or-cleaned rule.
const { deriveRolledBack } = await import("../../packages/mcp-rks/src/server/test-runner.mjs");
const rolledBackFrom = (ret) => deriveRolledBack(ret);
const policyRollbacks = () => h.rollbacks.filter((r) => r.opts?.reason === "command_policy_changed");

let errSpy;
const policyLines = () => errSpy.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith("[rks.exec] command policy changed"));

beforeEach(() => {
  h.root = null;
  h.rollbacks.length = 0;
  events.length = 0;
  vi.mocked(guardrailsOff).mockClear();
  vi.mocked(guardrailsOn).mockClear();
  vi.mocked(generateFixPlan).mockClear();
  vi.mocked(runner.loadCommandPolicy).mockClear();
  vi.mocked(runner.restoreCommandPolicyState).mockClear();
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  errSpy?.mockRestore();
  for (const p of cleanup.splice(0)) {
    try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

// ---------------------------------------------------------------------------
// runApplyTool (force mode)
// ---------------------------------------------------------------------------
describe("runApplyTool force mode on a git fixture", () => {
  it("[TR21] force mode on a git fixture: no rollback, operator work survives", async () => {
    const root = makeRepo("force");
    const head = headSha(root);
    fs.writeFileSync(path.join(root, "other.txt"), "operator edit\n");
    fs.writeFileSync(path.join(root, "untracked.txt"), "operator scratch\n");
    const label = writePlan(root, "force", [runCmd("node widen.mjs"), runCmd("node mark.mjs")]);
    const res = await runApplyTool({ projectId: "cpi", label, force: true });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("exec.command_policy_changed");
    expect(res.rolledBack).toBe(false);
    expect(policyBytes(root)).toBe(BASE_POLICY);
    expect(headSha(root)).toBe(head);
    expect(fs.readFileSync(path.join(root, "other.txt"), "utf8")).toBe("operator edit\n");
    expect(fs.existsSync(path.join(root, "untracked.txt"))).toBe(true);
    expect(fs.existsSync(path.join(root, "marker.txt"))).toBe(false);
    expect(h.rollbacks).toHaveLength(0);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// runExecTool: apply-step routes
// ---------------------------------------------------------------------------
describe("exec restores the command policy across runs (apply-step routes)", () => {
  it("[TR22] rolledBack is derived from the recorded rollback result", async () => {
    const root = makeRepo("rolledback");
    writePlan(root, "rolledback", [runCmd("node widen.mjs")]);
    const result = await runExecTool({ projectId: "cpi", label: "rolledback", skipTests: true });
    expect(result.error).toBe("exec.command_policy_changed");
    const calls = policyRollbacks();
    expect(calls).toHaveLength(1);
    expect(result.rolledBack).toBe(rolledBackFrom(calls[0].ret));
    expect(policyBytes(root)).toBe(BASE_POLICY);
  }, 120_000);

  it("[TR22] structural: no returned object literal pairs command_policy_changed with a literal rolledBack true", () => {
    const literals = [...EXEC_SRC.matchAll(/return \{[^}]*command_policy_changed[\s\S]*?\n\s*\};/g)].map((m) => m[0]);
    expect(literals.length).toBeGreaterThanOrEqual(3);
    for (const l of literals) expect(l).not.toMatch(/\brolledBack:\s*true\b/);
  });

  it("[TR23] propagation through the widened exec.diverged condition", async () => {
    const root = makeRepo("propagate");
    writePlan(root, "propagate", [runCmd("node widen.mjs")]);
    const result = await runExecTool({ projectId: "cpi", label: "propagate", skipTests: true });
    expect(result.error).toBe("exec.command_policy_changed");
    expect(guardrailsOn).toHaveBeenCalledTimes(1);
    const onEvents = events.filter((e) => e.type === "exec.guardrails_on");
    expect(onEvents).toHaveLength(1);
    expect(onEvents[0].payload.path).toBe("command_policy_changed");
    const declAt = EXEC_SRC.indexOf("function reenableGuardrailsAfterExec(");
    const declEnd = EXEC_SRC.indexOf("\n}\n", declAt);
    const sites = [...EXEC_SRC.matchAll(/reenableGuardrailsAfterExec\(/g)].map((m) => m.index).filter((i) => i < declAt || i > declEnd);
    expect(sites).toHaveLength(2);
    expect(EXEC_SRC).toContain('if (applyResult.error === "exec.diverged" || applyResult.error === "exec.command_policy_changed") {');
    expect(policyBytes(root)).toBe(BASE_POLICY);
  }, 120_000);

  it("[TR24] rewrite + stage via an admitted script", async () => {
    const root = makeRepo("stage");
    const base = headSha(root);
    const entry = lsEntry(root);
    writePlan(root, "stage", [runCmd("node stage.mjs")]);
    const result = await runExecTool({ projectId: "cpi", label: "stage", skipTests: true });
    expect(result.ok).toBe(false);
    expect(result.error === "exec.command_policy_changed" || result.status === "command_policy_changed").toBe(true);
    expect(result.changedParts).toEqual(expect.arrayContaining(["index", "worktree"]));
    expect(lsEntry(root)).toBe(entry);
    expect(policyBytes(root)).toBe(BASE_POLICY);
    expect(newCommits(root, base)).toEqual([]);
  }, 120_000);

  it("[TR25] git rm --cached", async () => {
    const root = makeRepo("rmcached");
    const entry = lsEntry(root);
    writePlan(root, "rmcached", [runCmd(`git rm --cached ${POLICY_REL}`)]);
    const result = await runExecTool({ projectId: "cpi", label: "rmcached", skipTests: true });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("exec.command_policy_changed");
    expect(result.changedParts).toContain("index");
    expect(result.changedParts).not.toContain("worktree");
    expect(lsEntry(root)).toBe(entry);
    expect(policyBytes(root)).toBe(BASE_POLICY);
  }, 120_000);

  it("[TR26] git checkout <ref> -- policy", async () => {
    const root = makeRepo("checkout");
    // A tag holding a different policy, made on a throwaway branch that is deleted again.
    git(root, ["checkout", "-q", "-b", "tmp-alt"]);
    fs.writeFileSync(path.join(root, POLICY_REL), WIDE_POLICY);
    git(root, ["commit", "-q", "-am", "alt policy"]);
    git(root, ["tag", "alt-policy"]);
    git(root, ["checkout", "-q", "staging"]);
    git(root, ["branch", "-q", "-D", "tmp-alt"]);
    const entry = lsEntry(root);
    writePlan(root, "checkout", [CREATE, runCmd(`git checkout alt-policy -- ${POLICY_REL}`)]);
    const result = await runExecTool({ projectId: "cpi", label: "checkout", skipTests: true });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("exec.command_policy_changed");
    expect(result.stepIndex).toBe(1);
    expect(result.changedParts).toEqual(expect.arrayContaining(["index", "worktree"]));
    expect(lsEntry(root)).toBe(entry);
    expect(policyBytes(root)).toBe(BASE_POLICY);
  }, 120_000);

  it("[TR27] a committed policy change is reset", async () => {
    const root = makeRepo("commit");
    const baseBlob = headPolicyBlob(root);
    writePlan(root, "commit", [runCmd("node commit-policy.mjs")]);
    const result = await runExecTool({ projectId: "cpi", label: "commit", skipTests: true });
    expect(result.changedParts).toContain("head");
    const headRestored = headPolicyBlob(root) === baseBlob;
    const headFailed = (result.restoreFailed || []).some((f) => f.part === "head");
    expect(headRestored || headFailed).toBe(true);
    expect(headRestored).toBe(true);
    expect(result.status).not.toBe("pending_ship");
    expect(result.ok).toBe(false);
    expect(policyBytes(root)).toBe(BASE_POLICY);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// runExecTool: preCommand route and capture mismatch
// ---------------------------------------------------------------------------
describe("exec refuses before apply when the policy changes around preCommands", () => {
  it("[TR28] preCommand route rolls back", async () => {
    const root = makeRepo("precmd", { preCommands: ["node widen.mjs"] });
    writePlan(root, "precmd", [CREATE], { problemId: STORY });
    const result = await runExecTool({ projectId: "cpi", label: "precmd", skipTests: true });
    expect(result.ok).toBe(false);
    expect(result.status).toBe("command_policy_changed");
    expect(result.changedParts).toContain("worktree");
    expect(fs.existsSync(path.join(root, "plan-created.txt"))).toBe(false);
    expect(policyBytes(root)).toBe(BASE_POLICY);
    expect(h.rollbacks).toHaveLength(1);
    expect(h.rollbacks[0].opts.reason).toBe("command_policy_changed");
    expect(h.rollbacks[0].opts.guardrailsSession).toBeNull();
    expect(result.rolledBack).toBe(rolledBackFrom(h.rollbacks[0].ret));
    expect(guardrailsOff).not.toHaveBeenCalled();
    expect(currentBranch(root)).toBe("staging");
    expect(git(root, ["branch", "--list", "rks/*"]).trim()).toBe("");
    expect(policyEvents().map((e) => e.payload.stage)).toEqual(["pre_commands"]);
  }, 120_000);

  it("[TR29] capture mismatch refusal rolls back", async () => {
    const root = makeRepo("mismatch", { preCommands: ["node pre-marker.mjs"] });
    writePlan(root, "mismatch", [CREATE], { problemId: STORY });
    const real = vi.mocked(runner.loadCommandPolicy);
    real.mockImplementationOnce((projectRoot) => {
      const parsed = runner.commandPolicyFromState(runner.captureCommandPolicyState(projectRoot));
      return { ...parsed, auto_execute: [...parsed.auto_execute, "node not-on-disk.mjs"] };
    });
    const result = await runExecTool({ projectId: "cpi", label: "mismatch", skipTests: true });
    expect(result.ok).toBe(false);
    expect(result.status).toBe("command_policy_changed");
    expect(fs.existsSync(path.join(root, "pre-marker.txt"))).toBe(false);
    expect(result.changedParts).toEqual([]);
    expect(result.restored).toEqual([]);
    expect(result.restoreFailed).toEqual([]);
    expect(h.rollbacks).toHaveLength(1);
    expect(h.rollbacks[0].opts.reason).toBe("command_policy_changed");
    expect(h.rollbacks[0].opts.guardrailsSession).toBeNull();
    expect(result.rolledBack).toBe(rolledBackFrom(h.rollbacks[0].ret));
    expect(currentBranch(root)).toBe("staging");
    expect(git(root, ["branch", "--list", "rks/*"]).trim()).toBe("");
    expect(guardrailsOff).not.toHaveBeenCalled();
  }, 120_000);
});

// ---------------------------------------------------------------------------
// runExecTool: after apply, at the exit seam, finalized, throw path
// ---------------------------------------------------------------------------
describe("exec checks the policy after apply and at every exit", () => {
  it("[TR30] post-apply change before commit", async () => {
    const root = makeRepo("precommit", { testArgs: ["--rewrite"] });
    const base = headSha(root);
    writePlan(root, "precommit", [CREATE]);
    const result = await runExecTool({ projectId: "cpi", label: "precommit" });
    expect(result.ok).toBe(false);
    expect(result.status).toBe("command_policy_changed");
    expect(result.changedParts).toContain("worktree");
    expect(newCommits(root, base)).toEqual([]);
    expect(git(root, ["diff", "--cached", "--name-only"]).trim()).toBe("");
    expect(policyBytes(root)).toBe(BASE_POLICY);
    expect(policyEvents().map((e) => e.payload.stage)).toEqual(["pre_commit"]);
  }, 120_000);

  it("[TR31] another failure keeps its status and restores", async () => {
    const root = makeRepo("otherfail", { testArgs: ["--rewrite", "--fail"] });
    const entry = lsEntry(root);
    writePlan(root, "otherfail", [CREATE]);
    const result = await runExecTool({ projectId: "cpi", label: "otherfail" });
    expect(generateFixPlan).toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.testsFailed).toBe(true);
    expect(result.status).not.toBe("command_policy_changed");
    expect(result.commandPolicyRestored).toBeDefined();
    expect(result.commandPolicyRestored.changedParts).toContain("worktree");
    expect(result.commandPolicyRestored.restored).toContain("worktree");
    expect(result.commandPolicyRestored.restoreFailed).toEqual([]);
    expect(policyBytes(root)).toBe(BASE_POLICY);
    expect(lsEntry(root)).toBe(entry);
    expect(policyLines()).toHaveLength(1);
  }, 120_000);

  it("[TR32] positive control", async () => {
    const root = makeRepo("positive");
    const base = headSha(root);
    writePlan(root, "positive", [runCmd("node mark.mjs", { produces: ["marker.txt"] })]);
    const result = await runExecTool({ projectId: "cpi", label: "positive", skipTests: true });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.status).toBe("pending_ship");
    expect(newCommits(root, base).length).toBeGreaterThan(0);
    expect(result).not.toHaveProperty("commandPolicyRestored");
    expect(policyEvents()).toHaveLength(0);
    expect(policyLines()).toHaveLength(0);
    expect(fs.existsSync(path.join(root, "marker.txt"))).toBe(true);
  }, 120_000);

  it("[TR33] telemetry rule (i)", async () => {
    // A run_command that rewrites the policy during apply, with the restore succeeding: one event, apply_step.
    let root = makeRepo("rule-apply");
    writePlan(root, "rule-apply", [runCmd("node widen.mjs")]);
    const applyResult = await runExecTool({ projectId: "cpi", label: "rule-apply", skipTests: true });
    expect(applyResult.error).toBe("exec.command_policy_changed");
    let evs = policyEvents();
    expect(evs).toHaveLength(1);
    expect(evs[0].payload.stage).toBe("apply_step");
    expect(evs[0].payload.stepIndex).toBe(0);
    expect(evs[0].payload.changedParts).toEqual(["worktree"]);
    expect(evs[0].payload.restored).toEqual(["worktree"]);
    expect(evs[0].payload.restoreFailed).toEqual([]);
    expect(evs.filter((e) => e.payload.stage === "exit")).toHaveLength(0);

    // The other-failure case: one event, exit.
    events.length = 0;
    root = makeRepo("rule-exit", { testArgs: ["--rewrite", "--fail"] });
    writePlan(root, "rule-exit", [CREATE]);
    await runExecTool({ projectId: "cpi", label: "rule-exit" });
    evs = policyEvents();
    expect(evs).toHaveLength(1);
    expect(evs[0].payload.stage).toBe("exit");
    expect(evs[0].payload).not.toHaveProperty("stepIndex");
    expect(evs[0].payload.changedParts).toEqual(["worktree"]);
    expect(evs[0].payload.restored).toEqual(["worktree"]);
    expect(evs[0].payload.restoreFailed).toEqual([]);
  }, 180_000);

  it("[TR34] restore-failed case under rule (i)", async () => {
    const root = makeRepo("restorefail");
    vi.mocked(runner.restoreCommandPolicyState).mockImplementationOnce(() => ({ restored: [], failed: [{ part: "worktree", error: "injected" }] }));
    writePlan(root, "restorefail", [runCmd("node widen.mjs")]);
    const result = await runExecTool({ projectId: "cpi", label: "restorefail", skipTests: true });
    expect(result.error).toBe("exec.command_policy_changed");
    expect(result.restoreFailed.map((f) => f.part)).toContain("worktree");
    expect(result.commandPolicyRestored).toEqual({ changedParts: ["worktree"], restored: ["worktree"], restoreFailed: [] });
    expect(policyBytes(root)).toBe(BASE_POLICY);
    const evs = policyEvents();
    expect(evs).toHaveLength(1);
    expect(evs[0].payload.stage).toBe("apply_step");
    expect(evs.filter((e) => e.payload.stage === "exit")).toHaveLength(0);
  }, 120_000);

  it("[TR35] finalized exit with a git hook commit", async () => {
    const root = makeRepo("hook", { testArgs: [] });
    const entry = lsEntry(root);
    const hookPath = path.join(root, ".git", "hooks", "pre-commit");
    fs.mkdirSync(path.dirname(hookPath), { recursive: true });
    fs.writeFileSync(hookPath, [
      `#!${process.execPath}`,
      'const fs = require("node:fs");',
      'const { spawnSync } = require("node:child_process");',
      `fs.writeFileSync(${JSON.stringify(POLICY_REL)}, ${JSON.stringify(HOOK_POLICY)});`,
      spawnLine(["add", POLICY_REL]),
      "",
    ].join("\n"));
    fs.chmodSync(hookPath, 0o755);
    const hookBlob = spawnSync("git", ["hash-object", "--stdin"], { cwd: root, input: HOOK_POLICY, encoding: "utf8", timeout: GIT_TIMEOUT }).stdout.trim();
    const baseBlob = headPolicyBlob(root);
    writePlan(root, "hook", [CREATE]);
    const result = await runExecTool({ projectId: "cpi", label: "hook" });
    expect(result.ok, JSON.stringify(result)).not.toBe(false);
    expect(result.status).not.toBe("command_policy_changed");
    expect(result.commandPolicyRestored).toBeDefined();
    expect(result.commandPolicyRestored.changedParts).toEqual(expect.arrayContaining(["head", "worktree", "index"]));
    expect(result.commandPolicyRestored.restored).toEqual(expect.arrayContaining(["worktree", "index"]));
    expect(result.commandPolicyRestored.restoreFailed).toEqual([]);
    expect(result.commandPolicyRestored.unrevertedParts).toEqual(["head"]);
    expect(policyBytes(root)).toBe(BASE_POLICY);
    expect(lsEntry(root)).toBe(entry);
    expect(headPolicyBlob(root)).toBe(hookBlob);
    expect(headPolicyBlob(root)).not.toBe(baseBlob);
    expect(currentBranch(root)).toMatch(/^rks\//);
    const evs = policyEvents();
    expect(evs).toHaveLength(1);
    expect(evs[0].payload.stage).toBe("exit");
    expect(evs[0].payload.unrevertedParts).toEqual(["head"]);
    const lines = policyLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/unreverted \[head\]/);
  }, 120_000);

  it("[TR36] throw path", async () => {
    const root = makeRepo("throw", { testArgs: ["--rewrite", "--fail"] });
    const injected = new Error("injected");
    vi.mocked(generateFixPlan).mockImplementationOnce(async () => { throw injected; });
    writePlan(root, "throw", [CREATE]);
    const err = await runExecTool({ projectId: "cpi", label: "throw" }).then(() => null, (e) => e);
    expect(err).toBe(injected);
    expect(err.commandPolicyRestored.changedParts).toContain("worktree");
    expect(err.commandPolicyRestored.restored).toContain("worktree");
    expect(err.commandPolicyRestored.restoreFailed).toEqual([]);
    expect(policyBytes(root)).toBe(BASE_POLICY);
    const evs = policyEvents();
    expect(evs).toHaveLength(1);
    expect(evs[0].payload.stage).toBe("exit");
    expect(policyLines()).toHaveLength(1);
  }, 120_000);

  it("[TR36] throw path with a failed restore: the failure is on the error and in the console line", async () => {
    makeRepo("throw-fail", { testArgs: ["--rewrite", "--fail"] });
    const injected = new Error("injected");
    vi.mocked(generateFixPlan).mockImplementationOnce(async () => { throw injected; });
    vi.mocked(runner.restoreCommandPolicyState).mockImplementationOnce(() => ({ restored: [], failed: [{ part: "worktree", error: "injected" }] }));
    writePlan(h.root, "throw-fail", [CREATE]);
    const err = await runExecTool({ projectId: "cpi", label: "throw-fail" }).then(() => null, (e) => e);
    expect(err).toBe(injected);
    expect(err.commandPolicyRestored.restoreFailed).toEqual([{ part: "worktree", error: "injected" }]);
    const lines = policyLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/failed \[worktree \(injected\)\]/);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// backlog.fix.exec-apply-stop-restores-base-branch-and-backup
// The two in-apply rollbacks (per_step_divergence, apply-step command_policy_changed) receive the run's
// real branch, base branch and backup, so the run returns to the base branch, the rks/ branch is deleted
// and the backup stash is applied (and kept in the stash list).
//
// testRequirement -> test mapping (ARn = the story's nth testRequirement):
//   AR1  "[AR1] divergence restores base branch"
//   AR2  "[AR2] divergence resolves the backup like scope_violation"
//   AR3  "[AR3] apply-step policy change restores base branch"
//   AR4  "[AR4] apply-step policy change resolves the backup"
//   AR5  "[AR5] divergence rollback receives real values"
//   AR6  "[AR6] apply-step policy rollback receives real values"
//   AR7  "[AR7] divergence rolledBack is derived from the recorded rollback result"
//   AR8  "[AR8] structural: no exec.diverged return literal carries rolledBack true"
//   AR9  "[AR9] force mode unchanged" (TR21 above stays green as well)
//   AR10 "[AR10] divergence path re-enables guardrails once"
//   AR11 "[AR11] apply-step policy path re-enables guardrails once"
//   AR12 "[AR12] single rollback per divergence and per apply-step policy return"
//   AR13 "[AR13] policy restore precedes branch switch"
//   AR14 "[AR14] process pins" (the pinning tests in exec-commit-failed-not-pending-ship,
//        exec-failed-paused-classification and exec-divergence-telemetry stay the authority)
//   AR15 process: every pre-existing test in the story's testFiles passes unchanged (no edits to them).
//   AR16 process: every git spawn in this file goes through git() or spawnSync with timeout GIT_TIMEOUT.
// ---------------------------------------------------------------------------
const { rollback: rollbackSpy } = await import("../../packages/mcp-rks/src/server/test-runner.mjs");

const OPERATOR_LOCK = '{ "operator": "pre-run edit" }\n';
// Step 0 (run_command) writes marker.txt, which no step declares. The per-step divergence check runs after
// file steps, so step 1 (create_file) is where the divergence is detected.
const DIVERGE = [runCmd("node mark.mjs"), CREATE];
const stashShas = (root) => git(root, ["stash", "list", "--format=%H"]).split("\n").filter(Boolean);
const rksBranches = (root) => git(root, ["branch", "--list", "rks/*"]).trim();
const divergenceRollbacks = () => h.rollbacks.filter((r) => r.opts?.reason === "per_step_divergence");

/**
 * The AC2 fixture shape: a committed package-lock.json the operator then edits, and an untracked
 * .dendron.port. Both are runtime artifacts the dirty-tree gate admits, so createBackup stashes them.
 *
 * The baseline .gitignore (".rks/") is emptied in the same commit: with .rks/ ignored, createBackup's
 * `stash push -u -- :/ :(exclude).rks ...` exits 1 ("The following paths are ignored ... .rks") after
 * saving the entry but WITHOUT clearing the tree (observed on git 2.54), so nothing would be left to
 * restore. Un-ignoring .rks/ keeps the run state untracked; the stash pathspec still excludes it.
 */
function makeDirtyRepo(tag) {
  const root = makeRepo(tag);
  fs.writeFileSync(path.join(root, ".gitignore"), "");
  fs.writeFileSync(path.join(root, "package-lock.json"), '{ "base": true }\n');
  git(root, ["add", ".gitignore", "package-lock.json"]);
  git(root, ["commit", "-q", "-m", "lockfile"]);
  fs.writeFileSync(path.join(root, "package-lock.json"), OPERATOR_LOCK);
  fs.writeFileSync(path.join(root, ".dendron.port"), "4242\n");
  expect(stashShas(root)).toEqual([]);
  return root;
}

describe("exec stopped mid-apply restores the base branch and the backup", () => {
  it("[AR1] divergence restores base branch", async () => {
    const root = makeRepo("div-branch");
    writePlan(root, "div-branch", DIVERGE);
    const result = await runExecTool({ projectId: "cpi", label: "div-branch", skipTests: true });
    expect(result.error, JSON.stringify(result)).toBe("exec.diverged");
    expect(currentBranch(root)).toBe("staging");
    expect(rksBranches(root)).toBe("");
  }, 120_000);

  it("[AR2] divergence resolves the backup like scope_violation", async () => {
    const root = makeDirtyRepo("div-backup");
    writePlan(root, "div-backup", DIVERGE);
    const result = await runExecTool({ projectId: "cpi", label: "div-backup", skipTests: true });
    expect(result.error, JSON.stringify(result)).toBe("exec.diverged");
    const calls = divergenceRollbacks();
    expect(calls).toHaveLength(1);
    expect(calls[0].ret.restored, JSON.stringify(calls[0].ret)).toBe(true);
    const sha = calls[0].opts.backupMeta?.stashSha;
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(stashShas(root)).toContain(sha);
    expect(git(root, ["show", `${sha}:package-lock.json`])).toBe(OPERATOR_LOCK);
  }, 120_000);

  it("[AR3] apply-step policy change restores base branch", async () => {
    const root = makeRepo("pol-branch");
    const entry = lsEntry(root);
    const baseBlob = headPolicyBlob(root);
    writePlan(root, "pol-branch", [runCmd("node widen.mjs")]);
    const result = await runExecTool({ projectId: "cpi", label: "pol-branch", skipTests: true });
    expect(result.error, JSON.stringify(result)).toBe("exec.command_policy_changed");
    expect(result.stepIndex).toBe(0);
    expect(currentBranch(root)).toBe("staging");
    expect(rksBranches(root)).toBe("");
    expect(policyBytes(root)).toBe(BASE_POLICY);
    expect(lsEntry(root)).toBe(entry);
    expect(headPolicyBlob(root)).toBe(baseBlob);
  }, 120_000);

  it("[AR4] apply-step policy change resolves the backup", async () => {
    const root = makeDirtyRepo("pol-backup");
    writePlan(root, "pol-backup", [runCmd("node widen.mjs")]);
    const result = await runExecTool({ projectId: "cpi", label: "pol-backup", skipTests: true });
    expect(result.error, JSON.stringify(result)).toBe("exec.command_policy_changed");
    const calls = policyRollbacks();
    expect(calls).toHaveLength(1);
    expect(calls[0].ret.restored, JSON.stringify(calls[0].ret)).toBe(true);
    const sha = calls[0].opts.backupMeta?.stashSha;
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(stashShas(root)).toContain(sha);
    expect(git(root, ["show", `${sha}:package-lock.json`])).toBe(OPERATOR_LOCK);
  }, 120_000);

  it("[AR5] divergence rollback receives real values", async () => {
    const root = makeDirtyRepo("div-opts");
    writePlan(root, "div-opts", DIVERGE);
    const result = await runExecTool({ projectId: "cpi", label: "div-opts", skipTests: true });
    expect(result.error).toBe("exec.diverged");
    const calls = divergenceRollbacks();
    expect(calls).toHaveLength(1);
    const { opts } = calls[0];
    expect(opts.branchName).toMatch(/^rks\//);
    expect(opts.baseBranch).toBe("staging");
    expect(opts.backupMeta).not.toBeNull();
    const added = stashShas(root);
    expect(added).toHaveLength(1);
    expect(opts.backupMeta.stashSha).toBe(added[0]);
    expect(opts.guardrailsSession).toBeNull();
  }, 120_000);

  it("[AR6] apply-step policy rollback receives real values", async () => {
    const root = makeDirtyRepo("pol-opts");
    writePlan(root, "pol-opts", [runCmd("node widen.mjs")]);
    const result = await runExecTool({ projectId: "cpi", label: "pol-opts", skipTests: true });
    expect(result.error).toBe("exec.command_policy_changed");
    const calls = policyRollbacks();
    expect(calls).toHaveLength(1);
    const { opts } = calls[0];
    expect(opts.branchName).toMatch(/^rks\//);
    expect(opts.baseBranch).toBe("staging");
    expect(opts.backupMeta).not.toBeNull();
    const added = stashShas(root);
    expect(added).toHaveLength(1);
    expect(opts.backupMeta.stashSha).toBe(added[0]);
    expect(opts.guardrailsSession).toBeNull();
  }, 120_000);

  it("[AR7] divergence rolledBack is derived from the recorded rollback result", async () => {
    const root = makeRepo("div-rolledback");
    writePlan(root, "div-rolledback", DIVERGE);
    const result = await runExecTool({ projectId: "cpi", label: "div-rolledback", skipTests: true });
    expect(result.error).toBe("exec.diverged");
    const calls = divergenceRollbacks();
    expect(calls).toHaveLength(1);
    expect(result.rolledBack).toBe(rolledBackFrom(calls[0].ret));

    // Observed, not a literal: a rollback that neither restored nor cleaned yields false.
    events.length = 0;
    h.rollbacks.length = 0;
    const root2 = makeRepo("div-rolledback-false");
    writePlan(root2, "div-rolledback-false", DIVERGE);
    vi.mocked(rollbackSpy).mockImplementationOnce(async (projectRoot, opts) => {
      const ret = { reason: opts.reason, partialDiffPath: null, restored: false, cleaned: false, branchCleaned: false, guardrailsRestored: false };
      h.rollbacks.push({ opts, ret });
      return ret;
    });
    const result2 = await runExecTool({ projectId: "cpi", label: "div-rolledback-false", skipTests: true });
    expect(result2.error).toBe("exec.diverged");
    expect(divergenceRollbacks()).toHaveLength(1);
    expect(result2.rolledBack).toBe(false);
  }, 180_000);

  // backlog.fix.cleanup-feature-branch-unmerged-guard: the per_step_divergence response forwards the
  // rollback result's branchRetained, and null when rollback retained no branch (the AR7 stub shape).
  it("[AR7b] divergence forwards rollback's branchRetained, null when none", async () => {
    const retained = { branchName: "rks/div-retained", reason: "unmerged_commits", unmergedCount: 1, unmergedCommits: ["a".repeat(40)] };
    const root = makeRepo("div-retained");
    writePlan(root, "div-retained", DIVERGE);
    vi.mocked(rollbackSpy).mockImplementationOnce(async (projectRoot, opts) => {
      const ret = { reason: opts.reason, partialDiffPath: null, restored: false, cleaned: false, branchCleaned: false, guardrailsRestored: false, branchRetained: retained };
      h.rollbacks.push({ opts, ret });
      return ret;
    });
    const result = await runExecTool({ projectId: "cpi", label: "div-retained", skipTests: true });
    expect(result.error).toBe("exec.diverged");
    expect(divergenceRollbacks()).toHaveLength(1);
    expect(result.branchRetained).toEqual(retained);

    h.rollbacks.length = 0;
    const root2 = makeRepo("div-retained-none");
    writePlan(root2, "div-retained-none", DIVERGE);
    vi.mocked(rollbackSpy).mockImplementationOnce(async (projectRoot, opts) => {
      const ret = { reason: opts.reason, partialDiffPath: null, restored: false, cleaned: false, branchCleaned: false, guardrailsRestored: false };
      h.rollbacks.push({ opts, ret });
      return ret;
    });
    const result2 = await runExecTool({ projectId: "cpi", label: "div-retained-none", skipTests: true });
    expect(result2.error).toBe("exec.diverged");
    expect(divergenceRollbacks()).toHaveLength(1);
    expect(result2.branchRetained).toBe(null);
  }, 180_000);

  it("[AR8] structural: no exec.diverged return literal carries rolledBack true", () => {
    const stripped = EXEC_SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
    const literals = [...stripped.matchAll(/return \{[^}]*exec\.diverged[\s\S]*?\n\s*\};/g)].map((m) => m[0]);
    expect(literals.length).toBeGreaterThanOrEqual(1);
    for (const l of literals) expect(l).not.toMatch(/\brolledBack:\s*true\b/);
  });

  it("[AR9] force mode unchanged", async () => {
    const root = makeRepo("force-unchanged");
    const head = headSha(root);
    fs.writeFileSync(path.join(root, "other.txt"), "operator edit\n");
    fs.writeFileSync(path.join(root, "untracked.txt"), "operator scratch\n");
    const label = writePlan(root, "force-unchanged", [runCmd("node widen.mjs")]);
    const res = await runApplyTool({ projectId: "cpi", label, force: true });
    expect(res.error).toBe("exec.command_policy_changed");
    expect(h.rollbacks).toHaveLength(0);
    expect(headSha(root)).toBe(head);
    expect(currentBranch(root)).toBe("staging");
    expect(fs.readFileSync(path.join(root, "other.txt"), "utf8")).toBe("operator edit\n");
    expect(fs.existsSync(path.join(root, "untracked.txt"))).toBe(true);
  }, 120_000);

  it("[AR10] divergence path re-enables guardrails once", async () => {
    const root = makeRepo("div-guardrails");
    writePlan(root, "div-guardrails", DIVERGE);
    const result = await runExecTool({ projectId: "cpi", label: "div-guardrails", skipTests: true });
    expect(result.error).toBe("exec.diverged");
    expect(guardrailsOn).toHaveBeenCalledTimes(1);
    const onEvents = events.filter((e) => e.type === "exec.guardrails_on");
    expect(onEvents).toHaveLength(1);
    expect(onEvents[0].payload.path).toBe("divergence");
  }, 120_000);

  it("[AR11] apply-step policy path re-enables guardrails once", async () => {
    const root = makeRepo("pol-guardrails");
    writePlan(root, "pol-guardrails", [runCmd("node widen.mjs")]);
    const result = await runExecTool({ projectId: "cpi", label: "pol-guardrails", skipTests: true });
    expect(result.error).toBe("exec.command_policy_changed");
    expect(guardrailsOn).toHaveBeenCalledTimes(1);
    const onEvents = events.filter((e) => e.type === "exec.guardrails_on");
    expect(onEvents).toHaveLength(1);
    expect(onEvents[0].payload.path).toBe("command_policy_changed");
  }, 120_000);

  it("[AR12] single rollback per divergence and per apply-step policy return", async () => {
    let root = makeRepo("div-single");
    writePlan(root, "div-single", DIVERGE);
    let result = await runExecTool({ projectId: "cpi", label: "div-single", skipTests: true });
    expect(result.error).toBe("exec.diverged");
    expect(h.rollbacks).toHaveLength(1);
    expect(h.rollbacks[0].opts.reason).toBe("per_step_divergence");

    h.rollbacks.length = 0;
    root = makeRepo("pol-single");
    writePlan(root, "pol-single", [runCmd("node widen.mjs")]);
    result = await runExecTool({ projectId: "cpi", label: "pol-single", skipTests: true });
    expect(result.error).toBe("exec.command_policy_changed");
    expect(h.rollbacks).toHaveLength(1);
    expect(h.rollbacks[0].opts.reason).toBe("command_policy_changed");
  }, 180_000);

  it("[AR13] policy restore precedes branch switch", async () => {
    const root = makeRepo("pol-order");
    const base = headSha(root);
    const baseBlob = headPolicyBlob(root);
    writePlan(root, "pol-order", [runCmd("node commit-policy.mjs")]);
    vi.mocked(rollbackSpy).mockClear();
    const result = await runExecTool({ projectId: "cpi", label: "pol-order", skipTests: true });
    expect(result.error).toBe("exec.command_policy_changed");
    expect(result.changedParts).toContain("head");
    const restoreOrder = vi.mocked(runner.restoreCommandPolicyState).mock.invocationCallOrder;
    const rollbackOrder = vi.mocked(rollbackSpy).mock.invocationCallOrder;
    expect(restoreOrder.length).toBeGreaterThanOrEqual(1);
    expect(rollbackOrder).toHaveLength(1);
    expect(restoreOrder[0]).toBeLessThan(rollbackOrder[0]);
    expect(currentBranch(root)).toBe("staging");
    expect(headPolicyBlob(root)).toBe(baseBlob);
    expect(newCommits(root, base)).toEqual([]);
  }, 120_000);

  it("[AR14] process pins: rollback, guardrails and terminal counts are unchanged", () => {
    const count = (re) => (EXEC_SRC.match(re) || []).length;
    expect(count(/await rollback\(/g)).toBe(13);
    expect(count(/reenableGuardrailsAfterExec\(/g)).toBe(3);
    expect(count(/guardrailsOn\(/g)).toBe(1);
    expect(count(/ctx\.terminalDetail = \{/g)).toBe(15);
    for (const m of EXEC_SRC.matchAll(/await rollback\([^)]*\)/g)) expect(m[0]).toContain("correlationId");
  });
});
