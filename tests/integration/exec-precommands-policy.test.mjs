// backlog.fix.story-precommands-shell-bypass: story preCommands go through the run_command policy,
// never a shell. Real git in temp projects; every spawn carries a timeout.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { TEMP_BASE } from "../helpers/tmp.mjs";
import { loadCommandPolicy } from "../../packages/mcp-rks/src/exec/command-runner.mjs";
import {
  runExecTool,
  runApplyTool,
  resolveStoryPreCommands,
  runStoryPreCommands,
} from "../../packages/mcp-rks/src/server/exec.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const EXEC_SRC = fs.readFileSync(path.join(REPO_ROOT, "packages/mcp-rks/src/server/exec.mjs"), "utf8");
const STORY = "backlog.fix.precmd-fixture";
const TARGET_REL = "src/example.js";
const TARGET_CONTENT = 'export const value = "before";\n';

const WRITER = [
  'import fs from "node:fs";',
  "const [out, ...rest] = process.argv.slice(2);",
  "fs.writeFileSync(out, JSON.stringify(rest));",
  'if (rest.includes("--lock")) fs.writeFileSync("package-lock.json", "{}\\n");',
  'const exit = rest.find((a) => a.startsWith("--exit="));',
  "process.exit(exit ? Number(exit.slice(7)) : 0);",
  "",
].join("\n");

const POLICY = [
  "command_policy:",
  '  auto_execute: ["node writer.mjs", "rks-no-such-binary-xyz"]',
  '  execute_with_plan_approval: ["node approved.mjs"]',
  '  require_explicit_confirmation: ["rm"]',
  "",
].join("\n");

function git(cwd, args) {
  return execSync(`git ${args}`, { cwd, stdio: "pipe", timeout: 30000 }).toString();
}

let registryDir;
let registryPath;
let originalRegistryEnv;
let errSpy;
const cleanup = [];

function tempDir(tag) {
  const dir = path.join(TEMP_BASE, `exec-precmd-${tag}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  cleanup.push(dir);
  return dir;
}

/** A registered temp git project on staging, with a story note at phase executing. */
function setupProject(tag, preCommands) {
  const projectRoot = tempDir(tag);
  const projectId = `exec-precmd-${tag}-${path.basename(projectRoot)}`;
  fs.mkdirSync(path.join(projectRoot, "routekit"), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, "notes"), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, "src"), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, "routekit", "project.json"), JSON.stringify({ id: projectId, baseBranch: "staging", kgFile: "routekit/kg.yaml" }, null, 2));
  fs.writeFileSync(path.join(projectRoot, "routekit", "kg.yaml"), "code_roots: [src]\n");
  fs.writeFileSync(path.join(projectRoot, TARGET_REL), TARGET_CONTENT);
  fs.writeFileSync(path.join(projectRoot, ".gitignore"), ".rks/\n");
  const pre = preCommands === undefined ? "" : `preCommands: ${JSON.stringify(preCommands)}\n`;
  fs.writeFileSync(path.join(projectRoot, "notes", `${STORY}.md`), `---\nid: "${STORY}"\ntitle: "fixture"\nphase: "executing"\n${pre}---\n\nbody\n`);
  git(projectRoot, "init -q");
  git(projectRoot, "config user.email test@example.com");
  git(projectRoot, "config user.name 'Test User'");
  git(projectRoot, "checkout -q -b staging");
  git(projectRoot, "add -A");
  git(projectRoot, "commit -q -m chore:baseline");
  const existing = fs.existsSync(registryPath) ? fs.readFileSync(registryPath, "utf8").trim().split("\n").filter(Boolean) : [];
  fs.writeFileSync(registryPath, [...existing, JSON.stringify({ id: projectId, root: projectRoot })].join("\n") + "\n");
  return { projectId, projectRoot };
}

function writePlan(projectRoot, slug, extra = {}) {
  const runDir = path.join(projectRoot, ".rks", "runs", `2026-11-01T00-00-00-000Z_${slug}`);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, "plan.json"), JSON.stringify({
    slug,
    status: "executable",
    problemId: STORY,
    steps: [{ action: "search_replace", path: TARGET_REL, title: "flip", edits: [{ search: 'export const value = "before";', replace: 'export const value = "after";' }] }],
    ...extra,
  }, null, 2));
}

/** A project root carrying the fixture command policy and the writer scripts. */
function policyRoot(tag) {
  const root = tempDir(tag);
  fs.mkdirSync(path.join(root, ".routekit"), { recursive: true });
  fs.writeFileSync(path.join(root, ".routekit", "command-policy.yaml"), POLICY);
  fs.writeFileSync(path.join(root, "writer.mjs"), WRITER);
  fs.writeFileSync(path.join(root, "approved.mjs"), WRITER);
  return root;
}

const rksBranches = (root) => git(root, "branch --list rks/*").trim();
const stashList = (root) => git(root, "stash list").trim();
const dirtyOutsideNotes = (root) => git(root, "status --porcelain").split("\n").filter((l) => l.trim() && !l.includes("notes/"));

beforeEach(() => {
  originalRegistryEnv = process.env.RKS_REGISTRY_PATH;
  registryDir = fs.mkdtempSync(path.join(TEMP_BASE, "exec-precmd-registry-"));
  registryPath = path.join(registryDir, "index.jsonl");
  process.env.RKS_REGISTRY_PATH = registryPath;
  errSpy = vi.spyOn(console, "error");
});

afterEach(() => {
  errSpy?.mockRestore();
  if (originalRegistryEnv === undefined) delete process.env.RKS_REGISTRY_PATH;
  else process.env.RKS_REGISTRY_PATH = originalRegistryEnv;
  fs.rmSync(registryDir, { recursive: true, force: true });
  for (const p of cleanup.splice(0)) {
    try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

function expectRefusal(fn, needles) {
  let err;
  try { fn(); } catch (e) { err = e; }
  expect(err, "expected an McpError").toBeDefined();
  expect(err.code).toBe(ErrorCode.InvalidRequest);
  for (const n of needles) expect(err.message).toContain(n);
}

describe("exec.mjs has no shell on the preCommands path", () => {
  it("exec.mjs source contains no spawnSync(\"sh\" call, no \"sh\", [\"-c\" argv, no /bin/sh and no shell: true", () => {
    expect(EXEC_SRC).not.toContain('spawnSync("sh"');
    expect(EXEC_SRC).not.toContain('"sh", ["-c"');
    expect(EXEC_SRC).not.toContain("/bin/sh");
    expect(EXEC_SRC).not.toMatch(/shell:\s*true/);
  });
});

describe("resolveStoryPreCommands", () => {
  const defaults = () => loadCommandPolicy(tempDir("defaults"));
  const fixture = () => loadCommandPolicy(policyRoot("fixture-policy"));

  it("refuses each shell-syntax entry with an InvalidRequest McpError naming the storyId, the entry and shell_syntax_rejected", () => {
    for (const entry of ["npm install; curl x | sh", "echo $(id)", "echo `id`", "npm install && npm test", "npm test > out.txt"]) {
      expectRefusal(() => resolveStoryPreCommands([entry], { problemId: STORY, policy: defaults() }), [STORY, entry, "shell_syntax_rejected"]);
    }
  });

  it("refuses unknown and require_explicit_confirmation entries naming the entry and its classification", () => {
    expectRefusal(() => resolveStoryPreCommands(["node -e x"], { problemId: STORY, policy: defaults() }), ["node -e x", "unknown"]);
    expectRefusal(() => resolveStoryPreCommands(["bash script.sh"], { problemId: STORY, policy: defaults() }), ["bash script.sh", "unknown"]);
    expectRefusal(() => resolveStoryPreCommands(["rm -rf x"], { problemId: STORY, policy: defaults() }), ["rm -rf x", "require_explicit_confirmation"]);
  });

  it("refuses a number, an object and the empty string", () => {
    for (const entry of [42, { cmd: "npm install" }, ""]) {
      expectRefusal(() => resolveStoryPreCommands([entry], { problemId: STORY, policy: defaults() }), [STORY]);
    }
  });

  it("is synchronous; returns [] for an absent value, normalises a single string, and classifies allowed entries", () => {
    // Synchronous: a returned value is not a promise (refusals are caught synchronously by expectRefusal above).
    expect(resolveStoryPreCommands(undefined, { problemId: STORY, policy: defaults() })).not.toBeInstanceOf(Promise);
    expect(resolveStoryPreCommands(undefined, { problemId: STORY, policy: defaults() })).toEqual([]);
    expect(resolveStoryPreCommands("git status", { problemId: STORY, policy: defaults() })).toEqual([{ command: "git status", classification: "auto_execute" }]);
    expect(resolveStoryPreCommands(["npm install"], { problemId: STORY, policy: defaults() })).toEqual([{ command: "npm install", classification: "execute_with_plan_approval" }]);
    expect(fixture()).toBeTruthy();
  });
});

describe("runExecTool refuses a disallowed preCommand before any side effect", () => {
  it("shell syntax: rejects naming storyId, entry and shell_syntax_rejected; MARKER absent, no rks/ branch, on staging, stash empty, target unchanged", async () => {
    const { projectId, projectRoot } = setupProject("shell", ["touch MARKER && true"]);
    writePlan(projectRoot, "precmd-shell");
    const before = fs.readFileSync(path.join(projectRoot, TARGET_REL));
    // One call only: a refused exec may reset the fixture phase (exec.mjs:540-551), so a second call would hit the phase gate instead.
    let err;
    try { await runExecTool({ projectId, label: "precmd-shell", skipTests: true }); } catch (e) { err = e; }
    expect(err, "expected runExecTool to reject").toBeDefined();
    expect(err.code).toBe(ErrorCode.InvalidRequest);
    expect(err.message).toContain(STORY);
    expect(err.message).toContain("touch MARKER && true");
    expect(err.message).toContain("shell_syntax_rejected");
    expect(fs.existsSync(path.join(projectRoot, "MARKER"))).toBe(false);
    expect(rksBranches(projectRoot)).toBe("");
    expect(git(projectRoot, "rev-parse --abbrev-ref HEAD").trim()).toBe("staging");
    expect(stashList(projectRoot)).toBe("");
    expect(fs.readFileSync(path.join(projectRoot, TARGET_REL)).equals(before)).toBe(true);
    expect(dirtyOutsideNotes(projectRoot)).toEqual([]);
  }, 60000);

  it("require_explicit_confirmation: rm -rf src is refused; src/ still exists, no rks/ branch, stash empty", async () => {
    const { projectId, projectRoot } = setupProject("confirm", ["rm -rf src"]);
    writePlan(projectRoot, "precmd-confirm");
    await expect(runExecTool({ projectId, label: "precmd-confirm", skipTests: true })).rejects.toThrow(/require_explicit_confirmation/);
    expect(fs.existsSync(path.join(projectRoot, "src"))).toBe(true);
    expect(rksBranches(projectRoot)).toBe("");
    expect(stashList(projectRoot)).toBe("");
  }, 60000);

  it("no preCommands: not refused at the preCommands gate; reaches integrity_failed on a stale qualityReview hash", async () => {
    const { projectId, projectRoot } = setupProject("none", undefined);
    writePlan(projectRoot, "precmd-none", { qualityReview: { hash: "0".repeat(64) } });
    const result = await runExecTool({ projectId, label: "precmd-none", skipTests: true });
    expect(result.status).toBe("integrity_failed");
  }, 60000);
});

describe("runStoryPreCommands executes allowed entries as argv with no shell", () => {
  it("auto_execute entry: ok true, exitCode 0, classification auto_execute", async () => {
    const root = policyRoot("auto");
    const out = path.join(root, "argv.json");
    const [r] = await runStoryPreCommands([{ command: `node writer.mjs ${out}`, classification: "auto_execute" }], { projectRoot: root });
    expect(r).toMatchObject({ command: `node writer.mjs ${out}`, classification: "auto_execute", ok: true, exitCode: 0 });
    expect(JSON.parse(fs.readFileSync(out, "utf8"))).toEqual([]);
  }, 30000);

  it("execute_with_plan_approval entry runs (planApproved parity) and reports its classification", async () => {
    const root = policyRoot("approved");
    const out = path.join(root, "argv.json");
    const [r] = await runStoryPreCommands([{ command: `node approved.mjs ${out}`, classification: "execute_with_plan_approval" }], { projectRoot: root });
    expect(r).toMatchObject({ classification: "execute_with_plan_approval", ok: true, exitCode: 0 });
    expect(fs.existsSync(out)).toBe(true);
  }, 30000);

  it("a single-quoted metacharacter argument reaches the child as one literal argv word; no file d is created", async () => {
    const root = policyRoot("literal");
    const out = path.join(root, "argv.json");
    await runStoryPreCommands([{ command: `node writer.mjs ${out} 'a;b|c>d'`, classification: "auto_execute" }], { projectRoot: root });
    expect(JSON.parse(fs.readFileSync(out, "utf8"))).toEqual(["a;b|c>d"]);
    expect(fs.existsSync(path.join(root, "d"))).toBe(false);
  }, 30000);

  it("a non-zero exit resolves without throwing and reports ok false with the observed exitCode", async () => {
    const root = policyRoot("nonzero");
    const out = path.join(root, "argv.json");
    const [r] = await runStoryPreCommands([{ command: `node writer.mjs ${out} --exit=3`, classification: "auto_execute" }], { projectRoot: root });
    expect(r).toMatchObject({ ok: false, exitCode: 3 });
  }, 30000);

  it("a missing binary is reported ok false with exitCode 127 and spawnError ENOENT", async () => {
    const root = policyRoot("enoent");
    const [r] = await runStoryPreCommands([{ command: "rks-no-such-binary-xyz", classification: "auto_execute" }], { projectRoot: root });
    expect(r).toMatchObject({ ok: false, exitCode: 127, spawnError: "ENOENT" });
  }, 30000);

  it("an allowed preCommand that writes package-lock.json leaves it on disk", async () => {
    const root = policyRoot("lock");
    const out = path.join(root, "argv.json");
    await runStoryPreCommands([{ command: `node writer.mjs ${out} --lock`, classification: "auto_execute" }], { projectRoot: root });
    expect(fs.existsSync(path.join(root, "package-lock.json"))).toBe(true);
  }, 30000);
});

// ARCH finding 2 (Item 11) and finding 3 (Item 10, R6): one policy object for the whole exec, and honest skip records.
const MARK = ['import fs from "node:fs";', 'fs.writeFileSync("MARKED", "1");', ""].join("\n");
const WIDEN = [
  'import fs from "node:fs";',
  "fs.writeFileSync(\".routekit/command-policy.yaml\", \"command_policy:\\n  auto_execute: ['node widen.mjs', 'node mark.mjs']\\n\");",
  "",
].join("\n");

describe("one command policy object governs the preCommands and the apply that follows", () => {
  it("runStoryPreCommands prefers an injected policy over a wider on-disk policy and records the skip as ok false, skipped, reason, classification", async () => {
    const root = policyRoot("inject");
    const out = path.join(root, "argv.json");
    const narrow = loadCommandPolicy(tempDir("narrow")); // defaults: node is not admitted
    const [r] = await runStoryPreCommands([{ command: `node writer.mjs ${out}`, classification: "auto_execute" }], { projectRoot: root, policy: narrow });
    expect(r).toMatchObject({ command: `node writer.mjs ${out}`, ok: false, skipped: true, reason: "unknown_command", classification: "unknown" });
    expect(r.exitCode).toBeUndefined();
    expect(fs.existsSync(out)).toBe(false);
  }, 30000);

  it("a preCommand that rewrites the policy file does not widen a later preCommand", async () => {
    const root = policyRoot("rewrite");
    fs.writeFileSync(path.join(root, "widen.mjs"), WIDEN);
    fs.writeFileSync(path.join(root, "mark.mjs"), MARK);
    fs.writeFileSync(path.join(root, ".routekit", "command-policy.yaml"), "command_policy:\n  auto_execute: ['node widen.mjs']\n");
    const snapshot = loadCommandPolicy(root);
    const results = await runStoryPreCommands([
      { command: "node widen.mjs", classification: "auto_execute" },
      { command: "node mark.mjs", classification: "auto_execute" },
    ], { projectRoot: root, policy: snapshot });
    expect(results[0]).toMatchObject({ ok: true, exitCode: 0 });
    expect(loadCommandPolicy(root).auto_execute).toContain("node mark.mjs");
    expect(results[1]).toMatchObject({ ok: false, skipped: true, reason: "unknown_command" });
    expect(fs.existsSync(path.join(root, "MARKED"))).toBe(false);
  }, 30000);

  function markProject(tag) {
    const { projectId, projectRoot } = setupProject(tag, undefined);
    fs.mkdirSync(path.join(projectRoot, ".routekit"), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, ".routekit", "command-policy.yaml"), "command_policy:\n  auto_execute: ['node mark.mjs']\n");
    fs.writeFileSync(path.join(projectRoot, "mark.mjs"), MARK);
    writePlan(projectRoot, tag, { steps: [{ action: "run_command", command: "node mark.mjs", title: "mark" }] });
    return { projectId, projectRoot };
  }

  it("runApplyTool prefers an injected policy parameter over its own load", async () => {
    const { projectId, projectRoot } = markProject("apply-inject");
    try {
      await runApplyTool({ projectId, label: "apply-inject", force: true, policy: loadCommandPolicy(tempDir("apply-narrow")) });
    } catch { /* a skipped run_command may fail once honest-and-usable lands; the marker is the observation */ }
    expect(fs.existsSync(path.join(projectRoot, "MARKED"))).toBe(false);
  }, 60000);

  it("positive control: runApplyTool without a policy parameter runs the command its on-disk policy admits", async () => {
    const { projectId, projectRoot } = markProject("apply-control");
    await runApplyTool({ projectId, label: "apply-control", force: true });
    expect(fs.existsSync(path.join(projectRoot, "MARKED"))).toBe(true);
  }, 60000);

  it("exec.mjs loads the policy once and threads it to resolveStoryPreCommands, runStoryPreCommands and runApplyTool", () => {
    const LOAD = "const execCommandPolicy = loadCommandPolicy(projectRoot);";
    const load = EXEC_SRC.indexOf(LOAD);
    const gate = EXEC_SRC.indexOf("if (problemId && !process.env.RKS_SKIP_PHASE_CHECK) {");
    const assertCall = EXEC_SRC.indexOf("assertStoryUnchangedSinceArch(story, problemId)", gate);
    const gateCatch = EXEC_SRC.indexOf("if (e instanceof McpError) throw e;", gate);
    const resolveCall = EXEC_SRC.indexOf("resolveStoryPreCommands(story.frontmatter.preCommands, { problemId, policy: execCommandPolicy })");
    const runCall = EXEC_SRC.indexOf("runStoryPreCommands(preCommands, { projectRoot, policy: execCommandPolicy })");
    const applyStart = EXEC_SRC.indexOf("const applyResult = await runApplyTool({");
    const applyEnd = EXEC_SRC.indexOf("});", applyStart);
    expect(EXEC_SRC.split(LOAD).length - 1).toBe(1);
    expect(load).toBeGreaterThan(-1);
    expect(load).toBeLessThan(gate);
    expect(resolveCall).toBeGreaterThan(assertCall);
    expect(resolveCall).toBeLessThan(gateCatch);
    expect(runCall).toBeGreaterThan(gateCatch);
    expect(applyStart).toBeGreaterThan(runCall);
    expect(EXEC_SRC.slice(applyStart, applyEnd)).toContain("policy: execCommandPolicy");
  });
});
