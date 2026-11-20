/**
 * backlog.fix.exec-write-record-rotation-failure-diagnostics
 *
 * beginWriteRecordAttempt rotation failures: the thrown error names where the record and the
 * pre-images OBSERVABLY are after the failure, and an empty apply/attempts/<label>/ is removed
 * non-recursively. Failures are injected by spying on fs.renameSync on the shared default fs
 * object, which packages/mcp-rks/src/exec/backup.mjs calls through at call time.
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeTempDir } from "../helpers/tmp.mjs";
import {
  beginWriteRecordAttempt,
  writeRecordPath,
  PRE_IMAGE_RELATIVE_DIR,
  WRITE_RECORD_ATTEMPTS_RELATIVE_DIR,
} from "../../packages/mcp-rks/src/exec/backup.mjs";

const realRename = fs.renameSync;
const PRIOR = "prior-1";
const PRE_NAME = "a".repeat(64);
const RECORD_REL = "apply/write-record.json";
const PRE_REL = "apply/pre-images";
const MOVED_RECORD_REL = `apply/attempts/${PRIOR}/write-record.json`;
const MOVED_PRE_REL = `apply/attempts/${PRIOR}/pre-images`;
const cleanup = [];

function makeRun(tag, { record = true } = {}) {
  const root = makeTempDir(`wr-rotfail-${tag}`);
  cleanup.push(root);
  const runDir = path.join(root, ".rks", "runs", "r1");
  const recordFile = writeRecordPath(runDir);
  const preDir = path.join(runDir, PRE_IMAGE_RELATIVE_DIR);
  fs.mkdirSync(preDir, { recursive: true });
  fs.writeFileSync(path.join(preDir, PRE_NAME), "old bytes\n");
  if (record) fs.writeFileSync(recordFile, JSON.stringify({ version: 1, attemptId: PRIOR, entries: [] }));
  const dest = path.join(runDir, WRITE_RECORD_ATTEMPTS_RELATIVE_DIR, PRIOR);
  return { runDir, recordFile, preDir, dest, movedRecord: path.join(dest, "write-record.json") };
}

function injectRename(shouldFail, beforeThrow) {
  const injected = Object.assign(new Error("injected rename failure"), { code: "EIO" });
  vi.spyOn(fs, "renameSync").mockImplementation((src, dst) => {
    if (shouldFail(String(src), String(dst))) {
      if (beforeThrow) beforeThrow(String(src), String(dst));
      throw injected;
    }
    return realRename.call(fs, src, dst);
  });
  return injected;
}

function thrownBy(fn) {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error("expected beginWriteRecordAttempt to throw");
}

function listAttempts(runDir) {
  const dir = path.join(runDir, WRITE_RECORD_ATTEMPTS_RELATIVE_DIR);
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
}

const preBytes = (dir) => fs.readFileSync(path.join(dir, PRE_NAME), "utf8");

afterEach(() => {
  vi.restoreAllMocks();
  for (const p of cleanup.splice(0)) {
    try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

describe("beginWriteRecordAttempt rotation failure diagnostics", () => {
  it("[RF1] a failed record rename throws with the original cause, leaves no attempt dir, and keeps the record bytes in place", () => {
    const r = makeRun("rf1");
    const before = fs.readFileSync(r.recordFile);
    const injected = injectRename((src) => src === r.recordFile);
    const err = thrownBy(() => beginWriteRecordAttempt(r.runDir, { attemptId: "next" }));
    expect(err.cause).toBe(injected);
    expect(err.message).toContain("injected rename failure");
    expect(fs.existsSync(r.dest)).toBe(false);
    expect(listAttempts(r.runDir)).toEqual([]);
    expect(fs.readFileSync(r.recordFile).equals(before)).toBe(true);
    expect(preBytes(r.preDir)).toBe("old bytes\n");
  });

  it("[RF2] a failed pre-image rename with a successful move-back reports the record and pre-images at their original paths and removes the empty attempt dir", () => {
    const r = makeRun("rf2");
    const before = fs.readFileSync(r.recordFile);
    const injected = injectRename((src) => src === r.preDir);
    const err = thrownBy(() => beginWriteRecordAttempt(r.runDir, { attemptId: "next" }));
    expect(err.cause).toBe(injected);
    expect(err.recordAt).toBe(RECORD_REL);
    expect(err.preImagesAt).toBe(PRE_REL);
    expect(err.message).toContain(RECORD_REL);
    expect(err.message).toContain(PRE_REL);
    expect(fs.readFileSync(r.recordFile).equals(before)).toBe(true);
    expect(preBytes(r.preDir)).toBe("old bytes\n");
    expect(fs.existsSync(r.dest)).toBe(false);
  });

  it("[RF3] a failed pre-image rename and a failed move-back report the record under the attempt dir and the pre-images in place, deleting nothing", () => {
    const r = makeRun("rf3");
    const before = fs.readFileSync(r.recordFile);
    const injected = injectRename((src) => src === r.preDir || src === r.movedRecord);
    const err = thrownBy(() => beginWriteRecordAttempt(r.runDir, { attemptId: "next" }));
    expect(err.cause).toBe(injected);
    expect(err.recordAt).toBe(MOVED_RECORD_REL);
    expect(err.preImagesAt).toBe(PRE_REL);
    expect(err.message).toContain(MOVED_RECORD_REL);
    expect(err.message).toContain(PRE_REL);
    expect(fs.existsSync(r.recordFile)).toBe(false);
    expect(fs.readFileSync(r.movedRecord).equals(before)).toBe(true);
    expect(preBytes(r.preDir)).toBe("old bytes\n");
    expect(fs.existsSync(r.dest)).toBe(true);
  });

  it("[RF4] reported locations are observed, not intended: a pre-image rename that moved the directory and then threw reports the pre-images under the attempt dir", () => {
    const r = makeRun("rf4");
    const injected = injectRename(
      (src) => src === r.preDir,
      (src, dst) => realRename.call(fs, src, dst),
    );
    const err = thrownBy(() => beginWriteRecordAttempt(r.runDir, { attemptId: "next" }));
    expect(err.cause).toBe(injected);
    expect(err.preImagesAt).toBe(MOVED_PRE_REL);
    expect(err.recordAt).toBe(RECORD_REL);
    expect(preBytes(path.join(r.dest, "pre-images"))).toBe("old bytes\n");
    expect(fs.existsSync(r.dest)).toBe(true);
  });

  it("[RF5] with no prior record a failed pre-image rename reports recordAt null and leaves no attempt dir", () => {
    const r = makeRun("rf5", { record: false });
    const injected = injectRename((src) => src === r.preDir);
    const err = thrownBy(() => beginWriteRecordAttempt(r.runDir, { attemptId: "next" }));
    expect(err.cause).toBe(injected);
    expect(err.recordAt).toBeNull();
    expect(err.preImagesAt).toBe(PRE_REL);
    expect(listAttempts(r.runDir)).toEqual([]);
    expect(preBytes(r.preDir)).toBe("old bytes\n");
  });

  it("[RF6] cleanup after a failed record rename is non-recursive: a file already in the attempt dir survives", () => {
    const r = makeRun("rf6");
    const before = fs.readFileSync(r.recordFile);
    injectRename(
      (src) => src === r.recordFile,
      (src, dst) => fs.writeFileSync(path.join(path.dirname(dst), "intruder.txt"), "keep\n"),
    );
    thrownBy(() => beginWriteRecordAttempt(r.runDir, { attemptId: "next" }));
    expect(fs.readFileSync(path.join(r.dest, "intruder.txt"), "utf8")).toBe("keep\n");
    expect(fs.readFileSync(r.recordFile).equals(before)).toBe(true);
  });

  it("[RF7] cleanup after a failed pre-image rename is non-recursive: a file already in the attempt dir survives and the dir is kept", () => {
    const r = makeRun("rf7");
    injectRename(
      (src) => src === r.preDir,
      () => fs.writeFileSync(path.join(r.dest, "intruder.txt"), "keep\n"),
    );
    const err = thrownBy(() => beginWriteRecordAttempt(r.runDir, { attemptId: "next" }));
    expect(err.recordAt).toBe(RECORD_REL);
    expect(fs.existsSync(r.dest)).toBe(true);
    expect(fs.readFileSync(path.join(r.dest, "intruder.txt"), "utf8")).toBe("keep\n");
  });
});
