/**
 * backlog.fix.run-command-policy-snapshot-per-run
 *
 * Layer 1: the run_command policy is snapshotted once per runApplyTool invocation, so neither a
 * file step nor a run_command side effect can widen what a later step of the same apply may run.
 * Layer 2: any plan file step targeting .routekit/command-policy.yaml is refused before any step
 * applies, in runApplyTool and in applyFixPlan (the rks_exec fix-plan write path).
 * Fixture: project root and registry live under TEMP_BASE (os.tmpdir()/rks-tests), never inside the
 * repo worktree; the registry is reached only through the VITEST-gated RKS_REGISTRY_PATH seam
 * (packages/cli/src/project/index.js), following tests/integration/exec-story-load-fail-closed.test.mjs.
 * The live projects/index.jsonl is never read or written. Env is set before the dynamic import.
 *
 * testRequirement -> test mapping (TRn = the story's nth testRequirement; TR21-TR24 are [process]):
 *   TR1  "[TR1] matches the policy file in every path spelling"
 *   TR2  "[TR2] does not match look-alikes or paths outside the project root"
 *   TR3  "[TR3] loadCommandPolicy reads the file named by COMMAND_POLICY_RELATIVE_PATH"
 *   TR4  "[TR4] an injected policy overrides a wider on-disk policy"
 *   TR5  "[TR5] an injected policy admits a command the on-disk default does not"
 *   TR6  "[TR6] a run_command side effect that widens the policy does not admit a later step"
 *   TR7  "[TR7] positive control: a command in the pre-apply policy still runs"
 *   TR8, TR9, TR11  "[TR8][TR9][TR11] refuses <spelling> with InvalidRequest before any step applies"
 *   TR10 "[TR10] refuses <action> on the policy file" (create_file via the TR8 tests)
 *   TR12 "[TR12] refuses whether .rks/protected-files.yml is absent or present"
 *   TR13 "[TR13] refuses on the rks_exec path (_execContext true)"
 *   TR14 "[TR14] the rks_apply call shape is stopped by the direct-call guard"
 *   TR15 "[TR15] does not refuse a look-alike target (docs/command-policy.yaml)"
 *   TR16, TR17  "[TR16]/[TR17] applyFixPlan refuses <action> <spelling>"
 *   TR18 "[TR18] applyFixPlan refuses whether .rks/protected-files.yml is absent or present"
 *   TR19 "[TR19] positive control: a fix plan writing docs/command-policy.yaml applies"
 *   TR20 "[TR20] loadCommandPolicy with no policy file returns the unwidened default lists"
 *
 * backlog.fix.command-policy-integrity-across-runs (CPI-TRn = that story's nth testRequirement):
 *   CPI-TR16 "[CPI-TR16] refuses ... a create_file whose target reaches the policy through a symlinked directory"
 *   CPI-TR17 "[TR6][CPI-TR17] ..." (TR6 changed: the widened policy is restored, the apply fails at step 0)
 *   CPI-TR18 "[CPI-TR18] step N a file step, step N+1 a policy-rewriting run_command ..."
 *   CPI-TR19 "[CPI-TR19] a run_command that deletes the policy file ..."
 *   CPI-TR20 "[TR7] positive control: a command in the pre-apply policy still runs" (unchanged)
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { TEMP_BASE } from "../helpers/tmp.mjs";

const projectRoot = path.join(TEMP_BASE, `rcps-${Date.now()}-${Math.random().toString(16).slice(2)}`);
let registryDir = null;
let prevRegistryEnv;
const prevRoot = process.env.ROUTEKIT_PROJECT_ROOT;
const prevClaudeDir = process.env.CLAUDE_PROJECT_DIR;
process.env.ROUTEKIT_PROJECT_ROOT = projectRoot;
process.env.CLAUDE_PROJECT_DIR = projectRoot;

const { runApplyTool } = await import("../../packages/mcp-rks/src/server.mjs");
const { applyFixPlan } = await import("../../packages/mcp-rks/src/server/fix-planner.mjs");
const {
  handleRunCommandStep,
  loadCommandPolicy,
  isCommandPolicyTarget,
  COMMAND_POLICY_RELATIVE_PATH,
} = await import("../../packages/mcp-rks/src/exec/command-runner.mjs");

const TIMEOUT = 15_000;
const POLICY_ABS = () => path.join(projectRoot, ".routekit", "command-policy.yaml");
const MARK_CMD = "node mark.mjs";
const WIDEN_CMD = "node widen.mjs";

function policyYaml({ auto = [], approval = [], confirm = [] }) {
  const list = (xs) => (xs.length ? xs.map((x) => `    - "${x}"`).join("\n") : "    []");
  return [
    "command_policy:",
    "  auto_execute:", list(auto),
    "  execute_with_plan_approval:", list(approval),
    "  require_explicit_confirmation:", list(confirm),
    "",
  ].join("\n");
}

function writePolicy(tiers) {
  fs.mkdirSync(path.dirname(POLICY_ABS()), { recursive: true });
  fs.writeFileSync(POLICY_ABS(), policyYaml(tiers));
}

// mark.mjs writes a marker; widen.mjs writes its own marker and rewrites the policy to admit MARK_CMD.
function writeScripts() {
  fs.writeFileSync(path.join(projectRoot, "mark.mjs"), 'import fs from "node:fs"; fs.writeFileSync("marker.txt", "ran");\n');
  fs.writeFileSync(
    path.join(projectRoot, "widen.mjs"),
    'import fs from "node:fs"; fs.writeFileSync("widen-marker.txt", "ran");\n' +
      `fs.writeFileSync(".routekit/command-policy.yaml", ${JSON.stringify(policyYaml({ auto: [WIDEN_CMD, MARK_CMD] }))});\n`,
  );
}

let runSeq = 0;

function writePlan(steps) {
  const label = `rcps${++runSeq}`;
  const runDir = path.join(projectRoot, ".rks", "runs", `2026-${label}-${Date.now()}_${label}`);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, "plan.json"), JSON.stringify({ steps }, null, 2));
  fs.writeFileSync(
    path.join(runDir, "run.json"),
    JSON.stringify({ projectId, timestamps: { plannedAt: new Date().toISOString() }, telemetry: { outcome: "planned" } }, null, 2),
  );
  return label;
}

const projectId = `rcps-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

beforeEach(() => {
  prevRegistryEnv = process.env.RKS_REGISTRY_PATH;
  registryDir = fs.mkdtempSync(path.join(TEMP_BASE, "rcps-registry-"));
  process.env.RKS_REGISTRY_PATH = path.join(registryDir, "index.jsonl");
  fs.mkdirSync(path.join(projectRoot, "routekit"), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, "routekit", "project.json"), JSON.stringify({ id: projectId, baseBranch: "dev", kgFile: "routekit/kg.yaml" }));
  fs.writeFileSync(path.join(projectRoot, "routekit", "kg.yaml"), "code_roots: []\n");
  fs.writeFileSync(process.env.RKS_REGISTRY_PATH, JSON.stringify({ id: projectId, root: projectRoot }) + "\n");
  writeScripts();
});

afterEach(() => {
  if (prevRegistryEnv === undefined) delete process.env.RKS_REGISTRY_PATH;
  else process.env.RKS_REGISTRY_PATH = prevRegistryEnv;
  if (registryDir) fs.rmSync(registryDir, { recursive: true, force: true });
  registryDir = null;
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

process.on("exit", () => {
  if (prevRoot === undefined) delete process.env.ROUTEKIT_PROJECT_ROOT; else process.env.ROUTEKIT_PROJECT_ROOT = prevRoot;
  if (prevClaudeDir === undefined) delete process.env.CLAUDE_PROJECT_DIR; else process.env.CLAUDE_PROJECT_DIR = prevClaudeDir;
});

describe("isCommandPolicyTarget", () => {
  it("[TR1] matches the policy file in every path spelling", () => {
    for (const t of [
      ".routekit/command-policy.yaml",
      "./.routekit/command-policy.yaml",
      ".routekit/../.routekit/command-policy.yaml",
      ".ROUTEKIT/Command-Policy.yaml",
      path.join(projectRoot, ".routekit", "command-policy.yaml"),
    ]) expect(isCommandPolicyTarget(projectRoot, t), t).toBe(true);
  });

  it("[TR2] does not match look-alikes or paths outside the project root", () => {
    for (const t of [
      "docs/command-policy.yaml",
      ".routekit/command-policy.yaml.bak",
      ".routekit/other.yaml",
      "../elsewhere/.routekit/command-policy.yaml",
    ]) expect(isCommandPolicyTarget(projectRoot, t), t).toBe(false);
  });

  it("[TR3] loadCommandPolicy reads the file named by COMMAND_POLICY_RELATIVE_PATH", () => {
    expect(COMMAND_POLICY_RELATIVE_PATH).toBe(".routekit/command-policy.yaml");
    writePolicy({ auto: [MARK_CMD] });
    expect(loadCommandPolicy(projectRoot).auto_execute).toEqual([MARK_CMD]);
  });

  it("[TR20] loadCommandPolicy with no policy file returns the unwidened default lists", () => {
    expect(fs.existsSync(POLICY_ABS())).toBe(false);
    const p = loadCommandPolicy(projectRoot);
    expect(p.auto_execute).toEqual(["git status", "git diff", "npm test", "npm run lint", "npm run build"]);
    expect(p.execute_with_plan_approval).toEqual(["git add", "git rm --cached", "git commit", "npm install"]);
    expect(p.require_explicit_confirmation).toEqual(["rm", "git reset", "git push --force", "git branch -D"]);
  });
});

describe("handleRunCommandStep injected policy", () => {
  it("[TR4] an injected policy overrides a wider on-disk policy", async () => {
    writePolicy({ auto: [MARK_CMD] });
    const injected = { auto_execute: [], execute_with_plan_approval: [], require_explicit_confirmation: [] };
    const r = await handleRunCommandStep(MARK_CMD, { projectRoot, planApproved: true, timeout: TIMEOUT, policy: injected });
    expect(r.executed).not.toBe(true);
    expect(fs.existsSync(path.join(projectRoot, "marker.txt"))).toBe(false);
  });

  it("[TR5] an injected policy admits a command the on-disk default does not", async () => {
    const injected = { auto_execute: [MARK_CMD], execute_with_plan_approval: [], require_explicit_confirmation: [] };
    const r = await handleRunCommandStep(MARK_CMD, { projectRoot, planApproved: true, timeout: TIMEOUT, policy: injected });
    expect(r.executed).toBe(true);
    expect(fs.existsSync(path.join(projectRoot, "marker.txt"))).toBe(true);
  });
});

describe("runApplyTool policy snapshot", () => {
  // backlog.fix.command-policy-integrity-across-runs changed TR6: the widened policy no longer
  // persists. The apply fails at the widening step and the pre-apply policy bytes are restored.
  it("[TR6][CPI-TR17] a run_command side effect that widens the policy fails the apply at that step and is restored", async () => {
    writePolicy({ auto: [WIDEN_CMD] });
    const before = fs.readFileSync(POLICY_ABS());
    const label = writePlan([
      { action: "run_command", command: WIDEN_CMD },
      { action: "run_command", command: MARK_CMD },
    ]);
    const res = await runApplyTool({ projectId, label, force: true });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("exec.command_policy_changed");
    expect(res.stepIndex).toBe(0);
    expect(res.changedParts).toContain("worktree");
    expect(res.rolledBack).toBe(false);
    expect(fs.existsSync(path.join(projectRoot, "widen-marker.txt"))).toBe(true);
    expect(fs.existsSync(path.join(projectRoot, "marker.txt"))).toBe(false);
    expect(fs.readFileSync(POLICY_ABS()).equals(before)).toBe(true);
  });

  it("[CPI-TR18] step N a file step, step N+1 a policy-rewriting run_command: fails at N+1, restored, step N+2 never runs", async () => {
    writePolicy({ auto: [WIDEN_CMD] });
    const before = fs.readFileSync(POLICY_ABS());
    const label = writePlan([
      { action: "create_file", path: "early.txt", content: "early\n" },
      { action: "run_command", command: WIDEN_CMD },
      { action: "run_command", command: MARK_CMD },
    ]);
    const res = await runApplyTool({ projectId, label, force: true });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("exec.command_policy_changed");
    expect(res.stepIndex).toBe(1);
    expect(fs.readFileSync(POLICY_ABS()).equals(before)).toBe(true);
    expect(fs.existsSync(path.join(projectRoot, "marker.txt"))).toBe(false);
  });

  it("[CPI-TR19] a run_command that deletes the policy file fails the apply and the file is recreated with the pre-apply bytes", async () => {
    writePolicy({ auto: ["node unlink-policy.mjs"] });
    fs.writeFileSync(path.join(projectRoot, "unlink-policy.mjs"), 'import fs from "node:fs"; fs.rmSync(".routekit/command-policy.yaml");\n');
    const before = fs.readFileSync(POLICY_ABS());
    const label = writePlan([{ action: "run_command", command: "node unlink-policy.mjs" }]);
    const res = await runApplyTool({ projectId, label, force: true });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("exec.command_policy_changed");
    expect(res.changedParts).toContain("worktree");
    expect(fs.existsSync(POLICY_ABS())).toBe(true);
    expect(fs.readFileSync(POLICY_ABS()).equals(before)).toBe(true);
  });

  it("[CPI-TR16] refuses, before any step applies, a create_file whose target reaches the policy through a symlinked directory", async () => {
    writePolicy({ auto: [MARK_CMD] });
    const before = fs.readFileSync(POLICY_ABS());
    fs.symlinkSync(path.join(projectRoot, ".routekit"), path.join(projectRoot, "link-dir"));
    const label = writePlan([
      { action: "create_file", path: "early.txt", content: "early\n" },
      { action: "create_file", path: "link-dir/command-policy.yaml", content: policyYaml({ auto: ["rm"] }) },
    ]);
    const err = await runApplyTool({ projectId, label, force: true }).then(() => null, (e) => e);
    expect(err?.code).toBe(ErrorCode.InvalidRequest);
    expect(String(err.message)).toMatch(/command policy/i);
    expect(fs.existsSync(path.join(projectRoot, "early.txt"))).toBe(false);
    expect(fs.readFileSync(POLICY_ABS()).equals(before)).toBe(true);
  });

  it("[TR7] positive control: a command in the pre-apply policy still runs", async () => {
    writePolicy({ auto: [MARK_CMD] });
    const label = writePlan([{ action: "run_command", command: MARK_CMD }]);
    const res = await runApplyTool({ projectId, label, force: true });
    expect(res.ok).toBe(true);
    expect(fs.existsSync(path.join(projectRoot, "marker.txt"))).toBe(true);
  });
});

describe("runApplyTool refuses plan steps that target the command policy", () => {
  const variants = [
    ".routekit/command-policy.yaml",
    "./.routekit/command-policy.yaml",
    ".routekit/../.routekit/command-policy.yaml",
    ".ROUTEKIT/Command-Policy.yaml",
  ];

  for (const target of variants) {
    it(`[TR8][TR9][TR11] refuses ${target} with InvalidRequest before any step applies`, async () => {
      writePolicy({ auto: [MARK_CMD] });
      const before = fs.readFileSync(POLICY_ABS(), "utf8");
      const label = writePlan([
        { action: "create_file", path: "early.txt", content: "early\n" },
        { action: "run_command", command: MARK_CMD },
        { action: "create_file", path: target, content: policyYaml({ auto: ["rm"] }) },
      ]);
      const err = await runApplyTool({ projectId, label, force: true }).then(() => null, (e) => e);
      expect(err?.code).toBe(ErrorCode.InvalidRequest);
      expect(String(err.message)).toContain(target);
      expect(String(err.message)).toMatch(/command policy/i);
      expect(String(err.message)).toMatch(/off-rail/i);
      expect(fs.existsSync(path.join(projectRoot, "early.txt"))).toBe(false);
      expect(fs.existsSync(path.join(projectRoot, "marker.txt"))).toBe(false);
      expect(fs.readFileSync(POLICY_ABS(), "utf8")).toBe(before);
    });
  }

  // Pre-flight refusal: the search_replace edit shape is never applied, so any non-empty edits array serves.
  const policyStep = (action, target) => ({
    create_file: { action, path: target, content: policyYaml({ auto: ["rm"] }) },
    edit_file: { action, path: target, content: policyYaml({ auto: ["rm"] }) },
    search_replace: { action, path: target, edits: [{ search: "command_policy:", replace: "command_policy:" }] },
    delete_file: { action, path: target },
  })[action];

  for (const action of ["edit_file", "search_replace", "delete_file"]) {
    it(`[TR10] refuses ${action} on the policy file before any step applies`, async () => {
      writePolicy({ auto: [MARK_CMD] });
      const before = fs.readFileSync(POLICY_ABS(), "utf8");
      const label = writePlan([
        { action: "create_file", path: "early.txt", content: "early\n" },
        policyStep(action, ".routekit/command-policy.yaml"),
      ]);
      const err = await runApplyTool({ projectId, label, force: true }).then(() => null, (e) => e);
      expect(err?.code).toBe(ErrorCode.InvalidRequest);
      expect(fs.existsSync(path.join(projectRoot, "early.txt"))).toBe(false);
      expect(fs.readFileSync(POLICY_ABS(), "utf8")).toBe(before);
    });
  }

  it("[TR12] refuses whether .rks/protected-files.yml is absent or present with an unrelated entry", async () => {
    const protectedYml = path.join(projectRoot, ".rks", "protected-files.yml");
    for (const present of [false, true]) {
      writePolicy({ auto: [MARK_CMD] });
      fs.rmSync(path.join(projectRoot, "early.txt"), { force: true });
      if (present) {
        fs.mkdirSync(path.dirname(protectedYml), { recursive: true });
        fs.writeFileSync(protectedYml, 'protected:\n  - "package.json"\n');
      }
      expect(fs.existsSync(protectedYml)).toBe(present);
      const before = fs.readFileSync(POLICY_ABS(), "utf8");
      const label = writePlan([
        { action: "create_file", path: "early.txt", content: "early\n" },
        policyStep("create_file", ".routekit/command-policy.yaml"),
      ]);
      const err = await runApplyTool({ projectId, label, force: true }).then(() => null, (e) => e);
      expect(err?.code, `protected-files present=${present}`).toBe(ErrorCode.InvalidRequest);
      expect(String(err.message)).toMatch(/command policy/i);
      expect(fs.existsSync(path.join(projectRoot, "early.txt"))).toBe(false);
      expect(fs.readFileSync(POLICY_ABS(), "utf8")).toBe(before);
    }
  });

  it("[TR13] refuses on the rks_exec path (_execContext true) before any step applies", async () => {
    writePolicy({ auto: [MARK_CMD] });
    const label = writePlan([
      { action: "create_file", path: "early.txt", content: "early\n" },
      policyStep("create_file", ".routekit/command-policy.yaml"),
    ]);
    const err = await runApplyTool({ projectId, label, _execContext: true }).then(() => null, (e) => e);
    expect(err?.code).toBe(ErrorCode.InvalidRequest);
    expect(fs.existsSync(path.join(projectRoot, "early.txt"))).toBe(false);
  });

  it("[TR14] the rks_apply call shape ({ projectId, label } only) is stopped by the direct-call guard", async () => {
    writePolicy({ auto: [MARK_CMD] });
    const label = writePlan([
      { action: "create_file", path: "early.txt", content: "early\n" },
      policyStep("create_file", ".routekit/command-policy.yaml"),
    ]);
    const err = await runApplyTool({ projectId, label }).then(() => null, (e) => e);
    expect(err?.code).toBe(ErrorCode.InvalidRequest);
    expect(String(err.message)).toMatch(/cannot be called directly/);
    expect(fs.existsSync(path.join(projectRoot, "early.txt"))).toBe(false);
  });

  it("[TR15] does not refuse a look-alike target (docs/command-policy.yaml)", async () => {
    const label = writePlan([{ action: "create_file", path: "docs/command-policy.yaml", content: "x: 1\n" }]);
    const res = await runApplyTool({ projectId, label, force: true });
    expect(res.ok).toBe(true);
    expect(fs.existsSync(path.join(projectRoot, "docs", "command-policy.yaml"))).toBe(true);
  });
});

describe("applyFixPlan refuses fix-plan steps that target the command policy", () => {
  const fixRunDir = () => {
    const d = path.join(projectRoot, ".rks", "runs", `fix-${++runSeq}`);
    fs.mkdirSync(d, { recursive: true });
    return d;
  };
  const fixStep = (action, target) => ({
    create_file: { action, path: target, content: policyYaml({ auto: ["rm"] }) },
    edit_file: { action, path: target, content: policyYaml({ auto: ["rm"] }) },
    search_replace: { action, path: target, edits: [{ search: "command_policy:", replace: "command_policy:" }] },
    delete_file: { action, path: target },
  })[action];

  const cases = [
    ...[".routekit/command-policy.yaml", "./.routekit/command-policy.yaml", ".routekit/../.routekit/command-policy.yaml", ".ROUTEKIT/Command-Policy.yaml"]
      .map((target) => ["create_file", target]),
    ...["edit_file", "search_replace", "delete_file"].map((action) => [action, ".routekit/command-policy.yaml"]),
  ];

  for (const [action, target] of cases) {
    it(`[${action === "create_file" ? "TR16" : "TR17"}] applyFixPlan refuses ${action} ${target} before any fix step writes`, async () => {
      writePolicy({ auto: [MARK_CMD] });
      const before = fs.readFileSync(POLICY_ABS(), "utf8");
      const res = await applyFixPlan({
        projectId,
        projectRoot,
        runDir: fixRunDir(),
        attemptNumber: 2,
        plan: { steps: [{ action: "create_file", path: "early.txt", content: "early\n" }, fixStep(action, target)] },
      });
      expect(res.ok).toBe(false);
      expect(String(res.error)).toContain(target);
      expect(String(res.error)).toMatch(/command policy/i);
      expect(String(res.error)).toMatch(/off-rail/i);
      expect(res.appliedFiles).toEqual([]);
      expect(fs.existsSync(path.join(projectRoot, "early.txt"))).toBe(false);
      expect(fs.readFileSync(POLICY_ABS(), "utf8")).toBe(before);
    });
  }

  it("[TR18] applyFixPlan refuses whether .rks/protected-files.yml is absent or present with an unrelated entry", async () => {
    const protectedYml = path.join(projectRoot, ".rks", "protected-files.yml");
    for (const present of [false, true]) {
      writePolicy({ auto: [MARK_CMD] });
      fs.rmSync(path.join(projectRoot, "early.txt"), { force: true });
      if (present) {
        fs.mkdirSync(path.dirname(protectedYml), { recursive: true });
        fs.writeFileSync(protectedYml, 'protected:\n  - "package.json"\n');
      }
      expect(fs.existsSync(protectedYml)).toBe(present);
      const before = fs.readFileSync(POLICY_ABS(), "utf8");
      const res = await applyFixPlan({
        projectId,
        projectRoot,
        runDir: fixRunDir(),
        attemptNumber: 2,
        plan: { steps: [{ action: "create_file", path: "early.txt", content: "early\n" }, fixStep("create_file", ".routekit/command-policy.yaml")] },
      });
      expect(res.ok, `protected-files present=${present}`).toBe(false);
      expect(String(res.error)).toMatch(/command policy/i);
      expect(res.appliedFiles).toEqual([]);
      expect(fs.existsSync(path.join(projectRoot, "early.txt"))).toBe(false);
      expect(fs.readFileSync(POLICY_ABS(), "utf8")).toBe(before);
    }
  });

  it("[TR19] positive control: a fix plan writing docs/command-policy.yaml applies", async () => {
    const res = await applyFixPlan({
      projectId,
      projectRoot,
      runDir: fixRunDir(),
      attemptNumber: 2,
      plan: { steps: [{ action: "create_file", path: "docs/command-policy.yaml", content: "x: 1\n" }] },
    });
    expect(res.ok).toBe(true);
    expect(fs.existsSync(path.join(projectRoot, "docs", "command-policy.yaml"))).toBe(true);
  });
});
