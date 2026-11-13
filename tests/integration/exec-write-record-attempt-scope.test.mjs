/**
 * backlog.fix.exec-write-record-attempt-scope
 *
 * The plan write record (apply/write-record.json + apply/pre-images) is scoped to ONE exec
 * attempt: beginWriteRecordAttempt rotates the previous attempt aside (never deletes), entries
 * carry attemptId, and revertPlanWrites never touches another attempt's entry. The exec_threw
 * path carries the rollback outcome on the thrown error, and two messages follow the derived
 * rolledBack flag.
 *
 * Real modules: exec.mjs, fix-planner.mjs, test-runner.mjs, backup.mjs. Real git in a temp repo
 * (tests/helpers/tmp.mjs). loadContext (server/project.mjs) is mocked so projects/index.jsonl is
 * never touched; embedScopedFiles and guardrailsOff/On are stubbed (collaborators, not under test).
 * rollback is WRAPPED in a delegating vi.fn: every call reaches the real function unless a test
 * queues a one-off implementation.
 *
 * testRequirement -> test: each `it` title starts with the [WRn] tag it covers.
 * [process] Every spawnSync in this file, and in the fixture scripts it writes, passes timeout: GIT_TIMEOUT.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { makeTempDir } from "../helpers/tmp.mjs";
import { parseFrontmatter } from "../../packages/mcp-rks/src/shared/frontmatter.mjs";
import { noteSubjectDigest } from "../../packages/mcp-rks/src/workflow/arch-verdict.mjs";

const GIT_TIMEOUT = 15_000;
const h = vi.hoisted(() => ({ root: null, rollbacks: [] }));

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

const { runApplyTool, runExecTool, recoverExecFailure } = await import("../../packages/mcp-rks/src/server/exec.mjs");
const { applyFixPlan } = await import("../../packages/mcp-rks/src/server/fix-planner.mjs");
const { rollback, deriveRolledBack, rollbackRecoveryGuidance } = await import("../../packages/mcp-rks/src/server/test-runner.mjs");
const {
  beginWriteRecordAttempt,
  recordPlanPreImage,
  recordPlanPostWrite,
  revertPlanWrites,
  readWriteRecord,
  writeRecordPath,
  WRITE_RECORD_RELATIVE_PATH,
  PRE_IMAGE_RELATIVE_DIR,
} = await import("../../packages/mcp-rks/src/exec/backup.mjs");

const sha = (buf) => createHash("sha256").update(buf).digest("hex");
const git = (cwd, args) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout: GIT_TIMEOUT });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
};

// ── Fixture ─────────────────────────────────────────────────────────────────
const POLICY_REL = ".routekit/command-policy.yaml";
const SCRIPT_NAMES = ["stray.mjs", "touch-y.mjs", "touch-a.mjs", "stage-hook.mjs", "widen.mjs", "widen-leave.mjs"];
const BASE_POLICY = [
  "command_policy:",
  `  auto_execute: [${SCRIPT_NAMES.map((n) => JSON.stringify(`node ${n}`)).join(", ")}]`,
  '  execute_with_plan_approval: ["git add", "git commit"]',
  '  require_explicit_confirmation: ["rm"]',
  "",
].join("\n");
const WIDE_POLICY = BASE_POLICY.replace('"node stray.mjs"', '"node stray.mjs", "node evil.mjs"');
const spawnLine = (args) => `spawnSync("git", ${JSON.stringify(args)}, { timeout: ${GIT_TIMEOUT}, stdio: "ignore" });`;
const SCRIPTS = {
  // A file outside the plan's scope: exec fails with a scope violation AFTER apply.
  "stray.mjs": 'import fs from "node:fs";\nfs.writeFileSync("stray.txt", "stray\\n");\n',
  // Changes the plan-created notes/y.md after the plan wrote it (so rollback leaves it), then strays.
  "touch-y.mjs": 'import fs from "node:fs";\nfs.appendFileSync("notes/y.md", "changed after the plan\\n");\nfs.writeFileSync("stray.txt", "stray\\n");\n',
  // Changes the plan-created notes/a.md after the plan wrote it, nothing else.
  "touch-a.mjs": 'import fs from "node:fs";\nfs.appendFileSync("notes/a.md", "changed after the plan\\n");\n',
  "stage-hook.mjs": [
    'import fs from "node:fs";',
    'import { spawnSync } from "node:child_process";',
    'fs.mkdirSync(".routekit/hooks", { recursive: true });',
    'fs.writeFileSync(".routekit/hooks/x.mjs", "export default 1;\\n");',
    spawnLine(["add", ".routekit/hooks/x.mjs"]),
    "",
  ].join("\n"),
  "widen.mjs": `import fs from "node:fs";\nfs.writeFileSync(${JSON.stringify(POLICY_REL)}, ${JSON.stringify(WIDE_POLICY)});\n`,
  // Widens the policy AND, as a plan write would, records a protected file in THIS attempt's write
  // record, then leaves that file holding bytes that match neither its pre-run state nor its
  // post-write hash. rollback therefore leaves notes/pc.md behind.
  "widen-leave.mjs": [
    'import fs from "node:fs";',
    'import path from "node:path";',
    `fs.writeFileSync(${JSON.stringify(POLICY_REL)}, ${JSON.stringify(WIDE_POLICY)});`,
    'const runs = fs.readdirSync(path.join(".rks", "runs"));',
    'const file = path.join(".rks", "runs", runs[0], "apply", "write-record.json");',
    'const rec = JSON.parse(fs.readFileSync(file, "utf8"));',
    'fs.mkdirSync("notes", { recursive: true });',
    'fs.writeFileSync(path.join("notes", "pc.md"), "changed after the write\\n");',
    'rec.entries.push({ target: "notes/pc.md", existed: false, preImageHash: null, postExists: true, postHash: "0".repeat(64), source: "plan", attemptId: rec.attemptId });',
    "fs.writeFileSync(file, JSON.stringify(rec));",
    "",
  ].join("\n"),
};

const STORY = "backlog.fix.wr-attempt-fixture";
const B_COMMITTED = "# b\n\ncommitted body\n";
const P1 = "# x\n\nP1 pre-run bytes\n";
const cleanup = [];

function storyNote(preCommands) {
  if (!preCommands) return `---\nid: "${STORY}"\ntitle: "fixture"\nphase: "executing"\n---\n\nbody\n`;
  // Exec runs preCommands only under a gated, unchanged ARCH approval (arch_subject over the note).
  const note = `---\nid: "${STORY}"\ntitle: "fixture"\nphase: "executing"\npreCommands: ${JSON.stringify(preCommands)}\n---\n\nbody\n`;
  const subject = noteSubjectDigest(parseFrontmatter(note));
  return note.replace("\n---\n\nbody", `\narch_verdict: "approved"\narch_subject: "${subject}"\narch_subject_version: "2"\n---\n\nbody`);
}

function makeRepo(tag, { preCommands = null } = {}) {
  const root = makeTempDir(`wr-attempt-${tag}`);
  cleanup.push(root);
  fs.mkdirSync(path.join(root, ".routekit"), { recursive: true });
  fs.mkdirSync(path.join(root, "notes"), { recursive: true });
  fs.writeFileSync(path.join(root, POLICY_REL), BASE_POLICY);
  for (const [name, text] of Object.entries(SCRIPTS)) fs.writeFileSync(path.join(root, name), text);
  fs.writeFileSync(path.join(root, "notes", "b.md"), B_COMMITTED);
  fs.writeFileSync(path.join(root, "notes", "x.md"), P1);
  fs.writeFileSync(path.join(root, "notes", `${STORY}.md`), storyNote(preCommands));
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
  fs.writeFileSync(path.join(runDir, "run.json"), JSON.stringify({ projectId: "wr", timestamps: {}, telemetry: { outcome: "planned" } }));
  return runDir;
}

/** A bare project root + run directory (no git) for direct backup.mjs tests. */
function makeRunDir(tag) {
  const root = makeTempDir(`wr-attempt-unit-${tag}`);
  cleanup.push(root);
  fs.mkdirSync(path.join(root, "notes"), { recursive: true });
  const runDir = path.join(root, ".rks", "runs", "r1");
  fs.mkdirSync(runDir, { recursive: true });
  return { root, runDir };
}

const readText = (root, rel) => fs.readFileSync(path.join(root, rel), "utf8");
const exists = (p) => fs.existsSync(p);
const attemptsDir = (runDir) => path.join(runDir, "apply", "attempts");
const listAttempts = (runDir) => (exists(attemptsDir(runDir)) ? fs.readdirSync(attemptsDir(runDir)).sort() : []);
const recordOf = (runDir) => {
  const r = readWriteRecord(runDir);
  if (r.status !== "ok") throw new Error(`record ${r.status}`);
  return r.record;
};
const entryFor = (runDir, target) => recordOf(runDir).entries.find((e) => e.target === target);
/** Snapshot every file under dir as { relPath: Buffer }. */
function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const name of fs.readdirSync(d)) {
      const p = path.join(d, name);
      if (fs.statSync(p).isDirectory()) walk(p);
      else out[path.relative(dir, p)] = fs.readFileSync(p);
    }
  };
  if (exists(dir)) walk(dir);
  return out;
}
const phaseOf = (root) => /phase:\s*"?([\w-]+)"?/.exec(readText(root, `notes/${STORY}.md`))[1];
const rksBranches = (root) => git(root, ["branch", "--list", "rks/*"]).trim();
const ROLLBACK_FIELDS = ["rolledBack", "leftBehind", "recovery", "partialDiffPath", "rollbackError"];
const region2Ctx = (root, runDir, extra = {}) => ({
  projectId: "wr",
  projectRoot: root,
  baseBranch: "staging",
  runDir,
  storyId: null,
  branchName: null,
  backupMeta: null,
  guardrailsSession: { ok: true },
  finalized: false,
  correlationId: null,
  ...extra,
});

let errSpy;
let warnSpy;
beforeEach(() => {
  h.root = null;
  h.rollbacks.length = 0;
  vi.mocked(rollback).mockClear();
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  errSpy?.mockRestore();
  warnSpy?.mockRestore();
  vi.useRealTimers();
  for (const p of cleanup.splice(0)) {
    try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

describe("beginWriteRecordAttempt", () => {
  it("[WR1] returns null and creates no apply/ directory when runDir is undefined, null or empty", () => {
    const cwdApply = path.join(process.cwd(), "apply");
    const before = exists(cwdApply);
    for (const runDir of [undefined, null, ""]) expect(beginWriteRecordAttempt(runDir, { attemptId: "a1" })).toBeNull();
    expect(exists(cwdApply)).toBe(before);
    expect(before).toBe(false);
  });

  it("[WR2] with no prior record writes a fresh attemptId-stamped record and returns rotatedTo null", () => {
    const { runDir } = makeRunDir("wr2");
    const res = beginWriteRecordAttempt(runDir, { attemptId: "att-2" });
    expect(res).toEqual({ attemptId: "att-2", rotatedTo: null });
    const rec = JSON.parse(fs.readFileSync(path.join(runDir, WRITE_RECORD_RELATIVE_PATH), "utf8"));
    expect(rec.version).toBe(1);
    expect(rec.attemptId).toBe("att-2");
    expect(typeof rec.startedAt).toBe("string");
    expect(new Date(rec.startedAt).toISOString()).toBe(rec.startedAt);
    expect(rec.entries).toEqual([]);
    expect(exists(attemptsDir(runDir))).toBe(false);
  });

  it("[WR3] moves a prior record and its pre-images into apply/attempts/<attemptId>/ byte-for-byte, deleting nothing", () => {
    const { root, runDir } = makeRunDir("wr3");
    fs.writeFileSync(path.join(root, "notes", "e1.md"), "one\n");
    fs.writeFileSync(path.join(root, "notes", "e2.md"), "two\n");
    beginWriteRecordAttempt(runDir, { attemptId: "A" });
    recordPlanPreImage(root, runDir, "notes/e1.md");
    recordPlanPreImage(root, runDir, "notes/e2.md");
    const recordBefore = fs.readFileSync(writeRecordPath(runDir));
    const preBefore = snapshot(path.join(runDir, PRE_IMAGE_RELATIVE_DIR));
    expect(Object.keys(preBefore)).toHaveLength(2);

    const res = beginWriteRecordAttempt(runDir, { attemptId: "B" });
    expect(res).toEqual({ attemptId: "B", rotatedTo: "apply/attempts/A" });
    const moved = path.join(runDir, "apply", "attempts", "A");
    expect(fs.readFileSync(path.join(moved, "write-record.json")).equals(recordBefore)).toBe(true);
    const preAfter = snapshot(path.join(moved, "pre-images"));
    expect(Object.keys(preAfter).sort()).toEqual(Object.keys(preBefore).sort());
    for (const k of Object.keys(preBefore)) expect(preAfter[k].equals(preBefore[k])).toBe(true);
    // The live store starts empty; the fresh record belongs to B.
    expect(exists(path.join(runDir, PRE_IMAGE_RELATIVE_DIR))).toBe(false);
    expect(recordOf(runDir)).toMatchObject({ attemptId: "B", entries: [] });
  });

  it("[WR4] labels an unstamped prior record pre-attempt-<ISO>, and suffixes a colliding label without touching the existing directory", () => {
    const { runDir } = makeRunDir("wr4");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-02T03:04:05.006Z"));
    // Unstamped record (the pre-fix shape) plus a pre-image.
    fs.mkdirSync(path.join(runDir, PRE_IMAGE_RELATIVE_DIR), { recursive: true });
    fs.writeFileSync(path.join(runDir, PRE_IMAGE_RELATIVE_DIR, "f".repeat(64)), "old bytes\n");
    fs.writeFileSync(writeRecordPath(runDir), JSON.stringify({ version: 1, entries: [] }));
    const recordBytes = fs.readFileSync(writeRecordPath(runDir));

    const label = "pre-attempt-2026-01-02T03-04-05-006Z";
    expect(label).not.toMatch(/:/);
    const existing = path.join(attemptsDir(runDir), label);
    fs.mkdirSync(existing, { recursive: true });
    fs.writeFileSync(path.join(existing, "sentinel.txt"), "keep me\n");
    const existingBefore = snapshot(existing);

    const res = beginWriteRecordAttempt(runDir, { attemptId: "C" });
    expect(res.rotatedTo).toBe(`apply/attempts/${label}-2`);
    expect(snapshot(existing)).toEqual(existingBefore);
    const moved = path.join(attemptsDir(runDir), `${label}-2`);
    expect(fs.readFileSync(path.join(moved, "write-record.json")).equals(recordBytes)).toBe(true);
    expect(fs.readFileSync(path.join(moved, "pre-images", "f".repeat(64)), "utf8")).toBe("old bytes\n");
    expect(recordOf(runDir).attemptId).toBe("C");
  });

  it("[WR5] throws when rotation cannot be performed and leaves the prior record and pre-images in place", () => {
    const { root, runDir } = makeRunDir("wr5");
    fs.writeFileSync(path.join(root, "notes", "e1.md"), "one\n");
    beginWriteRecordAttempt(runDir, { attemptId: "A" });
    recordPlanPreImage(root, runDir, "notes/e1.md");
    const recordBefore = fs.readFileSync(writeRecordPath(runDir));
    const preBefore = snapshot(path.join(runDir, PRE_IMAGE_RELATIVE_DIR));
    fs.writeFileSync(attemptsDir(runDir), "not a directory\n");

    expect(() => beginWriteRecordAttempt(runDir, { attemptId: "B" })).toThrow();
    expect(fs.readFileSync(writeRecordPath(runDir)).equals(recordBefore)).toBe(true);
    expect(snapshot(path.join(runDir, PRE_IMAGE_RELATIVE_DIR))).toEqual(preBefore);
    expect(Object.keys(preBefore)).toHaveLength(1);
  });

  it("[WR6] throws when the fresh record cannot be written", () => {
    const { runDir } = makeRunDir("wr6");
    // The atomic write goes through <record>.<pid>.tmp; a directory there makes the write fail.
    fs.mkdirSync(`${writeRecordPath(runDir)}.${process.pid}.tmp`, { recursive: true });
    expect(() => beginWriteRecordAttempt(runDir, { attemptId: "D" })).toThrow();
    expect(exists(writeRecordPath(runDir))).toBe(false);
  });
});

describe("attempt stamping and the cross-attempt guard", () => {
  it("[WR12] recordPlanPreImage stamps the record's attemptId on new entries, and null on an unstamped record", () => {
    const { root, runDir } = makeRunDir("wr12");
    fs.writeFileSync(path.join(root, "notes", "e1.md"), "one\n");
    beginWriteRecordAttempt(runDir, { attemptId: "S1" });
    expect(recordPlanPreImage(root, runDir, "notes/e1.md").attemptId).toBe("S1");
    expect(recordPlanPreImage(root, runDir, "notes/new.md").attemptId).toBe("S1");
    expect(recordOf(runDir).entries.map((e) => e.attemptId)).toEqual(["S1", "S1"]);

    const other = makeRunDir("wr12b");
    fs.writeFileSync(path.join(other.root, "notes", "e1.md"), "one\n");
    fs.mkdirSync(path.dirname(writeRecordPath(other.runDir)), { recursive: true });
    fs.writeFileSync(writeRecordPath(other.runDir), JSON.stringify({ version: 1, entries: [] }));
    const e = recordPlanPreImage(other.root, other.runDir, "notes/e1.md");
    expect(e).toHaveProperty("attemptId", null);
    expect(entryFor(other.runDir, "notes/e1.md").attemptId).toBeNull();
  });

  it("[WR13] within one attempt the first pre-image still wins", () => {
    const { root, runDir } = makeRunDir("wr13");
    fs.writeFileSync(path.join(root, "notes", "e1.md"), "original\n");
    beginWriteRecordAttempt(runDir, { attemptId: "S" });
    const first = recordPlanPreImage(root, runDir, "notes/e1.md");
    fs.writeFileSync(path.join(root, "notes", "e1.md"), "plan output\n");
    recordPlanPostWrite(root, runDir, "notes/e1.md");
    const second = recordPlanPreImage(root, runDir, "notes/e1.md", { source: "fix" });
    expect(second.preImageHash).toBe(first.preImageHash);
    expect(second.preImageHash).toBe(sha(Buffer.from("original\n")));
    expect(recordOf(runDir).entries).toHaveLength(1);
  });

  it("[WR14] revertPlanWrites never writes or deletes another attempt's entry and lists it in leftBehind naming both ids", () => {
    const { root, runDir } = makeRunDir("wr14");
    const pre = Buffer.from("pre-run\n");
    fs.mkdirSync(path.join(runDir, PRE_IMAGE_RELATIVE_DIR), { recursive: true });
    fs.writeFileSync(path.join(runDir, PRE_IMAGE_RELATIVE_DIR, sha(pre)), pre);
    fs.writeFileSync(path.join(root, "notes", "e.md"), "edited by attempt A\n");
    fs.writeFileSync(path.join(root, "notes", "c.md"), "created by attempt A\n");
    const record = {
      version: 1,
      attemptId: "B",
      entries: [
        { target: "notes/e.md", existed: true, preImageHash: sha(pre), postExists: true, postHash: sha(Buffer.from("edited by attempt A\n")), source: "plan", attemptId: "A" },
        { target: "notes/c.md", existed: false, preImageHash: null, postExists: true, postHash: sha(Buffer.from("created by attempt A\n")), source: "plan", attemptId: "A" },
      ],
    };
    fs.writeFileSync(writeRecordPath(runDir), JSON.stringify(record));

    const res = revertPlanWrites(root, runDir);
    expect(readText(root, "notes/e.md")).toBe("edited by attempt A\n");
    expect(readText(root, "notes/c.md")).toBe("created by attempt A\n");
    expect(res.reverted).toEqual([]);
    expect(res.leftBehind.map((l) => l.path).sort()).toEqual(["notes/c.md", "notes/e.md"]);
    for (const l of res.leftBehind) {
      expect(l.reason).toContain("A");
      expect(l.reason).toContain("B");
      expect(l.reason).toMatch(/exec attempt A, not the current attempt B/);
    }
  });

  it("[WR15] NEGATIVE CONTROL: an entry with attemptId null on a stamped record is still reverted", () => {
    const { root, runDir } = makeRunDir("wr15");
    const pre = Buffer.from("pre-run\n");
    fs.mkdirSync(path.join(runDir, PRE_IMAGE_RELATIVE_DIR), { recursive: true });
    fs.writeFileSync(path.join(runDir, PRE_IMAGE_RELATIVE_DIR, sha(pre)), pre);
    fs.writeFileSync(path.join(root, "notes", "e.md"), "plan wrote\n");
    fs.writeFileSync(path.join(root, "notes", "c.md"), "plan created\n");
    fs.writeFileSync(writeRecordPath(runDir), JSON.stringify({
      version: 1,
      attemptId: "B",
      entries: [
        { target: "notes/e.md", existed: true, preImageHash: sha(pre), postExists: true, postHash: sha(Buffer.from("plan wrote\n")), source: "plan", attemptId: null },
        { target: "notes/c.md", existed: false, preImageHash: null, postExists: true, postHash: sha(Buffer.from("plan created\n")), source: "plan", attemptId: null },
      ],
    }));
    const res = revertPlanWrites(root, runDir);
    expect(res.leftBehind).toEqual([]);
    expect(res.reverted.sort()).toEqual(["notes/c.md", "notes/e.md"]);
    expect(readText(root, "notes/e.md")).toBe("pre-run\n");
    expect(exists(path.join(root, "notes", "c.md"))).toBe(false);
  });
});

describe("call sites", () => {
  it("[WR7] a beginWriteRecordAttempt throw inside runExecTool writes no target, creates no rks/<slug> branch, runs no rollback, and resets the phase", async () => {
    const root = makeRepo("wr7");
    const runDir = writePlan(root, "wr7", [
      { action: "create_file", path: "notes/a.md", content: "# a\n", title: "create" },
      { action: "edit_file", path: "notes/b.md", content: "# b\n\nplan body\n", title: "edit" },
    ], { problemId: STORY });
    // A prior record to rotate, and apply/attempts as a regular file: the rotation cannot run.
    beginWriteRecordAttempt(runDir, { attemptId: "prior-7" });
    // An empty record is overwritten in place, not rotated (backlog.fix.exec-write-record-attempt-retention).
    recordPlanPreImage(root, runDir, "notes/x.md");
    fs.writeFileSync(attemptsDir(runDir), "not a directory\n");
    const bBefore = fs.readFileSync(path.join(root, "notes", "b.md"));
    expect(phaseOf(root)).toBe("executing");

    let thrown = null;
    try {
      await runExecTool({ projectId: "wr", label: "wr7", skipTests: true });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(exists(path.join(root, "notes", "a.md"))).toBe(false);
    expect(fs.readFileSync(path.join(root, "notes", "b.md")).equals(bBefore)).toBe(true);
    expect(rksBranches(root)).toBe("");
    expect(git(root, ["rev-parse", "--abbrev-ref", "HEAD"]).trim()).toBe("staging");
    expect(rollback).not.toHaveBeenCalled();
    for (const f of ["rolledBack", "leftBehind", "recovery"]) expect(Object.prototype.hasOwnProperty.call(thrown, f)).toBe(false);
    expect(phaseOf(root)).toBe("arch-approved");
    // The prior record was not touched by the failed rotation.
    expect(recordOf(runDir).attemptId).toBe("prior-7");
  }, 120_000);

  it("[WR8] one runExecTool call rotates exactly one prior attempt and leaves a fresh record with a new attemptId", async () => {
    const root = makeRepo("wr8");
    const runDir = writePlan(root, "wr8", [
      { action: "edit_file", path: "notes/b.md", content: "# b\n\nwr8 body\n", title: "edit" },
    ]);
    beginWriteRecordAttempt(runDir, { attemptId: "prior-8" });
    // An empty record is overwritten in place, not rotated (backlog.fix.exec-write-record-attempt-retention).
    recordPlanPreImage(root, runDir, "notes/x.md");
    const result = await runExecTool({ projectId: "wr", label: "wr8", skipTests: true });
    expect(result.status, JSON.stringify(result)).toBe("pending_ship");
    expect(listAttempts(runDir)).toEqual(["prior-8"]);
    const rec = recordOf(runDir);
    expect(typeof rec.attemptId).toBe("string");
    expect(rec.attemptId).not.toBe("prior-8");
    expect(entryFor(runDir, "notes/b.md").attemptId).toBe(rec.attemptId);
  }, 120_000);

  it("[WR9] forced runApplyTool rotates a prior record before its first write; new entries carry the fresh attemptId", async () => {
    const root = makeRepo("wr9");
    const runDir = writePlan(root, "wr9", [
      { action: "edit_file", path: "notes/b.md", content: "# b\n\nwr9 body\n", title: "edit" },
      { action: "create_file", path: "notes/n9.md", content: "# n9\n", title: "create" },
    ]);
    beginWriteRecordAttempt(runDir, { attemptId: "prior-9" });
    recordPlanPreImage(root, runDir, "notes/x.md");
    const movedRecord = path.join(attemptsDir(runDir), "prior-9", "write-record.json");

    // At the first write of a plan target, the prior record must already be rotated.
    const targetAbs = path.join(root, "notes", "b.md");
    let rotatedAtFirstWrite = null;
    const origWrite = fs.writeFileSync.bind(fs);
    const spy = vi.spyOn(fs, "writeFileSync").mockImplementation((p, ...rest) => {
      if (rotatedAtFirstWrite === null && path.resolve(String(p)) === targetAbs) rotatedAtFirstWrite = exists(movedRecord);
      return origWrite(p, ...rest);
    });
    let res;
    try {
      res = await runApplyTool({ projectId: "wr", label: "wr9", force: true });
    } finally {
      spy.mockRestore();
    }
    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect(rotatedAtFirstWrite).toBe(true);
    expect(listAttempts(runDir)).toEqual(["prior-9"]);
    expect(JSON.parse(fs.readFileSync(movedRecord, "utf8")).entries.map((e) => e.target)).toEqual(["notes/x.md"]);
    const rec = recordOf(runDir);
    expect(rec.attemptId).not.toBe("prior-9");
    expect(rec.entries.map((e) => e.target).sort()).toEqual(["notes/b.md", "notes/n9.md"]);
    for (const e of rec.entries) expect(e.attemptId).toBe(rec.attemptId);
  }, 60_000);

  it("[WR10] runApplyTool with _execContext true does not rotate; new entries join the existing attempt", async () => {
    const root = makeRepo("wr10");
    const runDir = writePlan(root, "wr10", [
      { action: "edit_file", path: "notes/b.md", content: "# b\n\nwr10 body\n", title: "edit" },
    ]);
    beginWriteRecordAttempt(runDir, { attemptId: "exec-10" });
    recordPlanPreImage(root, runDir, "notes/x.md");
    const res = await runApplyTool({ projectId: "wr", label: "wr10", _execContext: true });
    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect(listAttempts(runDir)).toEqual([]);
    const rec = recordOf(runDir);
    expect(rec.attemptId).toBe("exec-10");
    expect(rec.entries.map((e) => e.target)).toEqual(["notes/x.md", "notes/b.md"]);
    for (const e of rec.entries) expect(e.attemptId).toBe("exec-10");
  }, 60_000);

  it("[WR11] applyFixPlan entries after a forced runApplyTool carry the record's attemptId and add no rotation directory", async () => {
    const root = makeRepo("wr11");
    const runDir = writePlan(root, "wr11", [
      { action: "edit_file", path: "notes/b.md", content: "# b\n\nwr11 body\n", title: "edit" },
    ]);
    beginWriteRecordAttempt(runDir, { attemptId: "prior-11" });
    // An empty record is overwritten in place, not rotated (backlog.fix.exec-write-record-attempt-retention).
    recordPlanPreImage(root, runDir, "notes/x.md");
    const res = await runApplyTool({ projectId: "wr", label: "wr11", force: true });
    expect(res.ok, JSON.stringify(res)).toBe(true);
    const attemptsAfterApply = listAttempts(runDir);
    expect(attemptsAfterApply).toEqual(["prior-11"]);
    const attemptId = recordOf(runDir).attemptId;

    const fix = await applyFixPlan({ projectId: "wr", projectRoot: root, runDir, attemptNumber: 2, plan: { steps: [
      { action: "create_file", path: "notes/fix-a.md", content: "# fix-a\n" },
      { action: "edit_file", path: "notes/x.md", content: "# x\n\nfixed\n" },
    ] } });
    expect(fix.ok, JSON.stringify(fix)).toBe(true);
    expect(listAttempts(runDir)).toEqual(attemptsAfterApply);
    const rec = recordOf(runDir);
    expect(rec.attemptId).toBe(attemptId);
    expect(rec.entries.map((e) => e.target)).toEqual(["notes/b.md", "notes/fix-a.md", "notes/x.md"]);
    for (const e of rec.entries) expect(e.attemptId).toBe(attemptId);
  }, 60_000);
});

describe("two exec attempts on one run directory", () => {
  it("[WR16] failure mode A: run 2's rollback restores the between-runs bytes P2, not run 1's P1; run 1's record survives under apply/attempts/", async () => {
    const root = makeRepo("wr16");
    const runDir = writePlan(root, "wr16", [
      { action: "edit_file", path: "notes/x.md", content: "# x\n\nW1 run 1 output\n", title: "edit" },
      { action: "run_command", command: "node stray.mjs", title: "stray" },
    ]);
    const r1 = await runExecTool({ projectId: "wr", label: "wr16", skipTests: true });
    expect(r1.ok, JSON.stringify(r1)).toBe(false);
    expect(r1.error).toMatch(/Scope violation/);
    expect(readText(root, "notes/x.md")).toBe(P1);
    const run1AttemptId = recordOf(runDir).attemptId;
    expect(entryFor(runDir, "notes/x.md").preImageHash).toBe(sha(Buffer.from(P1)));

    // Between runs: a Governor note commit changes notes/x.md to P2.
    const P2 = "# x\n\nP2 committed between runs\n";
    fs.writeFileSync(path.join(root, "notes", "x.md"), P2);
    git(root, ["commit", "-q", "-am", "governor note commit"]);

    writePlan(root, "wr16", [
      { action: "edit_file", path: "notes/x.md", content: "# x\n\nW2 run 2 output\n", title: "edit" },
      { action: "run_command", command: "node stray.mjs", title: "stray" },
    ]);
    const r2 = await runExecTool({ projectId: "wr", label: "wr16", skipTests: true });
    expect(r2.ok, JSON.stringify(r2)).toBe(false);
    expect(r2.error).toMatch(/Scope violation/);
    expect(readText(root, "notes/x.md")).toBe(P2);
    expect(r2.rolledBack).toBe(true);

    // Run 1's record and pre-images are preserved, not deleted.
    expect(listAttempts(runDir)).toEqual([run1AttemptId]);
    const kept = path.join(attemptsDir(runDir), run1AttemptId);
    const keptRecord = JSON.parse(fs.readFileSync(path.join(kept, "write-record.json"), "utf8"));
    expect(keptRecord.attemptId).toBe(run1AttemptId);
    expect(keptRecord.entries.find((e) => e.target === "notes/x.md").preImageHash).toBe(sha(Buffer.from(P1)));
    expect(fs.readFileSync(path.join(kept, "pre-images", sha(Buffer.from(P1))), "utf8")).toBe(P1);
    expect(recordOf(runDir).attemptId).not.toBe(run1AttemptId);
  }, 180_000);

  it("[WR17] failure mode B: a file run 1 created and the operator then edited to K still exists and holds K after run 2's rollback", async () => {
    const root = makeRepo("wr17");
    const runDir = writePlan(root, "wr17", [
      { action: "create_file", path: "notes/y.md", content: "# y\n\nrun 1 created\n", title: "create" },
      { action: "run_command", command: "node touch-y.mjs", title: "touch" },
    ]);
    const r1 = await runExecTool({ projectId: "wr", label: "wr17", skipTests: true });
    expect(r1.ok, JSON.stringify(r1)).toBe(false);
    // Run 1 leaves notes/y.md behind (changed after the plan wrote it).
    expect(r1.leftBehind.map((l) => l.path)).toEqual(["notes/y.md"]);
    expect(entryFor(runDir, "notes/y.md").existed).toBe(false);

    // The operator keeps the file and edits it to K.
    const K = "# y\n\nK kept by the operator\n";
    fs.writeFileSync(path.join(root, "notes", "y.md"), K);
    git(root, ["add", "notes/y.md"]);
    git(root, ["commit", "-q", "-m", "keep y"]);

    writePlan(root, "wr17", [
      { action: "edit_file", path: "notes/y.md", content: "# y\n\nrun 2 output\n", title: "edit" },
      { action: "run_command", command: "node stray.mjs", title: "stray" },
    ]);
    const r2 = await runExecTool({ projectId: "wr", label: "wr17", skipTests: true });
    expect(r2.ok, JSON.stringify(r2)).toBe(false);
    expect(r2.error).toMatch(/Scope violation/);
    expect(exists(path.join(root, "notes", "y.md"))).toBe(true);
    expect(readText(root, "notes/y.md")).toBe(K);
    expect(entryFor(runDir, "notes/y.md").existed).toBe(true);
  }, 180_000);
});

describe("exec_threw carries the rollback outcome", () => {
  it("[WR18] Region 2: err carries rolledBack from deriveRolledBack, leftBehind, recovery and partialDiffPath, and a message suffix matching rolledBack", async () => {
    const root = makeRepo("wr18");
    const runDir = writePlan(root, "wr18", []);
    const ctx = region2Ctx(root, runDir);
    const err = new Error("boom in region 2");
    await recoverExecFailure(ctx, err);
    expect(rollback).toHaveBeenCalledTimes(1);
    const rb = ctx.rollbackResult;
    expect(rb).toBe(h.rollbacks[0].ret);
    expect(err.rolledBack).toBe(deriveRolledBack(rb));
    expect(err.rolledBack).toBe(true);
    expect(err.leftBehind).toEqual(rb.leftBehind);
    expect(err.recovery).toBe(rollbackRecoveryGuidance(rb));
    expect(err.partialDiffPath).toBe(rb.partialDiffPath ?? null);
    expect(err.message).toBe("boom in region 2 [rks.exec: rolled back]");
  }, 60_000);

  it("[WR19] Region 2 with a plan-written protected file left behind: rolledBack false, leftBehind names it, recovery non-null", async () => {
    const root = makeRepo("wr19");
    const runDir = writePlan(root, "wr19", [{ action: "create_file", path: "notes/a.md", content: "# a\n", title: "create" }]);
    const res = await runApplyTool({ projectId: "wr", label: "wr19", force: true });
    expect(res.ok, JSON.stringify(res)).toBe(true);
    fs.appendFileSync(path.join(root, "notes", "a.md"), "changed after the plan\n");

    const ctx = region2Ctx(root, runDir);
    const err = new Error("boom after apply");
    await recoverExecFailure(ctx, err);
    expect(deriveRolledBack(ctx.rollbackResult)).toBe(false);
    expect(err.rolledBack).toBe(false);
    expect(err.leftBehind.map((l) => l.path)).toEqual(["notes/a.md"]);
    expect(err.recovery).toEqual(expect.any(String));
    expect(err.recovery).toContain("notes/a.md");
    expect(err.message).toMatch(/^boom after apply \[rks\.exec: rollback did NOT fully restore the tree; left behind: notes\/a\.md; /);
    expect(err.message).not.toContain("[rks.exec: rolled back]");
    expect(exists(path.join(root, "notes", "a.md"))).toBe(true);
  }, 60_000);

  it("[WR20] Region 2 when rollback() throws: rolledBack false, leftBehind [], rollbackError set, false-branch suffix", async () => {
    const root = makeRepo("wr20");
    const runDir = writePlan(root, "wr20", []);
    vi.mocked(rollback).mockImplementationOnce(async () => { throw new Error("rollback exploded"); });
    const err = new Error("boom");
    const ret = await recoverExecFailure(region2Ctx(root, runDir), err);
    expect(typeof ret).toBe("boolean");
    expect(err.rolledBack).toBe(false);
    expect(err.leftBehind).toEqual([]);
    expect(err.rollbackError).toBe("rollback exploded");
    expect(err.recovery).toBe(rollbackRecoveryGuidance(null));
    expect(err.recovery).toEqual(expect.any(String));
    expect(err.message).toMatch(/^boom \[rks\.exec: rollback did NOT fully restore the tree; left behind: none; /);
  }, 60_000);

  it("[WR21] Regions 1 and 3 attach none of rolledBack, leftBehind, recovery, partialDiffPath, rollbackError and leave the message unchanged", async () => {
    const root = makeRepo("wr21");
    const runDir = writePlan(root, "wr21", []);
    // Region 1: finalized (even with a branch set).
    const e1 = new Error("region 1");
    await recoverExecFailure(region2Ctx(root, runDir, { finalized: true, branchName: "rks/x", guardrailsSession: { ok: true } }), e1);
    // Region 3: nothing mutated.
    const e3 = new Error("region 3");
    await recoverExecFailure(region2Ctx(root, runDir, { guardrailsSession: null }), e3);
    expect(rollback).not.toHaveBeenCalled();
    for (const [e, msg] of [[e1, "region 1"], [e3, "region 3"]]) {
      for (const f of ROLLBACK_FIELDS) expect(Object.prototype.hasOwnProperty.call(e, f), f).toBe(false);
      expect(e.message).toBe(msg);
    }
    // POSITIVE CONTROL: the same check sees the fields in Region 2.
    const e2 = new Error("region 2");
    await recoverExecFailure(region2Ctx(root, runDir), e2);
    expect(Object.prototype.hasOwnProperty.call(e2, "rolledBack")).toBe(true);
    expect(e2.message).not.toBe("region 2");
  }, 60_000);

  it("[WR22] a frozen error passed to recoverExecFailure in Region 2 does not throw from the attach", async () => {
    const root = makeRepo("wr22");
    const runDir = writePlan(root, "wr22", []);
    const frozen = Object.freeze(new Error("frozen"));
    let ret;
    await expect((async () => { ret = await recoverExecFailure(region2Ctx(root, runDir), frozen); })()).resolves.toBeUndefined();
    expect(typeof ret).toBe("boolean");
    expect(rollback).toHaveBeenCalledTimes(1);
    expect(frozen.message).toBe("frozen");
    expect(Object.prototype.hasOwnProperty.call(frozen, "rolledBack")).toBe(false);
    // CONTROL: an unfrozen error in the same scenario does receive the outcome.
    const open = new Error("open");
    await recoverExecFailure(region2Ctx(root, runDir), open);
    expect(open.rolledBack).toBe(deriveRolledBack(h.rollbacks[1].ret));
  }, 60_000);

  it("[WR23] recoverExecFailure in Region 2 still returns the phase-reset boolean", async () => {
    const root = makeRepo("wr23");
    const runDir = writePlan(root, "wr23", []);
    expect(phaseOf(root)).toBe("executing");
    const first = await recoverExecFailure(region2Ctx(root, runDir, { storyId: STORY }), new Error("one"));
    expect(first).toBe(true);
    expect(phaseOf(root)).toBe("arch-approved");
    const second = await recoverExecFailure(region2Ctx(root, runDir, { storyId: STORY }), new Error("two"));
    expect(second).toBe(false);
    expect(rollback).toHaveBeenCalledTimes(2);
  }, 60_000);
});

describe("messages follow the derived rolledBack", () => {
  it("[WR24] command_policy_changed: says the run rolled back only when rolledBack is true; otherwise points to recovery and leftBehind", async () => {
    // rolledBack true: the preCommand only widens the policy.
    const clean = makeRepo("wr24-clean", { preCommands: ["node widen.mjs"] });
    writePlan(clean, "wr24c", [{ action: "create_file", path: "notes/never.md", content: "x\n", title: "c" }], { problemId: STORY });
    const ok = await runExecTool({ projectId: "wr", label: "wr24c", skipTests: true });
    expect(ok.status, JSON.stringify(ok)).toBe("command_policy_changed");
    expect(ok.stage).toBe("pre_commands");
    expect(ok.rolledBack).toBe(true);
    expect(ok.message).toMatch(/and the run rolled back\.$/);
    expect(ok.message).not.toMatch(/did NOT fully restore/);

    // rolledBack false: rollback leaves a protected file (notes/pc.md) behind.
    const dirty = makeRepo("wr24-dirty", { preCommands: ["node widen-leave.mjs"] });
    writePlan(dirty, "wr24d", [{ action: "create_file", path: "notes/never.md", content: "x\n", title: "c" }], { problemId: STORY });
    const bad = await runExecTool({ projectId: "wr", label: "wr24d", skipTests: true });
    expect(bad.status, JSON.stringify(bad)).toBe("command_policy_changed");
    expect(bad.stage).toBe("pre_commands");
    expect(bad.rolledBack).toBe(false);
    expect(bad.leftBehind.map((l) => l.path)).toEqual(["notes/pc.md"]);
    expect(bad.recovery).toEqual(expect.any(String));
    expect(bad.message).not.toMatch(/the run rolled back/);
    expect(bad.message).toMatch(/rollback did NOT fully restore the tree; see recovery and leftBehind\.$/);
  }, 180_000);

  it("[WR25] protected_path_in_commit: says the run was rolled back only when rolledBack is true; otherwise points to recovery and leftBehind", async () => {
    // rolledBack true: a staged-only governance path, nothing else.
    const clean = makeRepo("wr25-clean");
    writePlan(clean, "wr25c", [
      { action: "create_file", path: "plan-created.txt", content: "created\n", title: "create" },
      { action: "run_command", command: "node stage-hook.mjs", title: "stage hook" },
    ]);
    const ok = await runExecTool({ projectId: "wr", label: "wr25c", skipTests: true });
    expect(ok.status, JSON.stringify(ok)).toBe("protected_path_in_commit");
    expect(ok.rolledBack).toBe(true);
    expect(ok.message).toMatch(/Nothing was committed; the run was rolled back\.$/);

    // rolledBack false: the plan-created notes/a.md is changed after the plan wrote it, so rollback leaves it.
    const dirty = makeRepo("wr25-dirty");
    writePlan(dirty, "wr25d", [
      { action: "create_file", path: "notes/a.md", content: "# a\n", title: "create" },
      { action: "run_command", command: "node touch-a.mjs", title: "touch" },
      { action: "run_command", command: "node stage-hook.mjs", title: "stage hook" },
    ]);
    const bad = await runExecTool({ projectId: "wr", label: "wr25d", skipTests: true });
    expect(bad.status, JSON.stringify(bad)).toBe("protected_path_in_commit");
    expect(bad.rolledBack).toBe(false);
    expect(bad.leftBehind.map((l) => l.path)).toEqual(["notes/a.md"]);
    expect(bad.message).not.toMatch(/the run was rolled back/);
    expect(bad.message).toMatch(/Nothing was committed; rollback did NOT fully restore the tree; see recovery and leftBehind\.$/);
  }, 180_000);
});
