/**
 * backlog.fix.exec-write-record-hardening
 * Root containment of plan / fix-plan targets (one shared resolvePlanTarget helper),
 * lstat parity in the record helpers, postError on a failed post-write hash, and
 * createdDirs capture + empty created-dir removal on revert.
 *
 * Record-level and helper-level tests use a bare temp root. The runApplyTool / applyFixPlan tests
 * use the temp-git-repo harness of tests/integration/exec-rollback-orphans-created-files.test.mjs:
 * a temp repo on `staging` (tests/helpers/tmp.mjs, outside any real repository), loadContext mocked
 * so projects/index.jsonl is never touched, embedScopedFiles and guardrailsOff/On stubbed. Every
 * spawnSync in this file passes an explicit timeout.
 *
 * testRequirement -> test: each `it` title begins with [Hn], n = the story's nth testRequirement.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";
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

const {
  resolvePlanTarget,
  beginWriteRecordAttempt,
  readWriteRecord,
  writeRecordPath,
  recordPlanPreImage,
  recordPlanPostWrite,
  revertPlanWrites,
  PRE_IMAGE_RELATIVE_DIR,
} = await import("../../packages/mcp-rks/src/exec/backup.mjs");
const { runApplyTool } = await import("../../packages/mcp-rks/src/server/exec.mjs");
const { applyFixPlan } = await import("../../packages/mcp-rks/src/server/fix-planner.mjs");

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const sha = (buf) => createHash("sha256").update(buf).digest("hex");
const entriesOf = (runDir) => readWriteRecord(runDir)?.record?.entries ?? [];
const entryFor = (runDir, target) => entriesOf(runDir).find((e) => e.target === target);

const GIT_TIMEOUT = 15_000;
const git = (cwd, args) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout: GIT_TIMEOUT });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
};

let root;
let runDir;
let outside;
const extraCleanup = [];
let errSpy;
let warnSpy;

beforeEach(() => {
  h.root = null;
  root = makeTempDir("wr-harden-root-");
  outside = makeTempDir("wr-harden-outside-");
  runDir = path.join(root, ".rks", "runs", "r1");
  fs.mkdirSync(runDir, { recursive: true });
  fs.mkdirSync(path.join(root, "notes"), { recursive: true });
  beginWriteRecordAttempt(runDir, { attemptId: "A1" });
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  errSpy?.mockRestore();
  warnSpy?.mockRestore();
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
  for (const p of extraCleanup.splice(0)) {
    try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

/** Turn the per-test root into a committed git repo on `staging` and point loadContext at it. */
function makeRepo() {
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "notes", "b.md"), "# b\n");
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

function writePlan(label, steps) {
  const dir = path.join(root, ".rks", "runs", `2026-11-08T00-00-00-000Z_${label}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "plan.json"), JSON.stringify({ slug: label, status: "executable", steps }, null, 2));
  fs.writeFileSync(path.join(dir, "run.json"), JSON.stringify({ projectId: "harden", timestamps: {}, telemetry: { outcome: "planned" } }));
  return dir;
}

/** Run runApplyTool (forced: its own write-record attempt) and return { runDir, res, err }. */
async function apply(label, steps) {
  const dir = writePlan(label, steps);
  let res = null;
  let err = null;
  try {
    res = await runApplyTool({ projectId: "harden", label, force: true });
  } catch (e) {
    err = e;
  }
  return { runDir: dir, res, err };
}

/** Run applyFixPlan into a fresh run directory and return { runDir, res }. */
async function fix(label, steps) {
  const dir = writePlan(label, []);
  const res = await applyFixPlan({ projectId: "harden", projectRoot: root, plan: { steps }, runDir: dir, attemptNumber: 2 });
  return { runDir: dir, res };
}

/** Edit the persisted write record in place (hand-seeding). */
function editRecord(dir, mutate) {
  const file = writeRecordPath(dir);
  const record = JSON.parse(fs.readFileSync(file, "utf8"));
  mutate(record);
  fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
}

const escRe = (s) => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));

describe("resolvePlanTarget", () => {
  it("[H1] returns path.resolve(root, target) for an in-root target with missing parents", () => {
    expect(resolvePlanTarget(root, "notes/sub/a.md")).toBe(path.resolve(root, "notes/sub/a.md"));
  });

  it("[H2] throws for ../ escape and names the target", () => {
    expect(() => resolvePlanTarget(root, "../outside.md")).toThrow(/\.\.\/outside\.md/);
  });

  it("[H3] throws for absolute targets outside and inside the root", () => {
    const abs1 = path.join(outside, "x.md");
    const abs2 = path.join(root, "notes", "x.md");
    expect(() => resolvePlanTarget(root, abs1)).toThrow(abs1);
    expect(() => resolvePlanTarget(root, abs2)).toThrow(abs2);
  });

  it("[H4] throws for a target through a symlinked ancestor that leaves the root", () => {
    fs.symlinkSync(outside, path.join(root, "notes", "link"), "dir");
    expect(() => resolvePlanTarget(root, "notes/link/x.md")).toThrow(/notes\/link\/x\.md/);
  });

  it("[H5] accepts an in-root target when projectRoot is reached through a symlink", () => {
    const alias = path.join(os.tmpdir(), `wr-harden-alias-${process.pid}-${Date.now()}`);
    fs.symlinkSync(root, alias, "dir");
    try {
      expect(resolvePlanTarget(alias, "notes/a.md")).toBe(path.resolve(alias, "notes/a.md"));
    } finally {
      fs.rmSync(alias, { force: true });
    }
  });
});

describe("record helpers refuse escaping, absolute and symlink targets", () => {
  it("[H10] recordPlanPreImage throws for ../ and absolute targets and records nothing", () => {
    expect(() => recordPlanPreImage(root, runDir, "../outside.md")).toThrow(/\.\.\/outside\.md/);
    const abs = path.join(outside, "x.md");
    expect(() => recordPlanPreImage(root, runDir, abs)).toThrow(abs);
    expect(entriesOf(runDir)).toHaveLength(0);
  });

  it("[H11] recordPlanPostWrite throws for ../ and absolute targets and leaves the record unchanged", () => {
    const before = fs.readFileSync(writeRecordPath(runDir), "utf8");
    expect(() => recordPlanPostWrite(root, runDir, "../outside.md")).toThrow(/\.\.\/outside\.md/);
    expect(() => recordPlanPostWrite(root, runDir, path.join(outside, "x.md"))).toThrow();
    expect(fs.readFileSync(writeRecordPath(runDir), "utf8")).toBe(before);
  });

  it("[H14] recordPlanPreImage refuses a symlink target and names it", () => {
    fs.writeFileSync(path.join(root, "notes", "real.md"), "real\n");
    fs.symlinkSync(path.join(root, "notes", "real.md"), path.join(root, "notes", "ln.md"));
    expect(() => recordPlanPreImage(root, runDir, "notes/ln.md")).toThrow(/notes\/ln\.md/);
    expect(entriesOf(runDir).find((e) => e.target === "notes/ln.md")).toBeUndefined();
  });

  it("[H15] recordPlanPostWrite throws when the target path is a symlink, and names it", () => {
    fs.writeFileSync(path.join(root, "notes", "real.md"), "real\n");
    fs.writeFileSync(path.join(root, "notes", "ln.md"), "plain\n");
    recordPlanPreImage(root, runDir, "notes/ln.md");
    fs.rmSync(path.join(root, "notes", "ln.md"));
    fs.symlinkSync(path.join(root, "notes", "real.md"), path.join(root, "notes", "ln.md"));
    expect(() => recordPlanPostWrite(root, runDir, "notes/ln.md")).toThrow(/notes\/ln\.md/);
    expect(entryFor(runDir, "notes/ln.md").postHash).toBeNull();
  });
});

describe("postError on a failed post-write hash", () => {
  function failHashOf(rel, message) {
    const abs = path.resolve(root, rel);
    const orig = fs.readFileSync.bind(fs);
    return vi.spyOn(fs, "readFileSync").mockImplementation((p, ...rest) => {
      if (path.resolve(String(p)) === abs) throw new Error(message);
      return orig(p, ...rest);
    });
  }

  it("[H17] a read/hash failure after a successful write rethrows and persists postError and postRecordedAt", () => {
    recordPlanPreImage(root, runDir, "notes/pe.md");
    fs.writeFileSync(path.join(root, "notes", "pe.md"), "written\n");
    const spy = failHashOf("notes/pe.md", "EIO injected read failure");
    try {
      expect(() => recordPlanPostWrite(root, runDir, "notes/pe.md")).toThrow(/EIO injected read failure/);
    } finally {
      spy.mockRestore();
    }
    const e = entryFor(runDir, "notes/pe.md");
    expect(typeof e.postError).toBe("string");
    expect(e.postError).toContain("EIO injected read failure");
    expect(typeof e.postRecordedAt).toBe("string");
    expect(e.postRecordedAt.length).toBeGreaterThan(0);
    expect(e.postHash).toBeNull();
  });

  it("[H18] revert leaves a postError file untouched and reports the post-write recording failure", () => {
    recordPlanPreImage(root, runDir, "notes/pe.md");
    fs.writeFileSync(path.join(root, "notes", "pe.md"), "written\n");
    const spy = failHashOf("notes/pe.md", "EIO injected read failure");
    try {
      expect(() => recordPlanPostWrite(root, runDir, "notes/pe.md")).toThrow();
    } finally {
      spy.mockRestore();
    }
    const res = revertPlanWrites(root, runDir);
    expect(fs.readFileSync(path.join(root, "notes", "pe.md"), "utf8")).toBe("written\n");
    const lb = res.leftBehind.find((l) => l.path === "notes/pe.md");
    expect(lb).toBeDefined();
    expect(lb.reason).toMatch(/post-write hash recording failed/);
    expect(lb.reason).toContain("EIO injected read failure");
  });

  it("[H19] NEGATIVE CONTROL: postHash null and no postError still reports the no-post-write-hash reason", () => {
    recordPlanPreImage(root, runDir, "notes/np.md");
    fs.writeFileSync(path.join(root, "notes", "np.md"), "written\n");
    const res = revertPlanWrites(root, runDir);
    const lb = res.leftBehind.find((l) => l.path === "notes/np.md");
    expect(lb.reason).toMatch(/no post-write hash was recorded/);
    expect(lb.reason).not.toMatch(/post-write hash recording failed/);
    expect(fs.existsSync(path.join(root, "notes", "np.md"))).toBe(true);
  });
});

describe("createdDirs capture and revert", () => {
  it("[H20] records createdDirs deepest first, root-relative", () => {
    const e = recordPlanPreImage(root, runDir, "notes/x/y/z.md");
    expect(e.createdDirs).toEqual(["notes/x/y", "notes/x"]);
  });

  it("[H21] records an empty createdDirs when the parent exists", () => {
    const e = recordPlanPreImage(root, runDir, "notes/a.md");
    expect(e.createdDirs).toEqual([]);
  });

  it("[H24] revert at post-write state removes the created file and its created dirs, keeps notes/", () => {
    recordPlanPreImage(root, runDir, "notes/x/y/z.md");
    fs.mkdirSync(path.join(root, "notes", "x", "y"), { recursive: true });
    fs.writeFileSync(path.join(root, "notes", "x", "y", "z.md"), "z\n");
    recordPlanPostWrite(root, runDir, "notes/x/y/z.md");
    const res = revertPlanWrites(root, runDir);
    expect(fs.existsSync(path.join(root, "notes", "x"))).toBe(false);
    expect(fs.existsSync(path.join(root, "notes"))).toBe(true);
    expect(res.leftBehind).toEqual([]);
    expect(res.reverted).toEqual(["notes/x/y/z.md"]);
  });

  it("[H25] a created dir that is no longer empty is kept and not reported", () => {
    recordPlanPreImage(root, runDir, "notes/x/z.md");
    fs.mkdirSync(path.join(root, "notes", "x"), { recursive: true });
    fs.writeFileSync(path.join(root, "notes", "x", "z.md"), "z\n");
    recordPlanPostWrite(root, runDir, "notes/x/z.md");
    fs.writeFileSync(path.join(root, "notes", "x", "other.md"), "other\n");
    const res = revertPlanWrites(root, runDir);
    expect(fs.existsSync(path.join(root, "notes", "x", "z.md"))).toBe(false);
    expect(fs.readFileSync(path.join(root, "notes", "x", "other.md"), "utf8")).toBe("other\n");
    expect(res.leftBehind.find((l) => l.path === "notes/x")).toBeUndefined();
    expect(res.leftBehind).toEqual([]);
  });

  it("[H26] revert does not remove a createdDirs entry replaced by a symlink to a directory", () => {
    const referent = path.join(outside, "empty-referent");
    fs.mkdirSync(referent);
    recordPlanPreImage(root, runDir, "notes/q.md");
    fs.writeFileSync(path.join(root, "notes", "q.md"), "q\n");
    recordPlanPostWrite(root, runDir, "notes/q.md");
    fs.symlinkSync(referent, path.join(root, "notes", "sl"), "dir");
    editRecord(runDir, (r) => { r.entries.find((e) => e.target === "notes/q.md").createdDirs = ["notes/sl"]; });
    const res = revertPlanWrites(root, runDir);
    expect(fs.existsSync(path.join(root, "notes", "q.md"))).toBe(false);
    expect(fs.lstatSync(path.join(root, "notes", "sl")).isSymbolicLink()).toBe(true);
    expect(fs.statSync(referent).isDirectory()).toBe(true);
    expect(res.leftBehind).toEqual([]);
  });

  it("[H27] revert does not remove a hand-seeded createdDirs entry that resolves outside the project root", () => {
    const outDir = path.join(outside, "empty-out");
    fs.mkdirSync(outDir);
    recordPlanPreImage(root, runDir, "notes/q.md");
    fs.writeFileSync(path.join(root, "notes", "q.md"), "q\n");
    recordPlanPostWrite(root, runDir, "notes/q.md");
    editRecord(runDir, (r) => {
      r.entries.find((e) => e.target === "notes/q.md").createdDirs = [path.relative(root, outDir).split(path.sep).join("/"), outDir];
    });
    revertPlanWrites(root, runDir);
    expect(fs.existsSync(path.join(root, "notes", "q.md"))).toBe(false);
    expect(fs.statSync(outDir).isDirectory()).toBe(true);
  });

  it("[H28] reverting a file created inside a pre-existing empty directory keeps that directory", () => {
    fs.mkdirSync(path.join(root, "notes", "empty"));
    const e = recordPlanPreImage(root, runDir, "notes/empty/f.md");
    expect(e.createdDirs).toEqual([]);
    fs.writeFileSync(path.join(root, "notes", "empty", "f.md"), "f\n");
    recordPlanPostWrite(root, runDir, "notes/empty/f.md");
    const res = revertPlanWrites(root, runDir);
    expect(fs.existsSync(path.join(root, "notes", "empty", "f.md"))).toBe(false);
    expect(fs.statSync(path.join(root, "notes", "empty")).isDirectory()).toBe(true);
    expect(res.leftBehind).toEqual([]);
  });

  it("[H29] a hand-seeded prior-format record (no createdDirs, no postError) reverts as before", () => {
    const created = "notes/old-created.md";
    const edited = "notes/old-edited.md";
    const preBytes = Buffer.from("# edited before the run\n");
    const preHash = sha(preBytes);
    fs.mkdirSync(path.join(runDir, PRE_IMAGE_RELATIVE_DIR), { recursive: true });
    fs.writeFileSync(path.join(runDir, PRE_IMAGE_RELATIVE_DIR, preHash), preBytes);
    fs.writeFileSync(path.join(root, created), "plan created\n");
    fs.writeFileSync(path.join(root, edited), "plan edited\n");
    fs.writeFileSync(writeRecordPath(runDir), JSON.stringify({
      version: 1,
      attemptId: "A1",
      entries: [
        { target: created, existed: false, preImageHash: null, postExists: true, postHash: sha(Buffer.from("plan created\n")), source: "plan", attemptId: "A1" },
        { target: edited, existed: true, preImageHash: preHash, postExists: true, postHash: sha(Buffer.from("plan edited\n")), source: "plan", attemptId: "A1" },
      ],
    }));
    const res = revertPlanWrites(root, runDir);
    expect(fs.existsSync(path.join(root, created))).toBe(false);
    expect(fs.readFileSync(path.join(root, edited))).toEqual(preBytes);
    expect(res.reverted.sort()).toEqual([created, edited].sort());
    expect(res.leftBehind).toEqual([]);
    expect(fs.statSync(path.join(root, "notes")).isDirectory()).toBe(true);
  });
});

describe("runApplyTool and applyFixPlan containment and ordering", () => {
  it("[H6] runApplyTool refuses create_file ../outside.md: named error, no escaping file, no record entry", async () => {
    makeRepo();
    const escaping = path.resolve(root, "../outside.md");
    const { runDir: rd, res, err } = await apply("h6", [{ action: "create_file", path: "../outside.md", content: "x\n", title: "c" }]);
    try {
      expect(res).toBeNull();
      expect(err?.code).toBe(ErrorCode.InvalidParams);
      expect(err.message).toMatch(/refused/);
      expect(err.message).toMatch(/\.\.\/outside\.md/);
      expect(fs.existsSync(escaping)).toBe(false);
      expect(entryFor(rd, "../outside.md")).toBeUndefined();
      expect(entriesOf(rd)).toHaveLength(0);
    } finally {
      fs.rmSync(escaping, { force: true });
    }
  }, 60_000);

  it("[H7] runApplyTool refuses an absolute create_file target: named error, nothing at the path or at root-joined-path, no record entry", async () => {
    makeRepo();
    for (const abs of [path.join(outside, "abs.md"), path.join(root, "notes", "abs-in.md")]) {
      const { runDir: rd, res, err } = await apply(`h7-${path.basename(abs, ".md")}`, [{ action: "create_file", path: abs, content: "x\n", title: "c" }]);
      expect(res).toBeNull();
      expect(err?.code).toBe(ErrorCode.InvalidParams);
      expect(err.message).toMatch(/refused/);
      expect(err.message).toMatch(escRe(abs));
      expect(fs.existsSync(abs)).toBe(false);
      expect(fs.existsSync(path.join(root, abs))).toBe(false);
      expect(entriesOf(rd)).toHaveLength(0);
    }
  }, 60_000);

  it("[H8] runApplyTool refuses a target through an in-root symlinked dir pointing outside: outside gains no file, no record entry", async () => {
    makeRepo();
    fs.symlinkSync(outside, path.join(root, "notes", "link"), "dir");
    const { runDir: rd, res, err } = await apply("h8", [{ action: "create_file", path: "notes/link/x.md", content: "x\n", title: "c" }]);
    expect(res).toBeNull();
    expect(err?.code).toBe(ErrorCode.InvalidParams);
    expect(err.message).toMatch(/notes\/link\/x\.md/);
    expect(fs.readdirSync(outside)).toEqual([]);
    expect(entriesOf(rd)).toHaveLength(0);
  }, 60_000);

  it("[H9] applyFixPlan refuses ../, absolute and symlinked-ancestor targets: failure naming the target, nothing outside, no record entry", async () => {
    makeRepo();
    fs.symlinkSync(outside, path.join(root, "notes", "link"), "dir");
    const escaping = path.resolve(root, "../outside-fix.md");
    const absOut = path.join(outside, "abs-fix.md");
    const absIn = path.join(root, "notes", "abs-fix-in.md");
    try {
      for (const [i, target] of ["../outside-fix.md", absOut, absIn, "notes/link/fix.md"].entries()) {
        const { runDir: rd, res } = await fix(`h9-${i}`, [{ action: "create_file", path: target, content: "x\n" }]);
        expect(res.ok).toBe(false);
        expect(res.error).toMatch(/Fix plan step create_file refused:/);
        expect(res.error).toMatch(escRe(target));
        expect(res.appliedFiles).toEqual([]);
        expect(entriesOf(rd)).toHaveLength(0);
      }
      expect(fs.existsSync(escaping)).toBe(false);
      expect(fs.existsSync(absIn)).toBe(false);
      expect(fs.existsSync(path.join(root, absOut))).toBe(false);
      expect(fs.readdirSync(outside)).toEqual([]);
    } finally {
      fs.rmSync(escaping, { force: true });
    }
  }, 60_000);

  it("[H12] runApplyTool: the entry postHash equals the sha256 of the bytes at resolvePlanTarget(root, target), one shared resolver", async () => {
    makeRepo();
    const target = "notes/p/q.md";
    const { runDir: rd, res, err } = await apply("h12", [{ action: "create_file", path: target, content: "# parity\n", title: "c" }]);
    expect(err, String(err)).toBeNull();
    expect(res.ok).toBe(true);
    const onDisk = fs.readFileSync(resolvePlanTarget(root, target));
    expect(entryFor(rd, target).postHash).toBe(sha(onDisk));
    // AC4: both writers take their write path from the shared helper, not a local join.
    for (const rel of ["packages/mcp-rks/src/server/exec.mjs", "packages/mcp-rks/src/server/fix-planner.mjs"]) {
      const src = fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
      expect(src).toMatch(/absPath = resolvePlanTarget\(projectRoot, target\);/);
    }
  }, 60_000);

  it("[H13] exec.mjs and fix-planner.mjs import resolvePlanTarget and no longer join projectRoot with target", () => {
    for (const rel of ["packages/mcp-rks/src/server/exec.mjs", "packages/mcp-rks/src/server/fix-planner.mjs"]) {
      const src = fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
      expect(src).toMatch(/import \{[^}]*\bresolvePlanTarget\b[^}]*\} from "\.\.\/exec\/backup\.mjs"/);
      expect(src).not.toContain("path.join(projectRoot, target)");
    }
  });

  it("[H16] runApplyTool refuses a file step whose target is a pre-existing symlink; the referent keeps its exact bytes", async () => {
    makeRepo();
    const referent = path.join(root, "notes", "real.md");
    const original = Buffer.from("# real\n\noriginal bytes\n");
    fs.writeFileSync(referent, original);
    fs.symlinkSync(referent, path.join(root, "notes", "ln.md"));
    for (const [i, step] of [
      { action: "edit_file", path: "notes/ln.md", content: "# overwritten\n", title: "e" },
      { action: "create_file", path: "notes/ln.md", content: "# overwritten\n", title: "c" },
      { action: "search_replace", path: "notes/ln.md", edits: [{ search: "original", replace: "CHANGED" }], title: "sr" },
    ].entries()) {
      const { runDir: rd, res, err } = await apply(`h16-${i}`, [step]);
      expect(res).toBeNull();
      expect(err.message).toMatch(/notes\/ln\.md/);
      expect(fs.readFileSync(referent)).toEqual(original);
      expect(entryFor(rd, "notes/ln.md")).toBeUndefined();
    }
  }, 60_000);

  it("[H22] runApplyTool: create_file under new nested dirs records a non-empty createdDirs (record precedes mkdir)", async () => {
    makeRepo();
    const { runDir: rd, res, err } = await apply("h22", [{ action: "create_file", path: "notes/n1/n2/f.md", content: "f\n", title: "c" }]);
    expect(err, String(err)).toBeNull();
    expect(res.ok).toBe(true);
    expect(entryFor(rd, "notes/n1/n2/f.md").createdDirs).toEqual(["notes/n1/n2", "notes/n1"]);
  }, 60_000);

  it("[H23] applyFixPlan: create_file under new nested dirs records a non-empty createdDirs (recordBefore precedes ensureDir)", async () => {
    makeRepo();
    const { runDir: rd, res } = await fix("h23", [{ action: "create_file", path: "notes/f1/f2/f.md", content: "f\n" }]);
    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect(entryFor(rd, "notes/f1/f2/f.md").createdDirs).toEqual(["notes/f1/f2", "notes/f1"]);
  }, 60_000);
});

describe("[process]", () => {
  it("[H30] [process] the regression witness files exist and are listed as story testFiles (they run in the same gate)", () => {
    for (const rel of [
      "tests/integration/exec-write-record-attempt-scope.test.mjs",
      "tests/integration/exec-rollback-orphans-created-files.test.mjs",
      "tests/unit/step-apply-create-file.test.mjs",
      "tests/unit/fix-planner.test.mjs",
    ]) {
      expect(fs.existsSync(path.join(REPO_ROOT, rel)), rel).toBe(true);
    }
  });

  it("[H31] [process] every spawnSync call in this file passes an explicit timeout", () => {
    const self = fs.readFileSync(new URL(import.meta.url), "utf8");
    const calls = self.split("\n").filter((l) => /spawnSync\("/.test(l));
    expect(calls.length).toBeGreaterThan(0);
    for (const line of calls) expect(line).toMatch(/timeout:/);
  });
});
