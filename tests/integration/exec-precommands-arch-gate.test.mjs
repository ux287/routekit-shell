// backlog.fix.precommands-arch-digest-binding: rks_exec runs story preCommands only under a gated, unchanged ARCH approval.
// Fixture pattern: tests/integration/exec-precommands-policy.test.mjs (setupProject, writePlan, rksBranches, stashList),
// extended so the story note can carry arch_verdict, arch_subject (noteSubjectDigest) and arch_subject_version.
// Collaborators mocked as in tests/integration/exec-command-policy-integrity.test.mjs: loadContext (so the live
// projects/index.jsonl is never read or written), embedScopedFiles, generateFixPlan, runRefineTool and
// guardrailsOff/guardrailsOn. Every git/subprocess call carries an explicit timeout (spawnSync timeout:; the
// preCommand itself runs through handleRunCommandStep with exec's 120 s preCommand timeout).
//
// testRequirement -> test mapping (TRn = the story's nth testRequirement):
//   TR13 "approved versioned story with a preCommand added after approval: story_changed_since_arch, nothing runs"
//   TR14 "unapproved story with an allowed preCommand: InvalidRequest naming the storyId and the observed verdict"
//   TR15 "approved with arch_subject absent and an allowed preCommand: refusal reports arch_verdict approved and arch_subject absent"
//   TR16 "unversioned approval with an allowed preCommand: InvalidRequest naming arch_subject_unversioned"
//   TR17 "the three ungated refusal messages differ and each is built from observed values"
//   TR18 "unapproved story with a single-string allowed preCommand: refused by the approval gate, nothing runs"
//   TR19 "unchanged versioned approval: the allowed preCommand runs"
//   TR20 "disallowed entries keep their classification refusal on unapproved and unchanged-approved stories"
//   TR21 "no preCommands: unapproved and unversioned stories are not refused by the approval gate"
//   TR22 "preCommands []: an unapproved story is not refused by the approval gate"
//   TR26 every spawn in this file carries an explicit timeout.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const h = vi.hoisted(() => ({ root: null }));

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

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { TEMP_BASE } from "../helpers/tmp.mjs";
import { parseFrontmatter } from "../../packages/mcp-rks/src/shared/frontmatter.mjs";
import { noteSubjectDigest, ARCH_SUBJECT_VERSION } from "../../packages/mcp-rks/src/workflow/arch-verdict.mjs";

const { runExecTool } = await import("../../packages/mcp-rks/src/server/exec.mjs");

const STORY = "backlog.fix.precmd-arch-gate-fixture";
const GATE = "preCommands_require_gated_arch_approval";
const TARGET_REL = "src/example.js";
const TARGET_CONTENT = 'export const value = "before";\n';
const MARKER_REL = "marker.json";
const ALLOWED = `node writer.mjs ${MARKER_REL} alpha beta`;

const WRITER = [
  'import fs from "node:fs";',
  "const [out, ...rest] = process.argv.slice(2);",
  "fs.writeFileSync(out, JSON.stringify(rest));",
  "",
].join("\n");

const POLICY = [
  "command_policy:",
  '  auto_execute: ["node writer.mjs"]',
  '  require_explicit_confirmation: ["rm"]',
  "",
].join("\n");

const GIT_TIMEOUT = 15_000;
const git = (cwd, args) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout: GIT_TIMEOUT });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
};

const cleanup = [];
let errSpy;

/** The story note text. `extra` is appended to the frontmatter verbatim. */
function noteText(preCommands, extra = "") {
  const pre = preCommands === undefined ? "" : `preCommands: ${JSON.stringify(preCommands)}\n`;
  return `---\nid: "${STORY}"\ntitle: "fixture"\nphase: "executing"\n${pre}${extra}---\n\nbody\n`;
}

/**
 * ARCH frontmatter for an approval state:
 *   none        no arch_* fields
 *   noSubject   arch_verdict approved, no arch_subject
 *   unversioned arch_verdict approved, arch_subject over the current note, no arch_subject_version
 *   versioned   arch_verdict approved, arch_subject over the current note (incl. preCommands), version 2
 *   amended     arch_verdict approved, arch_subject over the note WITHOUT preCommands, version 2
 */
function archLines(approval, preCommands) {
  const current = noteSubjectDigest(parseFrontmatter(noteText(preCommands)));
  const original = noteSubjectDigest(parseFrontmatter(noteText(undefined)));
  switch (approval) {
    case "none": return "";
    case "noSubject": return 'arch_verdict: "approved"\n';
    case "unversioned": return `arch_verdict: "approved"\narch_subject: "${current}"\n`;
    case "versioned": return `arch_verdict: "approved"\narch_subject: "${current}"\narch_subject_version: "${ARCH_SUBJECT_VERSION}"\n`;
    case "amended": return `arch_verdict: "approved"\narch_subject: "${original}"\narch_subject_version: "${ARCH_SUBJECT_VERSION}"\n`;
    default: throw new Error(`unknown approval ${approval}`);
  }
}

/** A temp git project on staging with the fixture policy, the writer script and the story note committed. */
function setupProject(tag, { preCommands, approval = "none" } = {}) {
  const root = path.join(TEMP_BASE, `exec-precmd-arch-${tag}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  cleanup.push(root);
  fs.mkdirSync(path.join(root, ".routekit"), { recursive: true });
  fs.mkdirSync(path.join(root, "notes"), { recursive: true });
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, ".routekit", "command-policy.yaml"), POLICY);
  fs.writeFileSync(path.join(root, "writer.mjs"), WRITER);
  fs.writeFileSync(path.join(root, TARGET_REL), TARGET_CONTENT);
  fs.writeFileSync(path.join(root, ".gitignore"), ".rks/\n");
  fs.writeFileSync(path.join(root, "notes", `${STORY}.md`), noteText(preCommands, archLines(approval, preCommands)));
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

function writePlan(root, label, extra = {}) {
  const runDir = path.join(root, ".rks", "runs", `2026-11-04T00-00-00-000Z_${label}`);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, "plan.json"), JSON.stringify({
    slug: label,
    status: "executable",
    problemId: STORY,
    steps: [{ action: "search_replace", path: TARGET_REL, title: "flip", edits: [{ search: 'export const value = "before";', replace: 'export const value = "after";' }] }],
    ...extra,
  }, null, 2));
  fs.writeFileSync(path.join(runDir, "run.json"), JSON.stringify({ projectId: "precmd-arch", timestamps: {}, telemetry: { outcome: "planned" } }));
  return label;
}

const rksBranches = (root) => git(root, ["branch", "--list", "rks/*"]).trim();
const stashList = (root) => git(root, ["stash", "list"]).trim();
const currentBranch = (root) => git(root, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
const markerExists = (root) => fs.existsSync(path.join(root, MARKER_REL));

/** One runExecTool call (a refused exec may reset the fixture phase, so never a second). */
async function execOnce(label, extra = {}) {
  let result;
  let err;
  try {
    result = await runExecTool({ projectId: "precmd-arch", label, skipTests: true, ...extra });
  } catch (e) {
    err = e;
  }
  return { result, err };
}

/** Text of the result or the thrown error, for a "does not contain" check over both. */
const outcomeText = ({ result, err }) => `${err ? `${err.message}` : ""}${result ? JSON.stringify(result) : ""}`;

function expectGateRefusal(err) {
  expect(err, "expected runExecTool to reject").toBeDefined();
  expect(err.code).toBe(ErrorCode.InvalidRequest);
  expect(err.message).toContain(GATE);
  expect(err.message).toContain(STORY);
}

beforeEach(() => {
  h.root = null;
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  errSpy?.mockRestore();
  for (const p of cleanup.splice(0)) {
    try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

const messages = {};

describe("runExecTool refuses preCommands without a gated, unchanged ARCH approval", () => {
  it("approved versioned story with a preCommand added after approval: story_changed_since_arch, nothing runs", async () => {
    const root = setupProject("amended", { preCommands: [ALLOWED], approval: "amended" });
    writePlan(root, "precmd-amended");
    const stashBefore = stashList(root);
    const { err } = await execOnce("precmd-amended");
    expect(err, "expected runExecTool to reject").toBeDefined();
    expect(err.code).toBe(ErrorCode.InvalidRequest);
    expect(err.message).toContain("story_changed_since_arch");
    expect(err.message).toContain(STORY);
    expect(markerExists(root)).toBe(false);
    expect(rksBranches(root)).toBe("");
    expect(currentBranch(root)).toBe("staging");
    expect(stashList(root)).toBe(stashBefore);
  }, 60_000);

  it("unapproved story with an allowed preCommand: InvalidRequest naming the storyId and the observed verdict", async () => {
    const root = setupProject("unapproved", { preCommands: [ALLOWED], approval: "none" });
    writePlan(root, "precmd-unapproved");
    const stashBefore = stashList(root);
    const { err } = await execOnce("precmd-unapproved");
    expectGateRefusal(err);
    expect(err.message).toContain("arch_verdict absent");
    expect(err.message).toContain("arch_subject absent");
    expect(markerExists(root)).toBe(false);
    expect(rksBranches(root)).toBe("");
    expect(stashList(root)).toBe(stashBefore);
    messages.unapproved = err.message;
  }, 60_000);

  it("approved with arch_subject absent and an allowed preCommand: refusal reports arch_verdict approved and arch_subject absent", async () => {
    const root = setupProject("nosubject", { preCommands: [ALLOWED], approval: "noSubject" });
    writePlan(root, "precmd-nosubject");
    const { err } = await execOnce("precmd-nosubject");
    expectGateRefusal(err);
    expect(err.message).toContain('arch_verdict "approved"');
    expect(err.message).toContain("arch_subject absent");
    expect(err.message).not.toContain("arch_subject_unversioned");
    expect(markerExists(root)).toBe(false);
    expect(rksBranches(root)).toBe("");
    messages.noSubject = err.message;
  }, 60_000);

  it("unversioned approval with an allowed preCommand: InvalidRequest naming arch_subject_unversioned", async () => {
    const root = setupProject("unversioned", { preCommands: [ALLOWED], approval: "unversioned" });
    writePlan(root, "precmd-unversioned");
    const { err } = await execOnce("precmd-unversioned");
    expectGateRefusal(err);
    expect(err.message).toContain("arch_subject_unversioned");
    expect(markerExists(root)).toBe(false);
    expect(rksBranches(root)).toBe("");
    messages.unversioned = err.message;
  }, 60_000);

  it("the three ungated refusal messages differ and each is built from observed values", () => {
    const { unapproved, noSubject, unversioned } = messages;
    for (const m of [unapproved, noSubject, unversioned]) expect(typeof m).toBe("string");
    expect(new Set([unapproved, noSubject, unversioned]).size).toBe(3);
    expect(unapproved).not.toContain("arch_subject_unversioned");
    expect(noSubject).not.toContain("arch_subject_unversioned");
    expect(unversioned).toContain("arch_subject_unversioned");
    expect(noSubject).toContain('arch_verdict "approved"');
    expect(noSubject).not.toContain("not approved");
    expect(unversioned).toContain('arch_verdict "approved"');
    expect(unversioned).toContain("arch_subject recorded");
    expect(unversioned).toContain("arch_subject_version absent");
  });

  it("unapproved story with a single-string allowed preCommand: refused by the approval gate, nothing runs", async () => {
    const root = setupProject("single", { preCommands: ALLOWED, approval: "none" });
    writePlan(root, "precmd-single");
    const { err } = await execOnce("precmd-single");
    expectGateRefusal(err);
    expect(markerExists(root)).toBe(false);
    expect(rksBranches(root)).toBe("");
  }, 60_000);
});

describe("runExecTool behaviour that does not change", () => {
  it("unchanged versioned approval: the allowed preCommand runs", async () => {
    const root = setupProject("versioned", { preCommands: [ALLOWED], approval: "versioned" });
    writePlan(root, "precmd-versioned");
    const outcome = await execOnce("precmd-versioned");
    expect(outcomeText(outcome)).not.toContain(GATE);
    expect(markerExists(root)).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(root, MARKER_REL), "utf8"))).toEqual(["alpha", "beta"]);
  }, 120_000);

  const DISALLOWED = [
    ["shell", "touch MARKER && true", "shell_syntax_rejected"],
    ["confirm", "rm -rf src", "require_explicit_confirmation"],
    ["unknown", "rks-no-such-binary-xyz --flag", "unknown"],
  ];
  for (const approval of ["none", "versioned"]) {
    for (const [tag, entry, classification] of DISALLOWED) {
      it(`disallowed entries keep their classification refusal on unapproved and unchanged-approved stories (${approval}, ${classification})`, async () => {
        const root = setupProject(`${tag}-${approval}`, { preCommands: [entry], approval });
        writePlan(root, `precmd-${tag}-${approval}`);
        const { err } = await execOnce(`precmd-${tag}-${approval}`);
        expect(err, "expected runExecTool to reject").toBeDefined();
        expect(err.code).toBe(ErrorCode.InvalidRequest);
        expect(err.message).toContain(STORY);
        expect(err.message).toContain(`classifies as ${classification}`);
        expect(err.message).not.toContain(GATE);
        expect(fs.existsSync(path.join(root, "MARKER"))).toBe(false);
        expect(fs.existsSync(path.join(root, "src"))).toBe(true);
        expect(rksBranches(root)).toBe("");
      }, 60_000);
    }
  }

  it("no preCommands: unapproved and unversioned stories are not refused by the approval gate", async () => {
    const stale = { qualityReview: { hash: "0".repeat(64) } };
    const rootA = setupProject("none-unapproved", { approval: "none" });
    writePlan(rootA, "precmd-none-unapproved", stale);
    const a = await execOnce("precmd-none-unapproved");
    expect(outcomeText(a)).not.toContain(GATE);
    expect(a.result?.status).toBe("integrity_failed");

    const rootB = setupProject("none-unversioned", { approval: "unversioned" });
    writePlan(rootB, "precmd-none-unversioned", stale);
    const b = await execOnce("precmd-none-unversioned");
    expect(outcomeText(b)).not.toContain(GATE);
    expect(b.result?.status).toBe("integrity_failed");
  }, 120_000);

  it("preCommands []: an unapproved story is not refused by the approval gate", async () => {
    const stale = { qualityReview: { hash: "0".repeat(64) } };
    const rootEmpty = setupProject("empty", { preCommands: [], approval: "none" });
    expect(fs.readFileSync(path.join(rootEmpty, "notes", `${STORY}.md`), "utf8")).toContain("preCommands: []");
    writePlan(rootEmpty, "precmd-empty", stale);
    const empty = await execOnce("precmd-empty");
    expect(outcomeText(empty)).not.toContain(GATE);

    const rootNone = setupProject("empty-control", { approval: "none" });
    writePlan(rootNone, "precmd-empty-control", stale);
    const none = await execOnce("precmd-empty-control");
    expect(empty.err).toBeUndefined();
    expect(none.err).toBeUndefined();
    expect(empty.result?.status).toBe(none.result?.status);
    expect(empty.result?.status).toBe("integrity_failed");
  }, 120_000);
});
