/**
 * backlog.fix.exec-write-record-attempt-retention
 *
 * apply/attempts/ is bounded. An empty parseable record with no pre-images is overwritten in place
 * instead of rotated; revertPlanWrites persists its outcome into the record; a committed exec
 * attempt carries a completion stamp; after a rotation apply/attempts/ is pruned to the
 * WRITE_RECORD_ATTEMPTS_KEEP most recent PRUNABLE directories, and the prunable test fails closed.
 *
 * Contract pinned here: backup.mjs exports WRITE_RECORD_ATTEMPTS_KEEP (positive integer);
 * record.revertOutcome = { at, reverted, leftBehind }; record.completion = { at, commitId, fullCommitId }.
 * Evidence saves are best-effort: revertPlanWrites returns outcomePersistError { error, detail } when the
 * revertOutcome save fails (absent otherwise); stampWriteRecordCompletion returns { ok } / { ok: false, error, detail }
 * and never throws.
 * Pruning removes directories through the default fs object's rmSync or rmdirSync.
 *
 * testRequirement -> test: each `it` title starts with the [ARn] tag it covers.
 * [process] Every spawnSync in this file passes timeout: GIT_TIMEOUT.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { makeTempDir } from "../helpers/tmp.mjs";

const GIT_TIMEOUT = 15_000;
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

const { runExecTool } = await import("../../packages/mcp-rks/src/server/exec.mjs");
const {
  beginWriteRecordAttempt,
  recordPlanPreImage,
  revertPlanWrites,
  readWriteRecord,
  writeRecordPath,
  PRE_IMAGE_RELATIVE_DIR,
  WRITE_RECORD_ATTEMPTS_RELATIVE_DIR,
  WRITE_RECORD_ATTEMPTS_KEEP,
  stampWriteRecordCompletion,
} = await import("../../packages/mcp-rks/src/exec/backup.mjs");

const N = WRITE_RECORD_ATTEMPTS_KEEP;
const sha = (buf) => createHash("sha256").update(buf).digest("hex");
const git = (cwd, args) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout: GIT_TIMEOUT });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
};
const cleanup = [];

const POLICY = [
  "command_policy:",
  "  auto_execute: []",
  '  execute_with_plan_approval: ["git add", "git commit"]',
  '  require_explicit_confirmation: ["rm"]',
  "",
].join("\n");
const B_COMMITTED = "# b\n\ncommitted body\n";

function makeRepo(tag) {
  const root = makeTempDir(`wr-retention-${tag}`);
  cleanup.push(root);
  fs.mkdirSync(path.join(root, ".routekit"), { recursive: true });
  fs.mkdirSync(path.join(root, "notes"), { recursive: true });
  fs.writeFileSync(path.join(root, ".routekit", "command-policy.yaml"), POLICY);
  fs.writeFileSync(path.join(root, "notes", "b.md"), B_COMMITTED);
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

function writePlan(root, label, steps) {
  const runDir = path.join(root, ".rks", "runs", `2026-11-08T00-00-00-000Z_${label}`);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, "plan.json"), JSON.stringify({ slug: label, status: "executable", steps }, null, 2));
  fs.writeFileSync(path.join(runDir, "run.json"), JSON.stringify({ projectId: "wr", timestamps: {}, telemetry: { outcome: "planned" } }));
  return runDir;
}

/** A bare project root + run directory (no git) for direct backup.mjs tests. */
function makeRunDir(tag) {
  const root = makeTempDir(`wr-retention-unit-${tag}`);
  cleanup.push(root);
  fs.mkdirSync(path.join(root, "notes"), { recursive: true });
  const runDir = path.join(root, ".rks", "runs", "r1");
  fs.mkdirSync(runDir, { recursive: true });
  return { root, runDir };
}

const exists = (p) => fs.existsSync(p);
const attemptsDir = (runDir) => path.join(runDir, WRITE_RECORD_ATTEMPTS_RELATIVE_DIR);
const listAttempts = (runDir) => (exists(attemptsDir(runDir)) ? fs.readdirSync(attemptsDir(runDir)).sort() : []);
const recordOf = (runDir) => {
  const r = readWriteRecord(runDir);
  if (r.status !== "ok") throw new Error(`record ${r.status}`);
  return r.record;
};
const iso = (i) => new Date(Date.UTC(2026, 0, 1) + i * 3_600_000).toISOString();
const ENTRY = { target: "notes/e.md", existed: false, preImageHash: null, postExists: true, postHash: "0".repeat(64), source: "plan" };

function makeAttempt(runDir, label, record, { preImages = false } = {}) {
  const dir = path.join(attemptsDir(runDir), label);
  fs.mkdirSync(dir, { recursive: true });
  if (record !== undefined) {
    fs.writeFileSync(path.join(dir, "write-record.json"), typeof record === "string" ? record : JSON.stringify(record));
  }
  if (preImages) {
    fs.mkdirSync(path.join(dir, "pre-images"));
    fs.writeFileSync(path.join(dir, "pre-images", "a".repeat(64)), "bytes\n");
  }
  return dir;
}
const emptyRec = (id, at) => ({ version: 1, attemptId: id, startedAt: at, entries: [] });
const revertedRec = (id, at) => ({
  version: 1, attemptId: id, startedAt: at, entries: [{ ...ENTRY, attemptId: id }],
  revertOutcome: { at, reverted: ["notes/e.md"], leftBehind: [] },
});
const committedRec = (id, at) => ({
  version: 1, attemptId: id, startedAt: at, entries: [{ ...ENTRY, attemptId: id }],
  completion: { at, commitId: "abc1234", fullCommitId: `abc1234${"0".repeat(33)}` },
});
const PRUNABLE_KINDS = [emptyRec, revertedRec, committedRec];

/** N+extra prunable attempt dirs, oldest first; returns their labels in age order. */
function makePrunable(runDir, count, { offset = 100, prefix = "p" } = {}) {
  const labels = [];
  for (let i = 0; i < count; i += 1) {
    const id = `${prefix}${String(i).padStart(3, "0")}`;
    makeAttempt(runDir, id, PRUNABLE_KINDS[i % PRUNABLE_KINDS.length](id, iso(offset + i)));
    labels.push(id);
  }
  return labels;
}

/** A live record with one entry, so the next beginWriteRecordAttempt rotates it. */
function liveWithEntry(root, runDir, attemptId) {
  fs.writeFileSync(path.join(root, "notes", "e.md"), "live\n");
  beginWriteRecordAttempt(runDir, { attemptId });
  recordPlanPreImage(root, runDir, "notes/e.md");
}

let errSpy;
let warnSpy;
beforeEach(() => {
  h.root = null;
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const p of cleanup.splice(0)) {
    try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

describe("empty records are overwritten in place", () => {
  it("[AR1] an empty parseable record with no or empty pre-images is overwritten in place, not rotated", () => {
    const { runDir } = makeRunDir("ar1");
    beginWriteRecordAttempt(runDir, { attemptId: "A" });
    expect(recordOf(runDir)).toMatchObject({ attemptId: "A", entries: [] });
    const res = beginWriteRecordAttempt(runDir, { attemptId: "B" });
    expect(res).toEqual({ attemptId: "B", rotatedTo: null });
    expect(listAttempts(runDir)).toEqual([]);
    expect(recordOf(runDir)).toMatchObject({ attemptId: "B", entries: [] });

    // An EMPTY pre-image directory does not force a rotation either.
    fs.mkdirSync(path.join(runDir, PRE_IMAGE_RELATIVE_DIR), { recursive: true });
    const res2 = beginWriteRecordAttempt(runDir, { attemptId: "C" });
    expect(res2.rotatedTo).toBeNull();
    expect(listAttempts(runDir)).toEqual([]);
    expect(recordOf(runDir).attemptId).toBe("C");
  });

  it("[AR1b] two consecutive dry-run runExecTool calls create no apply/attempts entry and leave a fresh attemptId", async () => {
    const root = makeRepo("ar1b");
    const runDir = writePlan(root, "ar1b", [{ action: "edit_file", path: "notes/b.md", content: "# b\n\ndry\n", title: "edit" }]);
    await runExecTool({ projectId: "wr", label: "ar1b", skipTests: true, dryRun: true });
    const first = recordOf(runDir);
    expect(first.entries).toEqual([]);
    expect(typeof first.attemptId).toBe("string");
    await runExecTool({ projectId: "wr", label: "ar1b", skipTests: true, dryRun: true });
    const second = recordOf(runDir);
    expect(listAttempts(runDir)).toEqual([]);
    expect(second.entries).toEqual([]);
    expect(second.attemptId).not.toBe(first.attemptId);
    expect(fs.readFileSync(path.join(root, "notes", "b.md"), "utf8")).toBe(B_COMMITTED);
  }, 120_000);

  it("[AR2] an unparseable record (empty file or invalid JSON) is rotated with its bytes unchanged, never overwritten", () => {
    for (const [tag, bytes] of [["empty", ""], ["invalid", "{not json"]]) {
      const { runDir } = makeRunDir(`ar2-${tag}`);
      fs.mkdirSync(path.dirname(writeRecordPath(runDir)), { recursive: true });
      fs.writeFileSync(writeRecordPath(runDir), bytes);
      const res = beginWriteRecordAttempt(runDir, { attemptId: "next" });
      expect(res.rotatedTo).toMatch(/^apply\/attempts\/pre-attempt-/);
      const [label] = listAttempts(runDir);
      expect(fs.readFileSync(path.join(attemptsDir(runDir), label, "write-record.json"), "utf8")).toBe(bytes);
      expect(recordOf(runDir).attemptId).toBe("next");
    }
  });

  it("[AR15] a valid-JSON wrong-shape record (null, {}, entries not an array, bare array) is rotated with its bytes unchanged, never overwritten", () => {
    for (const [tag, bytes] of [["null", "null"], ["empty-object", "{}"], ["entries-string", '{"entries":"x"}'], ["bare-array", "[]"]]) {
      const { runDir } = makeRunDir(`ar15-${tag}`);
      fs.mkdirSync(path.dirname(writeRecordPath(runDir)), { recursive: true });
      fs.writeFileSync(writeRecordPath(runDir), bytes);
      const res = beginWriteRecordAttempt(runDir, { attemptId: "next" });
      expect(res.rotatedTo, tag).toMatch(/^apply\/attempts\/pre-attempt-/);
      const attempts = listAttempts(runDir);
      expect(attempts, tag).toHaveLength(1);
      expect(fs.readFileSync(path.join(attemptsDir(runDir), attempts[0], "write-record.json"), "utf8"), tag).toBe(bytes);
      expect(recordOf(runDir), tag).toMatchObject({ attemptId: "next", entries: [] });
    }
  });

  it("[AR3] a record with entries [] and a non-empty pre-image store is still rotated with its pre-images", () => {
    const { runDir } = makeRunDir("ar3");
    const pre = path.join(runDir, PRE_IMAGE_RELATIVE_DIR);
    fs.mkdirSync(pre, { recursive: true });
    fs.writeFileSync(path.join(pre, "b".repeat(64)), "old bytes\n");
    fs.writeFileSync(writeRecordPath(runDir), JSON.stringify(emptyRec("P3", iso(0))));
    const res = beginWriteRecordAttempt(runDir, { attemptId: "next" });
    expect(res.rotatedTo).toBe("apply/attempts/P3");
    expect(fs.readFileSync(path.join(attemptsDir(runDir), "P3", "pre-images", "b".repeat(64)), "utf8")).toBe("old bytes\n");
    expect(exists(pre)).toBe(false);
  });
});

describe("persisted outcome evidence", () => {
  it("[AR4] revertPlanWrites persists revertOutcome { at, reverted, leftBehind } matching its return value", () => {
    // Clean revert: the plan-created file still holds what the plan wrote.
    const a = makeRunDir("ar4-clean");
    const created = "plan created\n";
    fs.writeFileSync(path.join(a.root, "notes", "c.md"), created);
    const entriesA = [{ target: "notes/c.md", existed: false, preImageHash: null, postExists: true, postHash: sha(Buffer.from(created)), source: "plan", attemptId: "R" }];
    fs.mkdirSync(path.dirname(writeRecordPath(a.runDir)), { recursive: true });
    fs.writeFileSync(writeRecordPath(a.runDir), JSON.stringify({ version: 1, attemptId: "R", entries: entriesA }));
    const resA = revertPlanWrites(a.root, a.runDir);
    expect(resA.leftBehind).toEqual([]);
    const recA = recordOf(a.runDir);
    expect(recA.revertOutcome.reverted).toEqual(resA.reverted);
    expect(recA.revertOutcome.leftBehind).toEqual(resA.leftBehind);
    expect(new Date(recA.revertOutcome.at).toISOString()).toBe(recA.revertOutcome.at);
    expect(recA.entries).toEqual(entriesA);

    // Left behind: the file changed after the plan wrote it.
    const b = makeRunDir("ar4-left");
    fs.writeFileSync(path.join(b.root, "notes", "c.md"), "changed after the plan\n");
    fs.mkdirSync(path.dirname(writeRecordPath(b.runDir)), { recursive: true });
    fs.writeFileSync(writeRecordPath(b.runDir), JSON.stringify({ version: 1, attemptId: "R", entries: entriesA }));
    const resB = revertPlanWrites(b.root, b.runDir);
    expect(resB.leftBehind.map((l) => l.path)).toEqual(["notes/c.md"]);
    const recB = recordOf(b.runDir);
    expect(recB.revertOutcome.leftBehind).toEqual(resB.leftBehind);
    expect(recB.revertOutcome.reverted).toEqual(resB.reverted);
  });

  it("[AR5] a committing exec attempt carries a completion stamp with its commit id", async () => {
    const root = makeRepo("ar5");
    const body = "# b\n\nar5 body\n";
    const runDir = writePlan(root, "ar5", [{ action: "edit_file", path: "notes/b.md", content: body, title: "edit" }]);
    const result = await runExecTool({ projectId: "wr", label: "ar5", skipTests: true, autoCommit: true });
    expect(result.ok, JSON.stringify(result)).not.toBe(false);
    const execAttempt = recordOf(runDir).attemptId;
    beginWriteRecordAttempt(runDir, { attemptId: "after-ar5" });
    const moved = JSON.parse(fs.readFileSync(path.join(attemptsDir(runDir), execAttempt, "write-record.json"), "utf8"));
    expect(moved.completion, JSON.stringify(moved)).toBeTruthy();
    expect(typeof moved.completion.commitId).toBe("string");
    expect(moved.completion.commitId.length).toBeGreaterThanOrEqual(7);
    expect(git(root, ["show", `${moved.completion.commitId}:notes/b.md`])).toBe(body);
  }, 120_000);
});

describe("evidence-bound retention of apply/attempts", () => {
  it("[AR11] WRITE_RECORD_ATTEMPTS_KEEP is a positive integer", () => {
    expect(Number.isInteger(N)).toBe(true);
    expect(N).toBeGreaterThan(0);
  });

  it("[AR6] a rotation keeps the N most recent prunable directories, every non-prunable one, and the new one", () => {
    const { root, runDir } = makeRunDir("ar6");
    const prunable = makePrunable(runDir, N + 3);
    makeAttempt(runDir, "keep-entries", { version: 1, attemptId: "keep-entries", startedAt: iso(0), entries: [{ ...ENTRY, attemptId: "keep-entries" }] });
    makeAttempt(runDir, "keep-unparseable", "{not json");
    liveWithEntry(root, runDir, "live");
    const res = beginWriteRecordAttempt(runDir, { attemptId: "next" });
    expect(res.rotatedTo).toBe("apply/attempts/live");
    expect(listAttempts(runDir)).toEqual([...prunable.slice(-N), "keep-entries", "keep-unparseable", "live"].sort());
  });

  it("[AR6b] records without startedAt are ordered by directory mtime", () => {
    const { root, runDir } = makeRunDir("ar6b");
    const labels = [];
    for (let i = 0; i < N + 2; i += 1) {
      const id = `m${String(i).padStart(3, "0")}`;
      const dir = makeAttempt(runDir, id, { version: 1, attemptId: id, entries: [] });
      const t = new Date(Date.UTC(2025, 0, 1) + i * 3_600_000);
      fs.utimesSync(dir, t, t);
      labels.push(id);
    }
    liveWithEntry(root, runDir, "live");
    beginWriteRecordAttempt(runDir, { attemptId: "next" });
    expect(listAttempts(runDir)).toEqual([...labels.slice(-N), "live"].sort());
  });

  it("[AR7] an attempt whose revertOutcome left files behind is never pruned", () => {
    const { root, runDir } = makeRunDir("ar7");
    makeAttempt(runDir, "left", {
      version: 1, attemptId: "left", startedAt: iso(0), entries: [{ ...ENTRY, attemptId: "left" }],
      revertOutcome: { at: iso(0), reverted: [], leftBehind: [{ path: "notes/e.md", reason: "changed after the plan wrote it" }] },
    });
    const prunable = makePrunable(runDir, N + 1);
    liveWithEntry(root, runDir, "live");
    beginWriteRecordAttempt(runDir, { attemptId: "next" });
    expect(listAttempts(runDir)).toEqual([...prunable.slice(-N), "left", "live"].sort());
  });

  it("[AR8] attempts without outcome evidence, without a parseable record, or with stray pre-images are never pruned", () => {
    const { root, runDir } = makeRunDir("ar8");
    const keep = [
      makeAttempt(runDir, "entries-no-evidence", { version: 1, attemptId: "entries-no-evidence", startedAt: iso(0), entries: [{ ...ENTRY, attemptId: "entries-no-evidence" }] }),
      makeAttempt(runDir, "unparseable", "{not json"),
      makeAttempt(runDir, "commit-null", {
        version: 1, attemptId: "commit-null", startedAt: iso(1), entries: [{ ...ENTRY, attemptId: "commit-null" }],
        completion: { at: iso(1), commitId: null, fullCommitId: null },
      }),
      makeAttempt(runDir, "pre-attempt-2025-01-01T00-00-00-000Z", undefined, { preImages: true }),
    ];
    const noRecord = makeAttempt(runDir, "no-record", undefined);
    fs.writeFileSync(path.join(noRecord, "sentinel.txt"), "keep me\n");
    const prunable = makePrunable(runDir, N + 1);
    liveWithEntry(root, runDir, "live");
    beginWriteRecordAttempt(runDir, { attemptId: "next" });
    for (const dir of [...keep, noRecord]) expect(exists(dir), dir).toBe(true);
    expect(listAttempts(runDir)).toEqual([
      ...prunable.slice(-N), "entries-no-evidence", "unparseable", "commit-null",
      "pre-attempt-2025-01-01T00-00-00-000Z", "no-record", "live",
    ].sort());
  });

  it("[AR16] attempts whose record is valid JSON of the wrong shape are never pruned", () => {
    const { root, runDir } = makeRunDir("ar16");
    const shaped = [["shape-null", "null"], ["shape-empty-object", "{}"], ["shape-entries-string", '{"entries":"x"}'], ["shape-bare-array", "[]"]];
    const keep = shaped.map(([label, bytes]) => makeAttempt(runDir, label, bytes));
    const prunable = makePrunable(runDir, N + 1);
    liveWithEntry(root, runDir, "live");
    beginWriteRecordAttempt(runDir, { attemptId: "next" });
    for (const dir of keep) expect(exists(dir), dir).toBe(true);
    expect(listAttempts(runDir)).toEqual([...prunable.slice(-N), ...shaped.map(([label]) => label), "live"].sort());
  });

  it("[AR9] the directory created by this rotation and the live record are never pruned", () => {
    const { root, runDir } = makeRunDir("ar9");
    const prunable = makePrunable(runDir, N);
    liveWithEntry(root, runDir, "live-old");
    // Make the live attempt prunable AND older than every other prunable directory.
    const rec = recordOf(runDir);
    rec.startedAt = iso(-1000);
    rec.revertOutcome = { at: iso(-1000), reverted: ["notes/e.md"], leftBehind: [] };
    fs.writeFileSync(writeRecordPath(runDir), JSON.stringify(rec));
    const res = beginWriteRecordAttempt(runDir, { attemptId: "next" });
    expect(res.rotatedTo).toBe("apply/attempts/live-old");
    expect(listAttempts(runDir)).toEqual([...prunable, "live-old"].sort());
    expect(exists(writeRecordPath(runDir))).toBe(true);
    expect(recordOf(runDir).attemptId).toBe("next");
  });

  it("[AR10] a pruning failure does not throw out of beginWriteRecordAttempt and the directories remain", () => {
    const { root, runDir } = makeRunDir("ar10");
    const prunable = makePrunable(runDir, N + 2);
    liveWithEntry(root, runDir, "live");
    const boom = () => { throw Object.assign(new Error("injected rm failure"), { code: "EPERM" }); };
    vi.spyOn(fs, "rmSync").mockImplementation(boom);
    vi.spyOn(fs, "rmdirSync").mockImplementation(boom);
    let res;
    expect(() => { res = beginWriteRecordAttempt(runDir, { attemptId: "next" }); }).not.toThrow();
    expect(res.attemptId).toBe("next");
    expect(listAttempts(runDir)).toEqual([...prunable, "live"].sort());
    expect(recordOf(runDir).attemptId).toBe("next");
    expect(warnSpy.mock.calls.length + errSpy.mock.calls.length).toBeGreaterThan(0);
  });
});

/** Make fs.renameSync throw only when the destination is this run's live write record. */
function failLiveRecordRename(runDir) {
  const live = path.resolve(writeRecordPath(runDir));
  const real = fs.renameSync;
  return vi.spyOn(fs, "renameSync").mockImplementation((from, to, ...rest) => {
    if (path.resolve(String(to)) === live) throw Object.assign(new Error("injected persist failure"), { code: "EIO" });
    return real.call(fs, from, to, ...rest);
  });
}

/** A live record with one plan-created entry whose file still holds what the plan wrote. */
function seedRevertable(root, runDir, attemptId, startedAt) {
  const created = "plan created\n";
  fs.writeFileSync(path.join(root, "notes", "c.md"), created);
  const entries = [{ target: "notes/c.md", existed: false, preImageHash: null, postExists: true, postHash: sha(Buffer.from(created)), source: "plan", attemptId }];
  fs.mkdirSync(path.dirname(writeRecordPath(runDir)), { recursive: true });
  const rec = { version: 1, attemptId, entries };
  if (startedAt) rec.startedAt = startedAt;
  fs.writeFileSync(writeRecordPath(runDir), JSON.stringify(rec));
  return entries;
}

describe("evidence saves are best-effort", () => {
  it("[AR12] a failed revertOutcome save is caught and logged; revertPlanWrites returns its real result plus outcomePersistError", () => {
    // Control: identical revert with a working save.
    const ctl = makeRunDir("ar12-control");
    seedRevertable(ctl.root, ctl.runDir, "R");
    const control = revertPlanWrites(ctl.root, ctl.runDir);
    expect(control).not.toHaveProperty("outcomePersistError");

    const { root, runDir } = makeRunDir("ar12");
    const entries = seedRevertable(root, runDir, "R");
    const spy = failLiveRecordRename(runDir);
    let res;
    expect(() => { res = revertPlanWrites(root, runDir); }).not.toThrow();
    spy.mockRestore();
    expect(res.reverted).toEqual(control.reverted);
    expect(res.leftBehind).toEqual(control.leftBehind);
    expect(exists(path.join(root, "notes", "c.md"))).toBe(exists(path.join(ctl.root, "notes", "c.md")));
    expect(res.outcomePersistError).toMatchObject({ error: expect.any(String), detail: expect.stringContaining("injected persist failure") });
    expect(errSpy).toHaveBeenCalled();
    const rec = recordOf(runDir);
    expect(rec.revertOutcome).toBeUndefined();
    expect(rec.entries).toEqual(entries);
  });

  it("[AR13] an attempt whose revertOutcome could not be saved counts as no evidence and is never pruned", () => {
    const { root, runDir } = makeRunDir("ar13");
    const prunable = makePrunable(runDir, N + 1);
    seedRevertable(root, runDir, "R13", iso(-1000));
    const spy = failLiveRecordRename(runDir);
    const res = revertPlanWrites(root, runDir);
    spy.mockRestore();
    expect(res.outcomePersistError).toBeTruthy();
    // First rotation: R13 is the directory just created, so it is protected either way.
    expect(beginWriteRecordAttempt(runDir, { attemptId: "next" }).rotatedTo).toBe("apply/attempts/R13");
    // Second rotation: R13 is now an ordinary, oldest attempt. It must survive with N prunable newer ones present.
    liveWithEntry(root, runDir, "live2");
    beginWriteRecordAttempt(runDir, { attemptId: "final" });
    expect(listAttempts(runDir)).toEqual([...prunable.slice(-N), "R13", "live2"].sort());
  });

  it("[AR14] stampWriteRecordCompletion is best-effort: a failed save or a missing record is logged and returned, never thrown", () => {
    const stamp = { commitId: "abc1234", fullCommitId: `abc1234${"0".repeat(33)}` };

    const none = makeRunDir("ar14-none");
    let missing;
    expect(() => { missing = stampWriteRecordCompletion(none.runDir, stamp); }).not.toThrow();
    expect(missing).toMatchObject({ ok: false, error: expect.any(String) });

    const { runDir } = makeRunDir("ar14");
    fs.mkdirSync(path.dirname(writeRecordPath(runDir)), { recursive: true });
    const base = { version: 1, attemptId: "S", startedAt: iso(0), entries: [{ ...ENTRY, attemptId: "S" }] };
    fs.writeFileSync(writeRecordPath(runDir), JSON.stringify(base));
    errSpy.mockClear();
    const spy = failLiveRecordRename(runDir);
    let failed;
    expect(() => { failed = stampWriteRecordCompletion(runDir, stamp); }).not.toThrow();
    spy.mockRestore();
    expect(failed).toMatchObject({ ok: false, error: expect.any(String), detail: expect.stringContaining("injected persist failure") });
    expect(errSpy).toHaveBeenCalled();
    expect(recordOf(runDir).completion).toBeUndefined();

    const ok = stampWriteRecordCompletion(runDir, stamp);
    expect(ok).toMatchObject({ ok: true });
    const rec = recordOf(runDir);
    expect(rec.completion).toMatchObject(stamp);
    expect(new Date(rec.completion.at).toISOString()).toBe(rec.completion.at);
    expect(rec.entries).toEqual(base.entries);
  });
});
