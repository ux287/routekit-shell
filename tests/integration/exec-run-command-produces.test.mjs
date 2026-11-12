/**
 * backlog.fix.run-command-honest-and-usable — Defect B, mock tier (no ".workflow." infix).
 *
 * A run_command step declares the files it generates with `produces: [...]`. ONE derivation
 * (planDeclaredOutputs in server/test-runner.mjs) feeds BOTH consumers:
 *   - the scope rule computeUnexpectedFiles (shared by the final guard and detectPerStepDivergence);
 *   - exec's pure commit-set rule computeCommitFiles (what `git add` stages and execCommitFiles commits).
 *
 * Guard and commit halves are asserted in SEPARATE it() blocks that fail independently, plus one
 * exempt-implies-committed invariant over a single shared steps fixture. Only loadContext in
 * server/project.mjs is mocked (so the live projects/index.jsonl is never touched), plus exec's
 * post-commit auto-embed collaborator (embedScopedFiles in @routekit/rag); exec.mjs, test-runner.mjs,
 * command-runner.mjs and planner.mjs are the real modules.
 *
 * TR29 second half, recorded rather than asserted (UN-REDDABLE): the duplicate validateStep in
 * server/planner-note-steps.mjs is module-local (not exported), and its only run_command producer
 * builds a fresh { action, command, cwd } object from note markdown, which can never carry `produces`.
 * No mutation of that copy can turn a test red, so none is written for it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ensureTelemetryStorage } from "@routekit/telemetry";
import { makeTempDir } from "../helpers/tmp.mjs";

const h = vi.hoisted(() => ({ root: null }));
vi.mock("../../packages/mcp-rks/src/server/project.mjs", async (importOriginal) => ({
  ...(await importOriginal()),
  loadContext: vi.fn(async (projectId) => ({ record: { id: projectId, root: h.root }, projectJson: { baseBranch: "staging" } })),
}));

// Collaborator stub: exec's post-commit auto-embed would load an embedding model; it is not under test.
vi.mock("@routekit/rag", async (importOriginal) => ({
  ...(await importOriginal()),
  embedScopedFiles: vi.fn(async () => ({ ok: true, filesEmbedded: 0 })),
}));

const {
  computeUnexpectedFiles,
  detectPerStepDivergence,
  planDeclaredOutputs,
} = await import("../../packages/mcp-rks/src/server/test-runner.mjs");
const { computeCommitFiles, runApplyTool, runExecTool } = await import("../../packages/mcp-rks/src/server/exec.mjs");
const { handleRunCommandStep } = await import("../../packages/mcp-rks/src/exec/command-runner.mjs");
const { getUncommittedFiles } = await import("../../packages/mcp-rks/src/utils/git.mjs");
const { validateStep } = await import("../../packages/mcp-rks/src/server/planner.mjs");

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const EXEC_SRC = fs.readFileSync(path.join(REPO_ROOT, "packages/mcp-rks/src/server/exec.mjs"), "utf8");

const GIT_TIMEOUT = 15_000;
const git = (cwd, args) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout: GIT_TIMEOUT });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
};
const expectedFrom = (steps) => new Set(steps.map((s) => s.target || s.path).filter(Boolean));

const STEPS = [{ action: "run_command", command: "node tools/build.mjs", produces: ["dist/app.js"] }];
const REGEN = 'import fs from "node:fs";\nfs.writeFileSync("dist/app.js", "// regenerated " + Date.now() + "\\n");\n';

/** A temp git repo on staging with a committed baseline holding src/a.js, dist/app.js, the policy and regen.mjs. */
function makeRepo() {
  const root = makeTempDir("rc-produces");
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "dist"), { recursive: true });
  fs.mkdirSync(path.join(root, ".routekit"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "a.js"), "export const a = 1;\n");
  fs.writeFileSync(path.join(root, "dist", "app.js"), "// baseline\n");
  fs.writeFileSync(path.join(root, "regen.mjs"), REGEN);
  fs.writeFileSync(path.join(root, ".routekit", "command-policy.yaml"), 'command_policy:\n  auto_execute: ["node regen.mjs"]\n');
  fs.writeFileSync(path.join(root, ".gitignore"), ".rks/\n");
  git(root, ["init", "-q", "-b", "staging"]);
  git(root, ["config", "user.email", "t@t"]);
  git(root, ["config", "user.name", "t"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "baseline"]);
  return root;
}

function writePlan(root, label, steps) {
  const runDir = path.join(root, ".rks", "runs", `2026-11-04T00-00-00-000Z_${label}`);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, "plan.json"), JSON.stringify({ slug: label, status: "executable", steps }, null, 2));
  fs.writeFileSync(path.join(runDir, "run.json"), JSON.stringify({ projectId: "rc-produces", timestamps: {}, telemetry: { outcome: "planned" } }));
  return runDir;
}

const cleanup = [];
beforeEach(() => { h.root = null; });
afterEach(() => {
  for (const p of cleanup.splice(0)) fs.rmSync(p, { recursive: true, force: true });
});

describe("TR16/TR18/TR19/TR20: the guard exempts exactly what was declared", () => {
  it("TR16: computeUnexpectedFiles exempts a declared output (no commit or staging assertion here)", () => {
    expect(computeUnexpectedFiles({ steps: STEPS, modifiedFiles: ["dist/app.js"], expectedFiles: new Set() })).toEqual([]);
  });

  it("TR18: an undeclared file the command wrote still trips the guard", () => {
    expect(
      computeUnexpectedFiles({ steps: STEPS, modifiedFiles: ["dist/app.js", "dist/rogue.js"], expectedFiles: new Set() }),
    ).toEqual(["dist/rogue.js"]);
  });

  it("TR18: './dist/app.js' exempts the porcelain path; an absolute path exempts nothing", () => {
    const dotted = [{ action: "run_command", command: "node tools/build.mjs", produces: ["./dist/app.js"] }];
    expect(computeUnexpectedFiles({ steps: dotted, modifiedFiles: ["dist/app.js"], expectedFiles: new Set() })).toEqual([]);
    const absolute = [{ action: "run_command", command: "node tools/build.mjs", produces: ["/dist/app.js"] }];
    expect(computeUnexpectedFiles({ steps: absolute, modifiedFiles: ["dist/app.js"], expectedFiles: new Set() })).toEqual(["dist/app.js"]);
    expect([...planDeclaredOutputs(absolute)]).toEqual([]);
  });

  it("TR19: the exemption keys on the declaration, not the filename", () => {
    const noProduces = [{ action: "run_command", command: "node tools/build.mjs" }];
    expect(computeUnexpectedFiles({ steps: noProduces, modifiedFiles: ["dist/app.js"], expectedFiles: new Set() })).toEqual(["dist/app.js"]);
    const noRunCommand = [{ action: "edit_file", path: "src/a.js", content: "x" }];
    expect(computeUnexpectedFiles({ steps: noRunCommand, modifiedFiles: ["dist/app.js"], expectedFiles: new Set(["src/a.js"]) })).toEqual(["dist/app.js"]);
    // produces on a non-run_command step is not a declaration either.
    const wrongAction = [{ action: "edit_file", path: "src/a.js", content: "x", produces: ["dist/app.js"] }];
    expect(computeUnexpectedFiles({ steps: wrongAction, modifiedFiles: ["dist/app.js"], expectedFiles: new Set(["src/a.js"]) })).toEqual(["dist/app.js"]);
  });

  it("TR20: the existing exemptions are untouched and still narrow", () => {
    const base = { steps: [], expectedFiles: new Set() };
    expect(computeUnexpectedFiles({ ...base, modifiedFiles: ["notes/x.md"], scopeExemptions: new Set(["notes/x.md"]) })).toEqual([]);
    expect(computeUnexpectedFiles({ ...base, modifiedFiles: [".rks/a", ".routekit/b"] })).toEqual([]);
    expect(computeUnexpectedFiles({ ...base, modifiedFiles: ["gen.lock"], preCommandGeneratedFiles: new Set(["gen.lock"]) })).toEqual([]);
    // dependency-add exemption: only when the plan declares a dep-add step, and only the manifests.
    expect(computeUnexpectedFiles({ ...base, modifiedFiles: ["package.json"] })).toEqual(["package.json"]);
    const depAdd = [{ action: "run_command", command: "npm install left-pad" }];
    expect(computeUnexpectedFiles({ steps: depAdd, expectedFiles: new Set(), modifiedFiles: ["package.json", "package-lock.json", "src/x.js"] })).toEqual(["src/x.js"]);
    // a produces declaration does not widen into the manifest exemption.
    expect(computeUnexpectedFiles({ steps: STEPS, expectedFiles: new Set(), modifiedFiles: ["package.json"] })).toEqual(["package.json"]);
  });
});

describe("TR17/TR26: the per-step guard over a real dirty tree", () => {
  it("TR17: detectPerStepDivergence returns diverged:false when the command actually wrote the declared output", async () => {
    const root = makeRepo();
    cleanup.push(root);
    const r = await handleRunCommandStep("node regen.mjs", { projectRoot: root, planApproved: true, timeout: 30_000 });
    expect(r.executed).toBe(true);
    expect(getUncommittedFiles(root)).toContain("dist/app.js");
    const steps = [{ action: "run_command", command: "node regen.mjs", produces: ["dist/app.js"] }];
    expect(detectPerStepDivergence(root, expectedFrom(steps), new Set(), steps)).toEqual({ diverged: false });
  }, 60_000);

  it("TR26: the final guard and the per-step guard agree, for a declaring and a non-declaring plan", async () => {
    const root = makeRepo();
    cleanup.push(root);
    await handleRunCommandStep("node regen.mjs", { projectRoot: root, planApproved: true, timeout: 30_000 });
    fs.writeFileSync(path.join(root, "src", "a.js"), "export const a = 2;\n");
    const plans = [
      [{ action: "edit_file", path: "src/a.js", content: "x" }, { action: "run_command", command: "node regen.mjs", produces: ["dist/app.js"] }],
      [{ action: "edit_file", path: "src/a.js", content: "x" }, { action: "run_command", command: "node regen.mjs" }],
    ];
    const verdicts = [];
    for (const steps of plans) {
      const expectedFiles = expectedFrom(steps);
      // As the final guard calls it: modifiedFiles from the working tree, steps passed by name.
      const finalUnexpected = computeUnexpectedFiles({ steps, modifiedFiles: getUncommittedFiles(root), expectedFiles });
      // As runApplyTool calls it: expected set, preCommand set, then plan steps positionally.
      const perStep = detectPerStepDivergence(root, expectedFiles, new Set(), steps);
      expect(perStep.diverged).toBe(finalUnexpected.length > 0);
      expect(perStep.unexpectedFiles ?? []).toEqual(finalUnexpected);
      verdicts.push(perStep.diverged);
    }
    // The pair is only meaningful if the declaration actually decides the verdict.
    expect(verdicts).toEqual([false, true]);
  }, 60_000);
});

describe("TR22/TR23: declared outputs reach the commit set", () => {
  it("TR22: computeCommitFiles includes a declared output (no guard assertion here)", () => {
    const committed = computeCommitFiles({ appliedFiles: ["src/a.js"], installDerived: new Set(), steps: STEPS });
    expect(committed).toContain("dist/app.js");
    expect(committed).toContain("src/a.js");
  });

  it("TR23 (structural, anti-vacuity): exec assigns commitFiles from computeCommitFiles with plan steps; no inline literal remains", () => {
    expect(EXEC_SRC).not.toContain("[...new Set([...appliedFiles, ...installDerived])]");
    const line = EXEC_SRC.split("\n").find((l) => l.includes("const commitFiles ="));
    expect(line).toBeDefined();
    expect(line).toMatch(/const commitFiles = computeCommitFiles\(\{[^}]*\bsteps:\s*plan\.steps/);
    expect(EXEC_SRC.split("const commitFiles =").length - 1).toBe(1);
  });
});

describe("TR24: exempt implies committed", () => {
  it("every path the guard exempts on account of produces is in computeCommitFiles' result (one shared fixture)", () => {
    const steps = [
      { action: "edit_file", path: "src/a.js", content: "x" },
      { action: "run_command", command: "node tools/build.mjs", produces: ["dist/app.js", "./dist/app.css", "/etc/abs"] },
      { action: "run_command", command: "node tools/other.mjs", produces: ["gen/types.d.ts"] },
    ];
    const candidates = ["dist/app.js", "dist/app.css", "gen/types.d.ts", "etc/abs", "dist/rogue.js"];
    const withDecl = computeUnexpectedFiles({ steps, modifiedFiles: candidates, expectedFiles: new Set() });
    const withoutDecl = computeUnexpectedFiles({
      steps: steps.map(({ produces, ...rest }) => rest),
      modifiedFiles: candidates,
      expectedFiles: new Set(),
    });
    const exemptByProduces = withoutDecl.filter((f) => !withDecl.includes(f));
    expect(exemptByProduces.length).toBeGreaterThan(0);
    const committed = new Set(computeCommitFiles({ appliedFiles: ["src/a.js"], installDerived: new Set(), steps }));
    for (const f of exemptByProduces) expect(committed.has(f), f).toBe(true);
  });
});

describe("TR29: produces survives plan validation", () => {
  it("validateStep returns the same run_command object, still carrying produces", () => {
    const step = { action: "run_command", command: "node tools/build.mjs", path: null, produces: ["dist/app.js"] };
    const out = validateStep(step);
    expect(out).toBe(step);
    expect(out._invalid).toBeUndefined();
    expect(out.produces).toEqual(["dist/app.js"]);
  });
});

describe("TR27: exec.guardrails_off reports declared outputs; the Layer D input does not take them", () => {
  it("(a) the exec.guardrails_off event's targetFiles, read off the collector, include the declared outputs", async () => {
    const root = makeRepo();
    cleanup.push(root);
    h.root = root;
    const steps = [
      { action: "edit_file", path: "src/a.js", content: "export const a = 2;\n", title: "edit a" },
      { action: "run_command", command: "node regen.mjs", produces: ["dist/app.js"], title: "regen" },
    ];
    writePlan(root, "produces-off", steps);
    const collector = ensureTelemetryStorage(root);
    collector.emit.mockClear();
    try {
      await runExecTool({ projectId: "rc-produces", label: "produces-off", skipTests: true });
    } catch { /* the exec outcome is not the observation; the guardrails_off event is */ }
    const offEvents = collector.emit.mock.calls.filter((c) => c[0] === "exec.guardrails_off");
    expect(offEvents.length).toBeGreaterThan(0);
    const targetFiles = offEvents[0][2].targetFiles;
    expect(targetFiles).toContain("src/a.js");
    expect(targetFiles).toContain("dist/app.js");
  }, 120_000);

  it("(b) structural: the Layer D input is the plan-target list alone, which never takes the declared outputs", () => {
    const defLine = EXEC_SRC.split("\n").find((l) => l.includes("const planTargetFilesForScope ="));
    expect(defLine).toBeDefined();
    expect(defLine).not.toContain("planDeclaredOutputs");
    expect(EXEC_SRC).toContain("planTargetFilesForScope.filter(f => LAYER_D_TEST_FILE_PATTERN.test(f))");
    // The union lives at the telemetry payload only.
    expect(EXEC_SRC).toMatch(/targetFiles: \[\.\.\.new Set\(\[\.\.\.planTargetFilesForScope, \.\.\.planDeclaredOutputs\(/);
  });
});

describe("TR46: end to end, composed at mock-tier depth", () => {
  it("edit a source file, regenerate a committed artifact: apply succeeds, the guard passes, the commit set holds both", async () => {
    const root = makeRepo();
    cleanup.push(root);
    h.root = root;
    const before = fs.readFileSync(path.join(root, "dist", "app.js"), "utf8");
    const steps = [
      { action: "edit_file", path: "src/a.js", content: "export const a = 2;\n" },
      { action: "run_command", command: "node regen.mjs", produces: ["dist/app.js"] },
    ];
    writePlan(root, "produces-e2e", steps);
    const res = await runApplyTool({ projectId: "rc-produces", label: "produces-e2e", force: true });
    expect(res.ok).toBe(true);
    expect(res).not.toHaveProperty("nonExecutedCommands");
    expect(fs.readFileSync(path.join(root, "dist", "app.js"), "utf8")).not.toBe(before);

    const modified = getUncommittedFiles(root);
    expect(modified).toEqual(expect.arrayContaining(["src/a.js", "dist/app.js"]));
    expect(computeUnexpectedFiles({ steps, modifiedFiles: modified, expectedFiles: expectedFrom(steps) })).toEqual([]);

    const committed = computeCommitFiles({ appliedFiles: res.appliedFiles, installDerived: new Set(), steps });
    expect(committed).toContain("src/a.js");
    expect(committed).toContain("dist/app.js");
  }, 120_000);

  it("driven through runExecTool to the commit: the regenerated artifact is in the committed tree", async () => {
    const root = makeRepo();
    cleanup.push(root);
    h.root = root;
    const baseline = git(root, ["rev-parse", "HEAD"]).trim();
    const steps = [
      { action: "edit_file", path: "src/a.js", content: "export const a = 2;\n", title: "edit a" },
      { action: "run_command", command: "node regen.mjs", produces: ["dist/app.js"], title: "regen" },
    ];
    writePlan(root, "produces-commit", steps);
    const result = await runExecTool({ projectId: "rc-produces", label: "produces-commit", skipTests: true });
    expect(result?.ok, JSON.stringify(result)).toBe(true);
    const newCommits = git(root, ["rev-list", "--all", `^${baseline}`]).split("\n").filter(Boolean);
    expect(newCommits.length).toBeGreaterThan(0);
    const committedPaths = new Set(
      newCommits.flatMap((sha) => git(root, ["show", "--name-only", "--format=", sha]).split("\n").filter(Boolean)),
    );
    expect(committedPaths.has("src/a.js")).toBe(true);
    expect(committedPaths.has("dist/app.js")).toBe(true);
    // Nothing the plan declared is left dirty for ship's preflight to refuse.
    expect(getUncommittedFiles(root).filter((f) => f === "dist/app.js" || f === "src/a.js")).toEqual([]);
  }, 120_000);
});
