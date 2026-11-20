/**
 * backlog.fix.exec-rollback-orphans-created-files
 *
 * A rolled-back exec left the files its plan created or edited under PROTECTED_PATHS (notes/,
 * .rks/, .routekit/) on disk, deadlocking its own retry with create_file_already_exists, and still
 * reported cleaned true and rolledBack true. The fix records a pre-image before every plan-target
 * write (runApplyTool AND applyFixPlan, through one shared helper in exec/backup.mjs, into one
 * per-run record), reverts only the plan's own protected-path writes from that record in rollback(),
 * reports leftBehind, and derives rolledBack through ONE shared function (deriveRolledBack).
 *
 * Every test builds its own temp git repo on `staging` (tests/helpers/tmp.mjs, outside any real
 * repository). exec.mjs, fix-planner.mjs, test-runner.mjs and backup.mjs are the real modules;
 * loadContext is mocked so projects/index.jsonl is never touched, embedScopedFiles and
 * guardrailsOff/On are stubbed (collaborators, not under test). Every spawnSync in this file, and
 * in the fixture scripts it writes, passes an explicit timeout.
 *
 * testRequirement -> test (TRn = the story's nth testRequirement):
 *   TR1  "[TR1] runApplyTool records a pre-image entry before each file-step write ..."
 *   TR2  "[TR2] first pre-image and last post-write hash win ..."
 *   TR3  "[TR3] deletes a plan-created notes/ file ..."
 *   TR4  "[TR4] restores edit_file / search_replace targets to exact pre-run bytes (not HEAD) ..."
 *   TR5  "[TR5] re-creates a notes/ file a plan delete_file removed ..."
 *   TR6  "[TR6] failed exec: notes/a.md absent, notes/b.md byte-identical, re-plan does not raise ..."
 *   TR7  "[TR7] NEGATIVE CONTROL: notes/ files the plan did not write survive ..."
 *   TR8  "[TR8] NEGATIVE CONTROL: a file changed after the plan wrote it is not touched ..."
 *   TR9  "[TR9] a file already at its pre-run state counts as reverted and is not written ..."
 *   TR10 "[TR10] FALLBACK: missing or unreadable pre-image ..."
 *   TR11 "[TR11] FALLBACK: unparseable write record ..."
 *   TR12 "[TR12] a target outside the project root is refused ..."
 *   TR13 "[TR13] reverting an already-absent created file is a no-op ..."
 *   TR14 "[TR14] leftBehind shape; cleaned only with cleanup success AND empty leftBehind"
 *   TR15 "[TR15] shared derivation truth table ..."
 *   TR16 "[TR16] exec.mjs: no rolledBack true literal, no rb?.cleaned arm, every site derives ..."
 *   TR17 "[TR17] exec response: leftBehind non-empty -> rolledBack false + guidance ..."
 *   TR18 "[TR18] exec.rollback telemetry and the receipt carry reverted and leftBehind"
 *   TR19 "[TR19] NEGATIVE CONTROL: .rks/ and .routekit/ survive; partial diff captured before revert"
 *   TR20 "[TR20] NEGATIVE CONTROL: outside PROTECTED_PATHS, tracked back at HEAD, untracked removed"
 *   TR21 "[TR21] NEGATIVE CONTROL: create_file_already_exists still fires ..."
 *   TR22 "[TR22] NEGATIVE CONTROL: cleanupWorkingTree shape and exclusions; createBackup exclusions"
 *   TR23 "[TR23] NEGATIVE CONTROL: successful exec keeps plan files; record never staged or committed"
 *   TR24 exec-command-policy-integrity.test.mjs (rolledBackFrom is now deriveRolledBack)
 *   TR25 exec-no-tests-found-non-refinable.test.mjs
 *   TR26 "[TR26] FIX PLAN: applyFixPlan records a pre-image entry before each write ..."
 *   TR27 "[TR27] FIX PLAN: fix-a created and fix-b edited are reverted ..."
 *   TR28 "[TR28] FIX PLAN: initial plan's pre-image kept across a fix-plan re-edit ..."
 *   TR29 "[TR29] FIX PLAN: initial-plan create stays existed:false after a fix-plan edit ..."
 *   TR30 "[TR30] FIX PLAN: a write before a later throwing step is still reverted ..."
 *   TR31 "[TR31] NEGATIVE CONTROL: fix-plan file changed after write -> leftBehind ..."
 *   TR32 "[TR32] one shared write-record helper, outside exec.mjs ..."
 *   TR34 [process] every spawnSync below passes timeout: GIT_TIMEOUT (also inside fixture scripts).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { makeTempDir } from "../helpers/tmp.mjs";

const h = vi.hoisted(() => ({ root: null }));
vi.mock("../../packages/mcp-rks/src/server/project.mjs", async (importOriginal) => ({
  ...(await importOriginal()),
  loadContext: vi.fn(async (projectId) => ({ record: { id: projectId, root: h.root }, projectJson: { baseBranch: "staging" } })),
}));
vi.mock("@routekit/rag", async (importOriginal) => ({
  ...(await importOriginal()),
  embedScopedFiles: vi.fn(async () => ({ ok: true, filesEmbedded: 0 })),
}));
vi.mock("../../packages/mcp-rks/src/server/guardrails-audit.mjs", async (importOriginal) => ({
  ...(await importOriginal()),
  guardrailsOff: vi.fn(async () => ({ ok: true })),
  guardrailsOn: vi.fn(async () => ({ ok: true })),
}));

const { runApplyTool, runExecTool } = await import("../../packages/mcp-rks/src/server/exec.mjs");
const { applyFixPlan } = await import("../../packages/mcp-rks/src/server/fix-planner.mjs");
const { rollback, deriveRolledBack, rollbackRecoveryGuidance } = await import("../../packages/mcp-rks/src/server/test-runner.mjs");
const {
  PROTECTED_PATHS,
  cleanupWorkingTree,
  createBackup,
  readWriteRecord,
  writeRecordPath,
  PRE_IMAGE_RELATIVE_DIR,
} = await import("../../packages/mcp-rks/src/exec/backup.mjs");
const { reviewPlan } = await import("../../packages/mcp-rks/src/server/plan-quality.mjs");

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const SRC = (rel) => fs.readFileSync(path.join(REPO_ROOT, "packages/mcp-rks/src", rel), "utf8");

const GIT_TIMEOUT = 15_000;
const git = (root, args) => {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8", timeout: GIT_TIMEOUT });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
};
const sha = (buf) => createHash("sha256").update(buf).digest("hex");

const POLICY_REL = ".routekit/command-policy.yaml";
const SCRIPTS = {
  "stray.mjs": 'import fs from "node:fs";\nfs.writeFileSync("stray.txt", "stray\\n");\n',
  "touch-note.mjs": 'import fs from "node:fs";\nfs.appendFileSync("notes/a.md", "governor edit after the plan\\n");\nfs.writeFileSync("stray.txt", "stray\\n");\n',
};
const POLICY = [
  "command_policy:",
  `  auto_execute: [${Object.keys(SCRIPTS).map((n) => JSON.stringify(`node ${n}`)).join(", ")}]`,
  '  execute_with_plan_approval: ["git add", "git commit"]',
  '  require_explicit_confirmation: ["rm"]',
  "",
].join("\n");

const B_COMMITTED = "# b\n\ncommitted body\n";
const C_COMMITTED = "# c\n\nalpha beta gamma\n";
const D_COMMITTED = "# d\n\nto be deleted\n";
const FN_COMMITTED = "function foo() {\n  return 1;\n}\n";
const STORY = "backlog.fix.orphan-fixture";
const STORY_BODY = `---\nid: "${STORY}"\ntitle: "fixture"\nphase: "executing"\n---\n\nbody\n`;

const cleanup = [];
function makeRepo(tag) {
  const root = makeTempDir(`orphans-${tag}`);
  cleanup.push(root);
  fs.mkdirSync(path.join(root, ".routekit"), { recursive: true });
  fs.mkdirSync(path.join(root, "notes"), { recursive: true });
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, POLICY_REL), POLICY);
  for (const [name, text] of Object.entries(SCRIPTS)) fs.writeFileSync(path.join(root, name), text);
  fs.writeFileSync(path.join(root, "notes", "b.md"), B_COMMITTED);
  fs.writeFileSync(path.join(root, "notes", "c.md"), C_COMMITTED);
  fs.writeFileSync(path.join(root, "notes", "d.md"), D_COMMITTED);
  fs.writeFileSync(path.join(root, "notes", "fn.mjs"), FN_COMMITTED);
  fs.writeFileSync(path.join(root, "notes", `${STORY}.md`), STORY_BODY);
  fs.writeFileSync(path.join(root, "src", "app.mjs"), "// committed\n");
  fs.writeFileSync(path.join(root, ".gitignore"), ".rks/*\n!.rks/plans/\n");
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
  const runDir = path.join(root, ".rks", "runs", `2026-11-08T00-00-00-000Z_${label}`);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, "plan.json"), JSON.stringify({ slug: label, status: "executable", steps, ...extra }, null, 2));
  fs.writeFileSync(path.join(runDir, "run.json"), JSON.stringify({ projectId: "orphans", timestamps: {}, telemetry: { outcome: "planned" } }));
  return runDir;
}

const read = (root, rel) => fs.readFileSync(path.join(root, rel));
const readText = (root, rel) => fs.readFileSync(path.join(root, rel), "utf8");
const exists = (root, rel) => fs.existsSync(path.join(root, rel));
const entryFor = (runDir, target) => {
  const r = readWriteRecord(runDir);
  if (r.status !== "ok") return undefined;
  return r.record.entries.find((e) => e.target === target);
};
const preImageBytes = (runDir, entry) => fs.readFileSync(path.join(runDir, PRE_IMAGE_RELATIVE_DIR, entry.preImageHash));
const doRollback = (root, runDir, extra = {}) => rollback(root, { runDir, branchName: null, baseBranch: null, backupMeta: null, guardrailsSession: null, projectId: "orphans", reason: "test_failure", ...extra });

async function apply(root, label, steps) {
  const runDir = writePlan(root, label, steps);
  const res = await runApplyTool({ projectId: "orphans", label, force: true });
  return { runDir, res };
}

/**
 * Snapshot the write record each time `fs.writeFileSync` / `fs.rmSync` is called on one of the
 * watched absolute paths, so a test can prove the entry was on disk BEFORE the write landed.
 */
function watchWrites(root, runDir, targets) {
  const watched = new Map(targets.map((t) => [path.join(root, t), t]));
  const seen = {};
  const origWrite = fs.writeFileSync.bind(fs);
  const origRm = fs.rmSync.bind(fs);
  const snap = (p) => {
    const t = watched.get(path.resolve(String(p)));
    if (t && !(t in seen)) {
      const entry = entryFor(runDir, t);
      seen[t] = entry ? { ...entry } : null;
    }
  };
  const w = vi.spyOn(fs, "writeFileSync").mockImplementation((p, ...rest) => { snap(p); return origWrite(p, ...rest); });
  const r = vi.spyOn(fs, "rmSync").mockImplementation((p, ...rest) => { snap(p); return origRm(p, ...rest); });
  return { seen, restore: () => { w.mockRestore(); r.mockRestore(); } };
}

let errSpy;
let warnSpy;
beforeEach(() => {
  h.root = null;
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  errSpy?.mockRestore();
  warnSpy?.mockRestore();
  vi.clearAllMocks();
  for (const p of cleanup.splice(0)) {
    try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

// ── Write record (runApplyTool) ─────────────────────────────────────────────
describe("write record — runApplyTool", () => {
  it("[TR1] runApplyTool records a pre-image entry before each file-step write, and the post-write hash after", async () => {
    const root = makeRepo("tr1");
    const steps = [
      { action: "create_file", path: "notes/a.md", content: "# a\n", title: "create" },
      { action: "edit_file", path: "notes/b.md", content: "# b\n\nplan body\n", title: "edit file" },
      { action: "edit_file", path: "notes/fn.mjs", scope: "function", targetId: "foo", content: "function foo() {\n  return 2;\n}", title: "edit fn" },
      { action: "search_replace", path: "notes/c.md", edits: [{ search: "beta", replace: "BETA" }], title: "sr" },
      { action: "delete_file", path: "notes/d.md", title: "delete" },
    ];
    const runDir = writePlan(root, "tr1", steps);
    const targets = steps.map((s) => s.path);
    const watch = watchWrites(root, runDir, targets);
    let res;
    try {
      res = await runApplyTool({ projectId: "orphans", label: "tr1", force: true });
    } finally {
      watch.restore();
    }
    expect(res.ok, JSON.stringify(res)).toBe(true);

    // Before each write: the entry existed, with existed + exact prior bytes, and no post hash yet.
    expect(watch.seen["notes/a.md"]).toMatchObject({ target: "notes/a.md", existed: false, postHash: null });
    expect(watch.seen["notes/b.md"]).toMatchObject({ existed: true, preImageHash: sha(Buffer.from(B_COMMITTED)), postExists: null });
    expect(watch.seen["notes/fn.mjs"]).toMatchObject({ existed: true, preImageHash: sha(Buffer.from(FN_COMMITTED)), postExists: null });
    expect(watch.seen["notes/c.md"]).toMatchObject({ existed: true, preImageHash: sha(Buffer.from(C_COMMITTED)), postExists: null });
    expect(watch.seen["notes/d.md"]).toMatchObject({ existed: true, preImageHash: sha(Buffer.from(D_COMMITTED)), postExists: null });

    // After: exact prior bytes on disk, post-write hash of what the plan left (absent for a delete).
    for (const [t, original] of [["notes/b.md", B_COMMITTED], ["notes/fn.mjs", FN_COMMITTED], ["notes/c.md", C_COMMITTED], ["notes/d.md", D_COMMITTED]]) {
      const e = entryFor(runDir, t);
      expect(preImageBytes(runDir, e).toString("utf8")).toBe(original);
    }
    expect(entryFor(runDir, "notes/a.md")).toMatchObject({ existed: false, postExists: true, postHash: sha(read(root, "notes/a.md")) });
    expect(entryFor(runDir, "notes/b.md").postHash).toBe(sha(read(root, "notes/b.md")));
    expect(entryFor(runDir, "notes/fn.mjs").postHash).toBe(sha(read(root, "notes/fn.mjs")));
    expect(readText(root, "notes/fn.mjs")).toContain("return 2;");
    expect(entryFor(runDir, "notes/c.md").postHash).toBe(sha(read(root, "notes/c.md")));
    expect(entryFor(runDir, "notes/d.md")).toMatchObject({ postExists: false, postHash: null });
    expect(writeRecordPath(runDir)).toBe(path.join(runDir, "apply", "write-record.json"));
  }, 60_000);

  it("[TR2] first pre-image and last post-write hash win when several steps touch one target", async () => {
    const root = makeRepo("tr2");
    const { runDir, res } = await apply(root, "tr2", [
      { action: "edit_file", path: "notes/b.md", content: "# b\n\nfirst plan body\n", title: "e1" },
      { action: "search_replace", path: "notes/b.md", edits: [{ search: "first", replace: "second" }], title: "e2" },
    ]);
    expect(res.ok, JSON.stringify(res)).toBe(true);
    const r = readWriteRecord(runDir);
    expect(r.record.entries.filter((e) => e.target === "notes/b.md")).toHaveLength(1);
    const e = entryFor(runDir, "notes/b.md");
    expect(e.preImageHash).toBe(sha(Buffer.from(B_COMMITTED)));
    expect(readText(root, "notes/b.md")).toBe("# b\n\nsecond plan body\n");
    expect(e.postHash).toBe(sha(Buffer.from("# b\n\nsecond plan body\n")));
  }, 60_000);
});

// ── Record-driven revert ─────────────────────────────────────────────────────
describe("rollback reverts the plan's own protected-path writes", () => {
  it("[TR3] deletes a plan-created notes/ file whose content still matches the post-write hash", async () => {
    const root = makeRepo("tr3");
    const { runDir } = await apply(root, "tr3", [{ action: "create_file", path: "notes/a.md", content: "# a\n", title: "c" }]);
    expect(exists(root, "notes/a.md")).toBe(true);
    const rb = await doRollback(root, runDir);
    expect(exists(root, "notes/a.md")).toBe(false);
    expect(rb.revertedFiles).toEqual(["notes/a.md"]);
    expect(rb.leftBehind).toEqual([]);
  }, 60_000);

  it("[TR4] restores edit_file / search_replace targets to exact pre-run bytes, including uncommitted content (not HEAD)", async () => {
    const root = makeRepo("tr4");
    // Uncommitted pre-run content that differs from HEAD, with bytes HEAD has never seen.
    const bPreRun = Buffer.from("# b\n\nuncommitted governor edit é\r\nno trailing newline");
    const cPreRun = Buffer.from("# c\n\nalpha beta gamma\nuncommitted line\n");
    fs.writeFileSync(path.join(root, "notes", "b.md"), bPreRun);
    fs.writeFileSync(path.join(root, "notes", "c.md"), cPreRun);
    const { runDir, res } = await apply(root, "tr4", [
      { action: "edit_file", path: "notes/b.md", content: "# b\n\nplan body\n", title: "e" },
      { action: "edit_file", path: "notes/fn.mjs", scope: "function", targetId: "foo", content: "function foo() {\n  return 3;\n}", title: "fn" },
      { action: "search_replace", path: "notes/c.md", edits: [{ search: "beta", replace: "BETA" }], title: "sr" },
    ]);
    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect(readText(root, "notes/c.md")).toContain("BETA");
    const rb = await doRollback(root, runDir);
    expect(read(root, "notes/b.md").equals(bPreRun)).toBe(true);
    expect(read(root, "notes/c.md").equals(cPreRun)).toBe(true);
    expect(readText(root, "notes/fn.mjs")).toBe(FN_COMMITTED);
    expect(readText(root, "notes/b.md")).not.toBe(B_COMMITTED);
    expect(rb.leftBehind).toEqual([]);
    expect(rb.cleaned).toBe(true);
  }, 60_000);

  it("[TR5] re-creates a notes/ file a plan delete_file removed, with its exact pre-run bytes", async () => {
    const root = makeRepo("tr5");
    const dPreRun = Buffer.from("# d\n\nuncommitted before delete\n");
    fs.writeFileSync(path.join(root, "notes", "d.md"), dPreRun);
    const { runDir } = await apply(root, "tr5", [{ action: "delete_file", path: "notes/d.md", title: "d" }]);
    expect(exists(root, "notes/d.md")).toBe(false);
    const rb = await doRollback(root, runDir);
    expect(read(root, "notes/d.md").equals(dPreRun)).toBe(true);
    expect(rb.revertedFiles).toEqual(["notes/d.md"]);
  }, 60_000);

  it("[TR7] NEGATIVE CONTROL: notes/ files the plan did not write survive rollback byte-for-byte", async () => {
    const root = makeRepo("tr7");
    const { runDir } = await apply(root, "tr7", [{ action: "create_file", path: "notes/a.md", content: "# a\n", title: "c" }]);
    // Non-plan writers during the run: a tracked note's phase write and an untracked Governor note.
    const storyDuring = Buffer.from(STORY_BODY.replace("executing", "integrated"));
    const govNote = Buffer.from("# governor research paper\n");
    fs.writeFileSync(path.join(root, "notes", `${STORY}.md`), storyDuring);
    fs.writeFileSync(path.join(root, "notes", "research.governor.md"), govNote);
    const rb = await doRollback(root, runDir);
    expect(read(root, `notes/${STORY}.md`).equals(storyDuring)).toBe(true);
    expect(read(root, "notes/research.governor.md").equals(govNote)).toBe(true);
    expect(exists(root, "notes/a.md")).toBe(false);
    expect(rb.revertedFiles).toEqual(["notes/a.md"]);
  }, 60_000);

  it("[TR8] NEGATIVE CONTROL: a plan-written file changed after the plan wrote it is not touched and is listed in leftBehind", async () => {
    const root = makeRepo("tr8");
    const { runDir } = await apply(root, "tr8", [
      { action: "create_file", path: "notes/a.md", content: "# a\n", title: "c" },
      { action: "edit_file", path: "notes/b.md", content: "# b\n\nplan body\n", title: "e" },
    ]);
    const aLater = Buffer.from("# a\n\nsomeone else edited this\n");
    const bLater = Buffer.from("# b\n\nphase write after the plan\n");
    fs.writeFileSync(path.join(root, "notes", "a.md"), aLater);
    fs.writeFileSync(path.join(root, "notes", "b.md"), bLater);
    const rb = await doRollback(root, runDir);
    expect(read(root, "notes/a.md").equals(aLater)).toBe(true);
    expect(read(root, "notes/b.md").equals(bLater)).toBe(true);
    expect(rb.leftBehind.map((l) => l.path).sort()).toEqual(["notes/a.md", "notes/b.md"]);
    for (const l of rb.leftBehind) expect(l.reason).toMatch(/changed after the plan wrote it/);
    expect(rb.cleaned).toBe(false);
  }, 60_000);

  it("[TR9] a plan-written file already at its pre-run state counts as reverted and is not written again", async () => {
    const root = makeRepo("tr9");
    const { runDir } = await apply(root, "tr9", [{ action: "edit_file", path: "notes/b.md", content: "# b\n\nplan body\n", title: "e" }]);
    fs.writeFileSync(path.join(root, "notes", "b.md"), B_COMMITTED); // e.g. undone by a branch checkout
    const writes = vi.spyOn(fs, "writeFileSync");
    let rb;
    try {
      rb = await doRollback(root, runDir);
    } finally {
      var bWrites = writes.mock.calls.filter(([p]) => path.resolve(String(p)) === path.join(root, "notes", "b.md"));
      writes.mockRestore();
    }
    expect(bWrites).toHaveLength(0);
    expect(rb.revertedFiles).toEqual(["notes/b.md"]);
    expect(rb.leftBehind).toEqual([]);
    expect(readText(root, "notes/b.md")).toBe(B_COMMITTED);
  }, 60_000);

  it("[TR10] FALLBACK: a missing or unreadable pre-image leaves the file unreverted (not HEAD), lists it, cleaned false", async () => {
    const root = makeRepo("tr10");
    const bPreRun = "# b\n\nuncommitted\n";
    fs.writeFileSync(path.join(root, "notes", "b.md"), bPreRun);
    const { runDir } = await apply(root, "tr10", [
      { action: "edit_file", path: "notes/b.md", content: "# b\n\nplan body\n", title: "e" },
      { action: "edit_file", path: "notes/c.md", content: "# c\n\nplan body\n", title: "e2" },
    ]);
    // b: pre-image file missing. c: pre-image file present but corrupted (fails its integrity check).
    fs.rmSync(path.join(runDir, PRE_IMAGE_RELATIVE_DIR, entryFor(runDir, "notes/b.md").preImageHash));
    fs.writeFileSync(path.join(runDir, PRE_IMAGE_RELATIVE_DIR, entryFor(runDir, "notes/c.md").preImageHash), "tampered");
    const rb = await doRollback(root, runDir);
    expect(readText(root, "notes/b.md")).toBe("# b\n\nplan body\n");
    expect(readText(root, "notes/b.md")).not.toBe(B_COMMITTED);
    expect(readText(root, "notes/c.md")).toBe("# c\n\nplan body\n");
    expect(readText(root, "notes/c.md")).not.toBe(C_COMMITTED);
    const byPath = Object.fromEntries(rb.leftBehind.map((l) => [l.path, l.reason]));
    expect(byPath["notes/b.md"]).toMatch(/pre-image missing or unreadable/);
    expect(byPath["notes/c.md"]).toMatch(/integrity/);
    expect(rb.cleaned).toBe(false);
    expect(deriveRolledBack(rb)).toBe(false);
  }, 60_000);

  it("[TR11] FALLBACK: an unparseable write record reverts no file, reports leftBehind, cleaned false", async () => {
    const root = makeRepo("tr11");
    const { runDir } = await apply(root, "tr11", [{ action: "create_file", path: "notes/a.md", content: "# a\n", title: "c" }]);
    fs.writeFileSync(writeRecordPath(runDir), "{ not json");
    const rb = await doRollback(root, runDir);
    expect(exists(root, "notes/a.md")).toBe(true);
    expect(rb.reverted).toBe(0);
    expect(rb.leftBehind).toHaveLength(1);
    expect(rb.leftBehind[0].reason).toMatch(/write record could not be parsed/);
    expect(rb.cleaned).toBe(false);
  }, 60_000);

  it("[TR12] a write-record target that resolves outside the project root is refused, not touched, listed", async () => {
    const root = makeRepo("tr12");
    const outsideDir = makeTempDir("orphans-outside");
    cleanup.push(outsideDir);
    const outsideFile = path.join(outsideDir, "victim.md");
    fs.writeFileSync(outsideFile, "outside\n");
    const target = path.relative(root, outsideFile).split(path.sep).join("/");
    expect(target.startsWith("../")).toBe(true);
    const runDir = path.join(root, ".rks", "runs", "manual");
    fs.mkdirSync(path.join(runDir, "apply"), { recursive: true });
    fs.writeFileSync(writeRecordPath(runDir), JSON.stringify({
      version: 1,
      entries: [{ target, existed: false, preImageHash: null, postExists: true, postHash: sha(Buffer.from("outside\n")) }],
    }));
    const rb = await doRollback(root, runDir);
    expect(fs.readFileSync(outsideFile, "utf8")).toBe("outside\n");
    expect(rb.leftBehind).toEqual([{ path: target, reason: expect.stringMatching(/outside the project root/) }]);
    expect(rb.cleaned).toBe(false);
  }, 60_000);

  it("[TR13] reverting a plan-created file that is already absent is a no-op counted as reverted", async () => {
    const root = makeRepo("tr13");
    const { runDir } = await apply(root, "tr13", [{ action: "create_file", path: "notes/a.md", content: "# a\n", title: "c" }]);
    fs.rmSync(path.join(root, "notes", "a.md"));
    const rb = await doRollback(root, runDir);
    expect(rb.revertedFiles).toEqual(["notes/a.md"]);
    expect(rb.leftBehind).toEqual([]);
    expect(rb.cleaned).toBe(true);
  }, 60_000);

  it("[TR14] leftBehind is an array of { path, reason }; cleaned only when cleanup succeeded AND leftBehind is empty", async () => {
    const root = makeRepo("tr14");
    // No runDir / no record: no-op with an empty leftBehind (existing callers keep their outcome).
    const none = await doRollback(root, undefined);
    expect(none.leftBehind).toEqual([]);
    expect(none.reverted).toBe(0);
    expect(none.cleaned).toBe(true);
    const emptyRun = path.join(root, ".rks", "runs", "empty");
    fs.mkdirSync(emptyRun, { recursive: true });
    const noRecord = await doRollback(root, emptyRun);
    expect(noRecord.leftBehind).toEqual([]);
    expect(noRecord.cleaned).toBe(true);

    const { runDir } = await apply(root, "tr14", [{ action: "create_file", path: "notes/a.md", content: "# a\n", title: "c" }]);
    fs.writeFileSync(path.join(root, "notes", "a.md"), "changed\n");
    const left = await doRollback(root, runDir);
    expect(Array.isArray(left.leftBehind)).toBe(true);
    for (const l of left.leftBehind) expect(Object.keys(l).sort()).toEqual(["path", "reason"]);
    expect(left.cleanupCleaned).toBe(true);
    expect(left.cleaned).toBe(false);

    // Cleanup failure alone also yields cleaned false: a non-git root makes the checkout fail.
    const bare = makeTempDir("orphans-nogit");
    cleanup.push(bare);
    const failed = await doRollback(bare, undefined);
    expect(failed.leftBehind).toEqual([]);
    expect(failed.cleanupCleaned).toBe(false);
    expect(failed.cleaned).toBe(false);
  }, 60_000);
});

// ── Shared derivation ────────────────────────────────────────────────────────
describe("the ONE rolledBack derivation", () => {
  it("[TR15] truth table: restored, nothing to restore, failed stash apply, missing backup folder, cleaned false", async () => {
    // Pure table, so a `|| cleaned` arm or an inferred-from-text rule cannot pass.
    expect(deriveRolledBack({ cleaned: true, restored: true })).toBe(true);
    expect(deriveRolledBack({ cleaned: true, restored: false, nothingToRestore: true })).toBe(true);
    expect(deriveRolledBack({ cleaned: true, restored: false, restoreError: "no backup stash was created for this run — nothing to restore" })).toBe(false);
    expect(deriveRolledBack({ cleaned: false, restored: true })).toBe(false);
    expect(deriveRolledBack({ cleaned: false, restored: false, nothingToRestore: true })).toBe(false);
    expect(deriveRolledBack({ cleaned: true, restored: true, leftBehind: [{ path: "notes/a.md", reason: "x" }] })).toBe(false);
    expect(deriveRolledBack(null)).toBe(false);

    // Observed rollback() results.
    const root = makeRepo("tr15");
    const noBackup = await doRollback(root, undefined, { backupMeta: null });
    expect(noBackup.cleaned).toBe(true);
    expect(deriveRolledBack(noBackup)).toBe(true);

    const noStashMeta = createBackup(root, null); // clean tree: no stash created
    expect(noStashMeta.stashCreated).toBe(false);
    const noStash = await doRollback(root, undefined, { backupMeta: noStashMeta });
    expect(noStash.restored).toBe(false);
    expect(noStash.nothingToRestore).toBe(true);
    expect(deriveRolledBack(noStash)).toBe(true);

    fs.writeFileSync(path.join(root, "src", "app.mjs"), "// wip\n");
    const stashMeta = createBackup(root, null);
    expect(stashMeta.stashCreated).toBe(true);
    const restored = await doRollback(root, undefined, { backupMeta: stashMeta });
    expect(restored.restored).toBe(true);
    expect(deriveRolledBack(restored)).toBe(true);

    const applyFailed = await doRollback(root, undefined, { backupMeta: { type: "git-stash", stashCreated: true, stashSha: "deadbeef".repeat(5) } });
    expect(applyFailed.cleaned).toBe(true);
    expect(applyFailed.restored).toBe(false);
    expect(deriveRolledBack(applyFailed)).toBe(false);

    const folderMissing = await doRollback(root, undefined, { backupMeta: { type: "file-copy", path: path.join(root, "no-such-backup") } });
    expect(folderMissing.cleaned).toBe(true);
    expect(folderMissing.restoreError).toBe("backup folder not found");
    expect(deriveRolledBack(folderMissing)).toBe(false);
  }, 60_000);

  it("[TR16] exec.mjs: no rolledBack true literal, no rb?.cleaned arm, and every exec rollback site derives rolledBack through deriveRolledBack", () => {
    const exec = SRC("server/exec.mjs");
    expect(exec).not.toMatch(/rolledBack:\s*true\b/);
    expect(exec).not.toMatch(/rb\?\.cleaned\s*===\s*true/);
    expect(exec).not.toMatch(/\.restored === true \|\| [^\n]*\.cleaned === true/);
    expect(exec).toMatch(/import \{[^}]*\bderiveRolledBack\b[^}]*\} from "\.\/test-runner\.mjs"/);
    // Every `const rb = await rollback(` site: its segment up to the next rollback derives rolledBack
    // through the shared function. recoverExecFailure discards its result and reports no rolledBack.
    const starts = [...exec.matchAll(/const rb = await rollback\(/g)].map((m) => m.index);
    expect(starts.length).toBe(12);
    expect((exec.match(/await rollback\(/g) || []).length).toBe(13);
    starts.forEach((start, i) => {
      const end = i + 1 < starts.length ? starts[i + 1] : exec.length;
      const seg = exec.slice(start, end);
      const firstRolledBack = seg.search(/\brolledBack\b/);
      expect(firstRolledBack, `site ${i} reports rolledBack`).toBeGreaterThan(-1);
      expect(seg).toMatch(/rolledBack(?:\s*=|:)\s*deriveRolledBack\(rb\)|(?:const \w*[rR]olledBack|rolledBack) = deriveRolledBack\(rb\)/);
    });
    // The derivation itself has no cleaned-only arm.
    const runner = SRC("server/test-runner.mjs");
    const fnAt = runner.indexOf("export function deriveRolledBack(");
    const fn = runner.slice(fnAt, runner.indexOf("\n}\n", fnAt));
    expect(fn).not.toMatch(/\|\|\s*rb\??\.cleaned\s*===\s*true/);
    expect(fn).toMatch(/nothingToRestore/);
    expect(fn).not.toMatch(/restoreError/);
  });

  it("[TR17] guidance: non-empty leftBehind -> rolledBack false with paths and recovery; empty -> rolledBack true, no guidance", () => {
    const dirty = { cleaned: false, cleanupCleaned: true, restored: false, nothingToRestore: true, leftBehind: [{ path: "notes/a.md", reason: "changed after the plan wrote it" }], partialDiffPath: "/x/partial.diff" };
    expect(deriveRolledBack(dirty)).toBe(false);
    const g = rollbackRecoveryGuidance(dirty);
    expect(g).toContain("notes/a.md");
    expect(g).toMatch(/manual recovery/);
    expect(g).toMatch(/rks_plan/);
    const clean = { cleaned: true, cleanupCleaned: true, restored: false, nothingToRestore: true, leftBehind: [] };
    expect(deriveRolledBack(clean)).toBe(true);
    expect(rollbackRecoveryGuidance(clean)).toBeNull();
    const restoreFailed = { cleaned: true, restored: false, restoreError: "git stash apply failed", leftBehind: [] };
    expect(rollbackRecoveryGuidance(restoreFailed)).toContain("git stash apply failed");
  });
});

// ── Rollback restore log (backlog.fix.exec-rollback-nothing-to-restore-log) ──
// Drives the real rollback() and inspects only that rollback's console.error calls (errSpy is
// cleared immediately before each doRollback). NR1..NR6 = that story's testRequirements 1-6.
describe("rollback restore log distinguishes nothing-to-restore from failure", () => {
  const errLines = () => errSpy.mock.calls.map((args) => args.map(String).join(" "));

  it("[NR1][NR2][NR5] clean-tree backup (no stash): nothing to restore is logged, never Rollback failed; derives rolledBack true, no guidance", async () => {
    const root = makeRepo("nr-nothing");
    const meta = createBackup(root, null); // clean tree: no stash created
    expect(meta.stashCreated).toBe(false);
    errSpy.mockClear();
    const rb = await doRollback(root, undefined, { backupMeta: meta });
    const lines = errLines();
    // NR1
    expect(rb.restored).toBe(false);
    expect(rb.nothingToRestore).toBe(true);
    expect(lines.filter((l) => l.includes("Rollback failed"))).toEqual([]);
    // NR2
    expect(lines.some((l) => l.startsWith("[rks.exec] Rollback") && l.includes("nothing to restore"))).toBe(true);
    // NR5
    expect(deriveRolledBack(rb)).toBe(true);
    expect(rollbackRecoveryGuidance(rb)).toBeNull();
  }, 60_000);

  it("[NR3][NR6] stash apply failure: Rollback failed is logged with restoreError; derives rolledBack false with restore-failed guidance", async () => {
    const root = makeRepo("nr-stashfail");
    errSpy.mockClear();
    const rb = await doRollback(root, undefined, { backupMeta: { type: "git-stash", stashCreated: true, stashSha: "deadbeef".repeat(5) } });
    const lines = errLines();
    // NR3
    expect(rb.restored).toBe(false);
    expect(rb.nothingToRestore).toBe(false);
    expect(typeof rb.restoreError).toBe("string");
    expect(rb.restoreError.length).toBeGreaterThan(0);
    expect(lines.some((l) => l.includes(`[rks.exec] Rollback failed: ${rb.restoreError}`))).toBe(true);
    expect(lines.some((l) => l.includes("nothing to restore"))).toBe(false);
    // NR6
    expect(deriveRolledBack(rb)).toBe(false);
    expect(rollbackRecoveryGuidance(rb)).toContain("The backup restore failed");
  }, 60_000);

  it("[NR4] missing file-copy backup folder: restoreError backup folder not found and Rollback failed is logged", async () => {
    const root = makeRepo("nr-nofolder");
    errSpy.mockClear();
    const rb = await doRollback(root, undefined, { backupMeta: { type: "file-copy", path: path.join(root, "no-such-backup") } });
    expect(rb.restoreError).toBe("backup folder not found");
    expect(errLines().some((l) => l.includes("[rks.exec] Rollback failed: backup folder not found"))).toBe(true);
  }, 60_000);
});

// ── Exec-level ──────────────────────────────────────────────────────────────
describe("exec end to end", () => {
  it("[TR6] failed exec: notes/a.md absent, notes/b.md byte-identical, re-plan does not raise create_file_already_exists", async () => {
    const root = makeRepo("tr6");
    const bBefore = read(root, "notes/b.md");
    const label = "tr6";
    writePlan(root, label, [
      { action: "create_file", path: "notes/a.md", content: "# a\n\ncapture format\n", title: "create" },
      { action: "edit_file", path: "notes/b.md", content: "# b\n\npeople edit\n", title: "edit" },
      { action: "run_command", command: "node stray.mjs", title: "stray" },
    ]);
    const result = await runExecTool({ projectId: "orphans", label, skipTests: true });
    expect(result.ok, JSON.stringify(result)).toBe(false);
    expect(result.error).toMatch(/Scope violation/);
    expect(exists(root, "notes/a.md")).toBe(false);
    expect(read(root, "notes/b.md").equals(bBefore)).toBe(true);
    expect(exists(root, "stray.txt")).toBe(false);
    // [TR17] empty leftBehind and a successful-or-empty restore: rolledBack true, no guidance.
    expect(result.leftBehind).toEqual([]);
    expect(result.rolledBack).toBe(true);
    expect(result.recovery).toBeNull();

    const review = await reviewPlan({ projectRoot: root, plan: { steps: [{ action: "create_file", path: "notes/a.md", content: "# a\n" }] }, problemContent: null });
    expect((review.errors || []).find((e) => e.check === "create_file_already_exists")).toBeUndefined();
  }, 120_000);

  it("[TR17] exec response with a non-empty leftBehind reports rolledBack false with the paths and recovery guidance", async () => {
    const root = makeRepo("tr17");
    const label = "tr17";
    writePlan(root, label, [
      { action: "create_file", path: "notes/a.md", content: "# a\n", title: "create" },
      { action: "run_command", command: "node touch-note.mjs", title: "touch" },
    ]);
    const result = await runExecTool({ projectId: "orphans", label, skipTests: true });
    expect(result.ok, JSON.stringify(result)).toBe(false);
    expect(result.error).toMatch(/Scope violation/);
    expect(result.leftBehind.map((l) => l.path)).toEqual(["notes/a.md"]);
    expect(result.rolledBack).toBe(false);
    expect(result.recovery).toContain("notes/a.md");
    expect(result.recovery).toMatch(/manual recovery/);
    expect(result.hint).not.toMatch(/Changes have been rolled back/);
    expect(readText(root, "notes/a.md")).toContain("governor edit after the plan");
  }, 120_000);

  it("[TR23] NEGATIVE CONTROL: a successful exec leaves plan-written files in place; the write record is never staged or committed", async () => {
    const root = makeRepo("tr23");
    const label = "tr23";
    const runDir = writePlan(root, label, [
      { action: "create_file", path: "notes/new.md", content: "# new\n", title: "create" },
      { action: "edit_file", path: "notes/b.md", content: "# b\n\nkept\n", title: "edit" },
    ], { problemId: STORY });
    const result = await runExecTool({ projectId: "orphans", label, skipTests: true });
    expect(result.status, JSON.stringify(result)).toBe("pending_ship");
    expect(readText(root, "notes/new.md")).toBe("# new\n");
    expect(readText(root, "notes/b.md")).toBe("# b\n\nkept\n");
    expect(readWriteRecord(runDir).status).toBe("ok");
    const everCommitted = git(root, ["log", "--all", "--name-only", "--format="]);
    expect(everCommitted).not.toMatch(/write-record|pre-images/);
    const staged = git(root, ["diff", "--cached", "--name-only"]);
    expect(staged).not.toMatch(/write-record|pre-images/);
    const tracked = git(root, ["ls-files"]);
    expect(tracked).not.toMatch(/write-record|pre-images/);
  }, 120_000);
});

// ── Telemetry, receipt, negative controls ───────────────────────────────────
describe("observability and preserved behaviour", () => {
  it("[TR18] exec.rollback telemetry and the intervention receipt carry reverted and leftBehind beside restored and cleaned", async () => {
    const root = makeRepo("tr18");
    const { runDir } = await apply(root, "tr18", [
      { action: "create_file", path: "notes/a.md", content: "# a\n", title: "c" },
      { action: "create_file", path: "notes/z.md", content: "# z\n", title: "c2" },
    ]);
    fs.writeFileSync(path.join(root, "notes", "z.md"), "changed\n");
    const rb = await doRollback(root, runDir);
    // Telemetry: the exec.rollback emit is checked at source level. This file deliberately does not
    // import the globally mocked telemetry barrel (tests/unit/telemetry-global-mock-triage.test.mjs
    // registers every consumer); the payload fields are read from the same observed `result` the
    // receipt below is built from, which this test checks behaviourally.
    const runner = SRC("server/test-runner.mjs");
    const at = runner.indexOf("collector.emit('exec.rollback', projectId, {");
    expect(at).toBeGreaterThan(-1);
    const emitCall = runner.slice(at, runner.indexOf("}, { correlationId", at));
    expect(emitCall).toMatch(/\brestored: result\.restored,/);
    expect(emitCall).toMatch(/\bcleaned: result\.cleaned,/);
    expect(emitCall).toMatch(/\breverted: result\.reverted,/);
    expect(emitCall).toMatch(/\bleftBehind: result\.leftBehind,/);
    expect(rb).toMatchObject({ reverted: 1, restored: false, cleaned: false });
    expect(rb.leftBehind.map((l) => l.path)).toEqual(["notes/z.md"]);
    expect(rb.intervention).toMatchObject({ reverted: 1, restored: false, cleaned: false });
    expect(rb.intervention.leftBehind.map((l) => l.path)).toEqual(["notes/z.md"]);
    const lines = fs.readFileSync(path.join(root, ".rks", "state", "interventions.jsonl"), "utf8").trim().split("\n");
    const last = JSON.parse(lines[lines.length - 1]);
    expect(last.reverted).toBe(1);
    expect(last.leftBehind[0].path).toBe("notes/z.md");
  }, 60_000);

  it("[TR19] NEGATIVE CONTROL: .rks/ and .routekit/ files the plan did not write survive; partialDiffPath is captured before the revert and returned", async () => {
    const root = makeRepo("tr19");
    const policyBefore = read(root, POLICY_REL);
    const { runDir } = await apply(root, "tr19", [{ action: "create_file", path: "notes/a.md", content: "# a\n", title: "c" }]);
    fs.mkdirSync(path.join(root, ".rks", "state"), { recursive: true });
    fs.writeFileSync(path.join(root, ".rks", "state", "session.json"), '{"during":true}\n');
    fs.writeFileSync(path.join(root, ".routekit", "runtime.json"), '{"during":true}\n');
    const rb = await doRollback(root, runDir);
    expect(readText(root, ".rks/state/session.json")).toBe('{"during":true}\n');
    expect(readText(root, ".routekit/runtime.json")).toBe('{"during":true}\n');
    expect(read(root, POLICY_REL).equals(policyBefore)).toBe(true);
    expect(rb.partialDiffPath).toBeTruthy();
    // The diff names the plan-created file, which the revert then removed: it was captured first.
    expect(fs.readFileSync(rb.partialDiffPath, "utf8")).toContain("notes/a.md");
    expect(exists(root, "notes/a.md")).toBe(false);
  }, 60_000);

  it("[TR20] NEGATIVE CONTROL: outside PROTECTED_PATHS, tracked files return to HEAD and untracked files are removed", async () => {
    const root = makeRepo("tr20");
    const { runDir } = await apply(root, "tr20", [
      { action: "edit_file", path: "src/app.mjs", content: "// plan edit\n", title: "e" },
      { action: "create_file", path: "src/new.mjs", content: "// new\n", title: "c" },
    ]);
    fs.writeFileSync(path.join(root, "untracked.txt"), "x\n");
    const rb = await doRollback(root, runDir);
    expect(readText(root, "src/app.mjs")).toBe("// committed\n");
    expect(exists(root, "src/new.mjs")).toBe(false);
    expect(exists(root, "untracked.txt")).toBe(false);
    expect(rb.leftBehind).toEqual([]);
    // Non-protected targets are not handled by the record-driven revert.
    expect(rb.revertedFiles).toEqual([]);
  }, 60_000);

  it("[TR21] NEGATIVE CONTROL: plan-quality still raises create_file_already_exists for a target that genuinely exists", async () => {
    const root = makeRepo("tr21");
    const review = await reviewPlan({ projectRoot: root, plan: { steps: [{ action: "create_file", path: "notes/b.md", content: "# b\n" }] }, problemContent: null });
    expect(review.ok).toBe(false);
    expect(review.errors.find((e) => e.check === "create_file_already_exists")).toBeDefined();
  }, 60_000);

  it("[TR22] NEGATIVE CONTROL: cleanupWorkingTree keeps { cleaned, method, error } and its exclusions; createBackup keeps its stash exclusions", async () => {
    const root = makeRepo("tr22");
    expect(PROTECTED_PATHS).toEqual(["notes", ".rks", ".routekit"]);
    fs.writeFileSync(path.join(root, "notes", "b.md"), "tracked note edit\n");
    fs.writeFileSync(path.join(root, "notes", "untracked.md"), "untracked note\n");
    fs.writeFileSync(path.join(root, POLICY_REL), "routekit edit\n");
    fs.writeFileSync(path.join(root, "src", "app.mjs"), "// edit\n");
    const backup = createBackup(root, null);
    expect(backup.stashCreated).toBe(true);
    // The stash took src/ only; every protected path kept its edits.
    expect(readText(root, "src/app.mjs")).toBe("// committed\n");
    expect(readText(root, "notes/b.md")).toBe("tracked note edit\n");
    expect(readText(root, "notes/untracked.md")).toBe("untracked note\n");
    expect(readText(root, POLICY_REL)).toBe("routekit edit\n");

    fs.writeFileSync(path.join(root, "src", "app.mjs"), "// edit again\n");
    fs.writeFileSync(path.join(root, "stray.txt"), "x\n");
    const ok = cleanupWorkingTree(root);
    expect(ok).toMatchObject({ cleaned: true, method: "git-checkout+clean" });
    expect(readText(root, "src/app.mjs")).toBe("// committed\n");
    expect(exists(root, "stray.txt")).toBe(false);
    expect(readText(root, "notes/b.md")).toBe("tracked note edit\n");
    expect(readText(root, "notes/untracked.md")).toBe("untracked note\n");
    expect(readText(root, POLICY_REL)).toBe("routekit edit\n");

    const bare = makeTempDir("orphans-cleanup-fail");
    cleanup.push(bare);
    const failed = cleanupWorkingTree(bare);
    expect(Object.keys(failed).sort()).toEqual(["cleaned", "error", "method"]);
    expect(failed.cleaned).toBe(false);
  }, 60_000);
});

// ── Fix-plan path ────────────────────────────────────────────────────────────
describe("write record — applyFixPlan", () => {
  it("[TR26] FIX PLAN: applyFixPlan records a pre-image entry in the SAME record before each write, and the post-write hash after", async () => {
    const root = makeRepo("tr26");
    const runDir = writePlan(root, "tr26", []);
    const steps = [
      { action: "create_file", path: "notes/fa.md", content: "# fa\n" },
      { action: "edit_file", path: "notes/b.md", content: "# b\n\nfix body\n" },
      { action: "edit_file", path: "notes/fn.mjs", scope: "function", targetId: "foo", content: "function foo() {\n  return 9;\n}" },
      { action: "search_replace", path: "notes/c.md", edits: [{ search: "gamma", replace: "GAMMA" }] },
      { action: "delete_file", path: "notes/d.md" },
    ];
    const watch = watchWrites(root, runDir, steps.map((s) => s.path));
    let res;
    try {
      res = await applyFixPlan({ projectId: "orphans", projectRoot: root, plan: { steps }, runDir, attemptNumber: 2 });
    } finally {
      watch.restore();
    }
    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect(watch.seen["notes/fa.md"]).toMatchObject({ existed: false, postHash: null });
    expect(watch.seen["notes/b.md"]).toMatchObject({ existed: true, preImageHash: sha(Buffer.from(B_COMMITTED)), postExists: null });
    expect(watch.seen["notes/fn.mjs"]).toMatchObject({ existed: true, preImageHash: sha(Buffer.from(FN_COMMITTED)), postExists: null });
    expect(watch.seen["notes/c.md"]).toMatchObject({ existed: true, preImageHash: sha(Buffer.from(C_COMMITTED)), postExists: null });
    expect(watch.seen["notes/d.md"]).toMatchObject({ existed: true, preImageHash: sha(Buffer.from(D_COMMITTED)), postExists: null });
    expect(entryFor(runDir, "notes/fa.md").postHash).toBe(sha(read(root, "notes/fa.md")));
    expect(entryFor(runDir, "notes/b.md").postHash).toBe(sha(read(root, "notes/b.md")));
    expect(entryFor(runDir, "notes/fn.mjs").postHash).toBe(sha(read(root, "notes/fn.mjs")));
    expect(entryFor(runDir, "notes/c.md").postHash).toBe(sha(read(root, "notes/c.md")));
    expect(entryFor(runDir, "notes/d.md")).toMatchObject({ postExists: false, postHash: null });
    expect(preImageBytes(runDir, entryFor(runDir, "notes/d.md")).toString("utf8")).toBe(D_COMMITTED);
    // Same record file runApplyTool writes.
    expect(fs.existsSync(path.join(runDir, "apply", "write-record.json"))).toBe(true);
  }, 60_000);

  it("[TR27] FIX PLAN: initial plan wrote nothing under notes/; fix-a created and fix-b edited are reverted, leftBehind empty, cleaned true", async () => {
    const root = makeRepo("tr27");
    const { runDir, res } = await apply(root, "tr27", [{ action: "edit_file", path: "src/app.mjs", content: "// plan\n", title: "e" }]);
    expect(res.ok).toBe(true);
    fs.writeFileSync(path.join(root, "notes", "fix-b.md"), "# fix-b pre-run\n");
    const fixBBefore = read(root, "notes/fix-b.md");
    const fix = await applyFixPlan({ projectId: "orphans", projectRoot: root, runDir, attemptNumber: 2, plan: { steps: [
      { action: "create_file", path: "notes/fix-a.md", content: "# fix-a\n" },
      { action: "edit_file", path: "notes/fix-b.md", content: "# fix-b fixed\n" },
    ] } });
    expect(fix.ok).toBe(true);
    const rb = await doRollback(root, runDir);
    expect(exists(root, "notes/fix-a.md")).toBe(false);
    expect(read(root, "notes/fix-b.md").equals(fixBBefore)).toBe(true);
    expect(rb.leftBehind).toEqual([]);
    expect(rb.cleaned).toBe(true);
    expect(deriveRolledBack(rb)).toBe(true);
  }, 60_000);

  it("[TR28] FIX PLAN: initial plan's pre-image is kept across a fix-plan re-edit; rollback restores pre-run bytes", async () => {
    const root = makeRepo("tr28");
    const { runDir } = await apply(root, "tr28", [{ action: "edit_file", path: "notes/c.md", content: "# c\n\ninitial plan output\n", title: "e" }]);
    const fix = await applyFixPlan({ projectId: "orphans", projectRoot: root, runDir, attemptNumber: 2, plan: { steps: [
      { action: "search_replace", path: "notes/c.md", edits: [{ search: "initial plan output", replace: "fix plan output" }] },
    ] } });
    expect(fix.ok).toBe(true);
    const e = entryFor(runDir, "notes/c.md");
    expect(e.preImageHash).toBe(sha(Buffer.from(C_COMMITTED)));
    expect(e.postHash).toBe(sha(Buffer.from("# c\n\nfix plan output\n")));
    await doRollback(root, runDir);
    expect(readText(root, "notes/c.md")).toBe(C_COMMITTED);
  }, 60_000);

  it("[TR29] FIX PLAN: a file the initial plan created stays existed:false after a fix-plan edit, and rollback deletes it", async () => {
    const root = makeRepo("tr29");
    const { runDir } = await apply(root, "tr29", [{ action: "create_file", path: "notes/dd.md", content: "# dd v1\n", title: "c" }]);
    const fix = await applyFixPlan({ projectId: "orphans", projectRoot: root, runDir, attemptNumber: 2, plan: { steps: [
      { action: "edit_file", path: "notes/dd.md", content: "# dd v2\n" },
    ] } });
    expect(fix.ok).toBe(true);
    expect(entryFor(runDir, "notes/dd.md")).toMatchObject({ existed: false, postHash: sha(Buffer.from("# dd v2\n")) });
    const rb = await doRollback(root, runDir);
    expect(exists(root, "notes/dd.md")).toBe(false);
    expect(rb.leftBehind).toEqual([]);
  }, 60_000);

  it("[TR30] FIX PLAN: a write made before a later step threw (ok false, appliedFiles not merged) is still recorded and reverted", async () => {
    const root = makeRepo("tr30");
    const runDir = writePlan(root, "tr30", []);
    const fix = await applyFixPlan({ projectId: "orphans", projectRoot: root, runDir, attemptNumber: 2, plan: { steps: [
      { action: "create_file", path: "notes/p.md", content: "# p\n" },
      { action: "search_replace", path: "notes/c.md", edits: [{ search: "no such text", replace: "x" }] },
    ] } });
    expect(fix.ok).toBe(false);
    expect(exists(root, "notes/p.md")).toBe(true);
    expect(entryFor(runDir, "notes/p.md")).toMatchObject({ existed: false, postExists: true });
    const rb = await doRollback(root, runDir);
    expect(exists(root, "notes/p.md")).toBe(false);
    expect(readText(root, "notes/c.md")).toBe(C_COMMITTED);
    expect(rb.leftBehind).toEqual([]);
  }, 60_000);

  it("[TR31] NEGATIVE CONTROL: a fix-plan-written file changed after the fix plan wrote it is not touched, leftBehind, cleaned false, rolledBack false", async () => {
    const root = makeRepo("tr31");
    const runDir = writePlan(root, "tr31", []);
    const fix = await applyFixPlan({ projectId: "orphans", projectRoot: root, runDir, attemptNumber: 2, plan: { steps: [
      { action: "create_file", path: "notes/q.md", content: "# q\n" },
    ] } });
    expect(fix.ok).toBe(true);
    fs.writeFileSync(path.join(root, "notes", "q.md"), "# q changed later\n");
    const rb = await doRollback(root, runDir);
    expect(readText(root, "notes/q.md")).toBe("# q changed later\n");
    expect(rb.leftBehind.map((l) => l.path)).toEqual(["notes/q.md"]);
    expect(rb.cleaned).toBe(false);
    expect(deriveRolledBack(rb)).toBe(false);
  }, 60_000);

  it("[TR32] runApplyTool and applyFixPlan record through one shared helper exported from a module other than exec.mjs", () => {
    const exec = SRC("server/exec.mjs");
    const fixPlanner = SRC("server/fix-planner.mjs");
    const backup = SRC("exec/backup.mjs");
    expect(backup).toMatch(/export function recordPlanPreImage\(/);
    expect(backup).toMatch(/export function recordPlanPostWrite\(/);
    const importRe = /import \{[^}]*\brecordPlanPreImage\b[^}]*\brecordPlanPostWrite\b[^}]*\} from "\.\.\/exec\/backup\.mjs"/;
    expect(exec).toMatch(importRe);
    expect(fixPlanner).toMatch(importRe);
    for (const src of [exec, fixPlanner]) {
      expect(src).not.toMatch(/function recordPlanPreImage|function recordPlanPostWrite/);
      expect(src).not.toMatch(/write-record\.json/);
    }
    expect(fixPlanner).not.toMatch(/createHash/);
    // Called at every plan-target write in both apply paths: create, edit (file + function), delete, search_replace.
    expect((fixPlanner.match(/recordBefore\(\);/g) || []).length).toBe(5);
    expect((fixPlanner.match(/recordAfter\(\);/g) || []).length).toBe(5);
    const apply = exec.slice(exec.indexOf("async function runApplyTool("));
    expect((apply.match(/recordBefore\(\);/g) || []).length).toBe(5);
    expect((apply.match(/recordAfter\(\);/g) || []).length).toBe(5);
    // backup.mjs imports nothing from server/ (no cycle).
    expect(backup).not.toMatch(/from "\.\.\/server\//);
  });
});
