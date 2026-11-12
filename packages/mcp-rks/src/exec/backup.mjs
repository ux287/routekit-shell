import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { createHash } from "crypto";

/**
 * Paths exec must never take away from the user, in ANY direction.
 *
 * ONE list, three renderings. The previous code carried the same intent as three
 * separate literals — a `:(exclude)notes` on the stash, a `:!notes` on the
 * checkout, and `--exclude=.rks --exclude=notes` on the clean — and they
 * disagreed. `createBackup` stashed `.rks/` state that `cleanupWorkingTree` was
 * careful to preserve, so a child project's committed `.rks/project.json` went
 * into a stash and never came back.
 *
 * A test written to assert those literals agreed passed anyway, because it
 * checked `notes/` and the divergence was one directory over. Deriving all three
 * from this array is what makes the agreement structural: there is no second
 * list to fall out of step with.
 *
 * - `notes/`    — governor-managed story metadata; the phase write lives here.
 * - `.rks/`     — rks state, diagnostics, telemetry, project config.
 * - `.routekit/`— runtime state and hook configuration.
 *
 * These mirror the exemptions in `computeUnexpectedFiles` (server/test-runner.mjs)
 * and `getUncommittedFiles` (utils/git.mjs). Adding a path here without adding
 * it there — or vice versa — reintroduces the asymmetry this constant exists to
 * eliminate.
 */
export const PROTECTED_PATHS = ["notes", ".rks", ".routekit"];

/** `git stash push` form: magic exclude pathspecs. */
export const PROTECTED_PATHSPEC_EXCLUDES = PROTECTED_PATHS.map(p => `:(exclude)${p}`);

/** `git checkout` form: short exclude pathspecs. Spares TRACKED files. */
export const PROTECTED_CHECKOUT_EXCLUDES = PROTECTED_PATHS.map(p => `:!${p}`);

export function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function copyRecursive(src, dest) {
  const stats = fs.statSync(src);
  if (stats.isDirectory()) {
    ensureDir(dest);
    for (const name of fs.readdirSync(src)) {
      // skip special directories
      if (name === ".rks" || name === ".git" || name === "node_modules") continue;
      const s = path.join(src, name);
      const d = path.join(dest, name);
      copyRecursive(s, d);
    }
  } else if (stats.isFile()) {
    ensureDir(path.dirname(dest));
    fs.copyFileSync(src, dest);
  }
}

/**
 * Resolve the current tip of the stash reflog as a commit SHA.
 *
 * `git rev-parse -q --verify refs/stash` exits non-zero with empty stdout when
 * the repo has never stashed, so a null return means "no stash ref exists".
 * This is the only reliable machine discriminator for "did we create a stash":
 * `git stash push` prints `Saved working directory and index state ...` and
 * never emits a `stash@{N}` reflog selector, so stdout cannot be parsed for one.
 */
function readStashSha(projectRoot) {
  const res = spawnSync("git", ["rev-parse", "-q", "--verify", "refs/stash"], { cwd: projectRoot, encoding: "utf8" });
  if (res.status !== 0) return null;
  const sha = (res.stdout || "").trim();
  return sha || null;
}

/**
 * Build the pathspec passed after `--` to the backup stash push.
 *
 * Starts from `:/` and, per protected path, keeps today's `:(exclude)<p>` EXCEPT
 * when `<p>` is itself gitignored (`check-ignore -q` exits 0) AND nothing is
 * tracked beneath it (`ls-files -z` exits 0 with empty output). Git refuses a
 * pathspec that names such a path ("The following paths are ignored by one of
 * your .gitignore files"), exits 1 after saving the entry, and leaves the tree
 * uncleared. Omitting the exclude there is safe: git does not descend into an
 * excluded directory, so every untracked entry beneath it is ignored, and
 * `stash push -u` (without `-a`) never stashes ignored files; with nothing
 * tracked beneath it, the stash records and removes nothing under `<p>`.
 *
 * Every other case keeps the exclude, including a path with only ignored
 * children. An ignored protected path with a tracked entry beneath it also
 * keeps the exclude; that layout still fails as before and is a known unfixed
 * case. The result is always a subset of today's items, in today's order, so
 * argv never grows.
 *
 * Fail closed: any probe status outside its expected set, or a probe spawn
 * error, keeps the exclude and records a warning naming the path and probe.
 *
 * @param {string} projectRoot
 * @param {{ run?: Function }} [opts] spawnSync-compatible runner for the probes only.
 * @returns {{ pathspec: string[], warnings: string[] }}
 */
export function buildStashPathspec(projectRoot, { run = spawnSync } = {}) {
  const pathspec = [":/"];
  const warnings = [];
  const probe = (args) => run("git", args, { cwd: projectRoot, encoding: "utf8", timeout: 30_000 });
  const describeProbe = (r) => (r && r.error)
    ? `spawn error: ${r.error.message}`
    : `exit ${r ? r.status : "unknown"}${r && r.stderr ? `: ${String(r.stderr).trim()}` : ""}`;

  for (const p of PROTECTED_PATHS) {
    const exclude = `:(exclude)${p}`;
    const ci = probe(["check-ignore", "-q", "--", p]);
    if (!ci || ci.error || (ci.status !== 0 && ci.status !== 1)) {
      warnings.push(`protected path '${p}': git check-ignore probe failed (${describeProbe(ci)}); keeping ${exclude}`);
      pathspec.push(exclude);
      continue;
    }
    if (ci.status === 1) {
      pathspec.push(exclude);
      continue;
    }
    const ls = probe(["ls-files", "-z", "--", p]);
    if (!ls || ls.error || ls.status !== 0) {
      warnings.push(`protected path '${p}': git ls-files probe failed (${describeProbe(ls)}); keeping ${exclude}`);
      pathspec.push(exclude);
      continue;
    }
    if ((ls.stdout || "") !== "") pathspec.push(exclude);
    // else: ignored with nothing tracked beneath it, so no item for p.
  }
  return { pathspec, warnings };
}

export function createBackup(projectRoot, problemId = null, { pathspecRunner, stashRunner } = {}) {
  const backupsDir = path.join(projectRoot, ".rks", "backups");
  ensureDir(backupsDir);
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const folder = path.join(backupsDir, `backup-${ts}`);
  ensureDir(folder);

  // If repo has git, try to stash (preferred; fast and reversible)
  if (fs.existsSync(path.join(projectRoot, ".git"))) {
    // notes/ is deliberately excluded: a pathspec-less stash resets index AND
    // worktree to HEAD, which reverts the story note's phase to its last
    // committed value. cleanupWorkingTree already excludes notes at :130/:138;
    // this makes createBackup agree with it.
    // ':/' is git's everything-from-the-root magic (cwd-independent, unlike '.').
    // '--' is optional after an explicit `push`, but is included so a pathspec
    // beginning with ':' can never be re-parsed as an option.
    const message = problemId ? `rks.exec backup ${problemId} ${ts}` : `rks.exec backup ${ts}`;
    const beforeSha = readStashSha(projectRoot);
    // Pathspec: ':/' plus each protected path's exclude, minus any protected
    // path that is itself gitignored with nothing tracked beneath it (see
    // buildStashPathspec). Probe failures fall back to the exclude and are
    // logged here, since no consumer reads the returned field.
    const { pathspec, warnings: pathspecWarnings } = buildStashPathspec(
      projectRoot,
      pathspecRunner ? { run: pathspecRunner } : {},
    );
    for (const w of pathspecWarnings) {
      console.error(`[rks.exec] backup pathspec warning: ${w}`);
    }
    const runStash = stashRunner || spawnSync;
    const res = runStash("git", ["stash", "push", "-u", "-m", message, "--", ...pathspec], { cwd: projectRoot, encoding: "utf8" });
    const stashSpawnError = res && res.error ? String(res.error.message) : null;
    if (stashSpawnError !== null) {
      console.error(`[rks.exec] backup stash spawn error: ${stashSpawnError}`);
    }
    const success = res.status === 0;
    const msg = (res.stdout || res.stderr || "").trim();
    const afterSha = readStashSha(projectRoot);
    // Content-addressed handle. Note `success` is TRUE when there was nothing to
    // stash — `git stash push` exits 0 and prints "No local changes to save" —
    // so `success` cannot discriminate; only the ref movement can.
    const stashCreated = Boolean(afterSha) && afterSha !== beforeSha;
    return {
      type: "git-stash",
      success,
      msg,
      stashCreated,
      stashSha: stashCreated ? afterSha : null,
      problemId,
      pathspecWarnings,
      stashSpawnError,
    };
  }

  // Non-git fallback: copy files (exclude .rks, .git, node_modules)
  for (const name of fs.readdirSync(projectRoot)) {
    if (name === ".rks" || name === ".git" || name === "node_modules") continue;
    const s = path.join(projectRoot, name);
    const d = path.join(folder, name);
    copyRecursive(s, d);
  }
  return { type: "file-copy", path: folder };
}

export function restoreBackup(projectRoot, backupMeta) {
  if (!backupMeta) return { restored: false, error: "no backupMeta provided" };

  if (backupMeta.type === "git-stash") {
    // No stash was created for this run — there is nothing of ours to restore.
    // Selecting "the newest entry matching 'rks.exec backup'" here would pop an
    // UNRELATED run's stash: the substring carries no run identity, and orphaned
    // entries accumulate. Since the stash excludes notes/, "nothing stashed" is
    // the normal outcome, so this branch is the common case.
    if (!backupMeta.stashCreated || !backupMeta.stashSha) {
      // `nothingToRestore` is the STRUCTURED discriminator the rolledBack derivation reads
      // (test-runner.mjs deriveRolledBack). It must not be inferred from the error text.
      return { restored: false, nothingToRestore: true, error: "no backup stash was created for this run — nothing to restore" };
    }

    // A SHA handle forces `apply`: git documents that `pop` accepts only a
    // stash@{N} reference. Dropping is a separate SHA-equality step.
    const applyRes = spawnSync("git", ["stash", "apply", backupMeta.stashSha], { cwd: projectRoot, encoding: "utf8" });
    const msg = (applyRes.stdout || applyRes.stderr || "").trim();
    if (applyRes.status !== 0) {
      return { restored: false, msg, error: msg || `git stash apply ${backupMeta.stashSha} failed with status ${applyRes.status}` };
    }
    return { restored: true, msg, stashSha: backupMeta.stashSha };
  }

  if (backupMeta.type === "file-copy") {
    const from = backupMeta.path;
    if (!from || !fs.existsSync(from)) return { restored: false, error: "backup folder not found" };
    // Copy back into project (overwrite)
    copyRecursive(from, projectRoot);
    return { restored: true, path: from };
  }

  return { restored: false, error: "unknown backup type" };
}

/**
 * Drop the backup stash this run created, on the exec SUCCESS path.
 *
 * Selection is BY SHA EQUALITY ONLY. Dropping "the newest entry matching
 * 'rks.exec backup'" would be the same wrong-target defect as the old restore
 * fall-through, but with its consequence inverted from "restore the wrong
 * content" into "destroy someone else's content" — and git documents that
 * dropped stash entries are not recoverable through the normal safety
 * mechanisms. If no row matches the recorded SHA, this drops NOTHING.
 *
 * @returns {{ dropped: boolean, ref?: string, reason?: string, error?: string }}
 */
export function dropBackupStash(projectRoot, backupMeta) {
  if (!backupMeta || backupMeta.type !== "git-stash") {
    return { dropped: false, reason: "not-a-git-stash-backup" };
  }
  if (!backupMeta.stashCreated || !backupMeta.stashSha) {
    return { dropped: false, reason: "no-stash-created" };
  }

  const list = spawnSync("git", ["stash", "list", "--format=%gd %H"], { cwd: projectRoot, encoding: "utf8" });
  if (list.status !== 0) {
    const err = (list.stderr || "").trim();
    return { dropped: false, error: err || `git stash list failed with status ${list.status}` };
  }

  let ref = null;
  for (const line of (list.stdout || "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const sep = trimmed.indexOf(" ");
    if (sep === -1) continue;
    const gd = trimmed.slice(0, sep);
    const sha = trimmed.slice(sep + 1).trim();
    if (sha === backupMeta.stashSha) {
      ref = gd;
      break;
    }
  }

  // No row matched: the entry was already dropped, or something else moved it.
  // Drop nothing rather than guessing at a positional ref.
  if (!ref) {
    return { dropped: false, reason: "sha-not-found-in-stash-list" };
  }

  const drop = spawnSync("git", ["stash", "drop", ref], { cwd: projectRoot, encoding: "utf8" });
  if (drop.status !== 0) {
    const err = (drop.stderr || drop.stdout || "").trim();
    return { dropped: false, ref, error: err || `git stash drop ${ref} failed with status ${drop.status}` };
  }
  return { dropped: true, ref };
}

/**
 * Capture the current working tree diff before cleanup.
 * Saves both staged and unstaged diffs to a diagnostics file.
 * @returns {{ captured: boolean, diffPath?: string, error?: string }}
 */
export function capturePartialDiff(projectRoot, runDir) {
  try {
    const diagDir = runDir
      ? path.join(runDir, "diagnostics")
      : path.join(projectRoot, ".rks", "exec-diagnostics");
    ensureDir(diagDir);
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const diffPath = path.join(diagDir, `${ts}-partial.diff`);

    const unstaged = spawnSync("git", ["diff"], { cwd: projectRoot, encoding: "utf8" });
    const staged = spawnSync("git", ["diff", "--cached"], { cwd: projectRoot, encoding: "utf8" });
    const status = spawnSync("git", ["status", "--short"], { cwd: projectRoot, encoding: "utf8" });

    const content = [
      `# Partial diff captured at ${new Date().toISOString()}`,
      `# Working tree status:`,
      status.stdout || "(clean)",
      "",
      "# === Unstaged changes ===",
      unstaged.stdout || "(none)",
      "",
      "# === Staged changes ===",
      staged.stdout || "(none)",
    ].join("\n");

    fs.writeFileSync(diffPath, content);
    return { captured: true, diffPath };
  } catch (error) {
    return { captured: false, error: error.message };
  }
}

/**
 * Reset working tree to match HEAD exactly.
 * Restores deleted/modified tracked files and removes untracked artifacts.
 * This is the safety net after restoreBackup — guarantees clean state.
 * @returns {{ cleaned: boolean, method: string, error?: string }}
 */
export function cleanupWorkingTree(projectRoot) {
  try {
    // Restore all TRACKED files to HEAD, sparing every protected path.
    //
    // The exclusion list here previously covered only notes/. That mattered
    // more than it looked: `git clean --exclude=.rks` below spares only
    // UNTRACKED files, so a tracked, committed .rks/project.json — which is
    // what a child project has — was reverted by this checkout on every
    // rollback, silently undoing the stash restore two steps earlier.
    const checkout = spawnSync("git", ["checkout", "--", ".", ...PROTECTED_CHECKOUT_EXCLUDES], { cwd: projectRoot, encoding: "utf8" });
    if (checkout.status !== 0) {
      return { cleaned: false, method: "git-checkout", error: (checkout.stderr || "").trim() };
    }

    // Remove untracked files (artifacts from failed plan), sparing the same set:
    // .rks/ diagnostics and telemetry, .routekit/ runtime state, and notes/
    // story metadata from failed builds.
    const clean = spawnSync("git", ["clean", "-fd", ...PROTECTED_PATHS.map(p => `--exclude=${p}`)], { cwd: projectRoot, encoding: "utf8" });

    // OBSERVED, not asserted. This returned the literal `true` while never
    // consulting `clean.status`, so a failed cleanup still reported a cleaned
    // tree — and that value is now carried onto an operator-facing receipt,
    // where a wrong `cleaned` sends the operator looking in the wrong place.
    // Every sibling field here is already observation-sourced.
    return {
      cleaned: clean.status === 0,
      method: "git-checkout+clean",
      details: (clean.stdout || "").trim(),
      ...(clean.status === 0
        ? {}
        : { error: (clean.stderr || "").trim() || `cleanup exited ${clean.status}` }),
    };
  } catch (error) {
    return { cleaned: false, method: "git-checkout", error: error.message };
  }
}

// ── Plan write record (backlog.fix.exec-rollback-orphans-created-files) ──────────
//
// WHY THIS EXISTS. Every rollback step (the backup stash, the checkout and the clean)
// excludes PROTECTED_PATHS, deliberately: a failed build must not take the story note,
// Governor note commits, telemetry or session state with it
// (backlog.z_implemented.fix.preserve-notes-on-rollback). But a blanket path rule
// cannot tell "written by this plan" from "not written by this plan", so a plan's own
// create_file under notes/ survived rollback and deadlocked the retry with
// create_file_already_exists, and a plan's edit to an existing note survived too.
//
// The fix is PROVENANCE, not a narrower path rule. Immediately BEFORE a plan step
// writes a target, the apply path records whether the target existed and, if it did,
// a content-addressed copy of its exact prior bytes. Immediately AFTER, it records the
// hash of what the plan left on disk. rollback() then reverts only the plan's own
// protected-path writes, and only when the file still holds what the plan wrote.
//
// ONE helper, ONE record: runApplyTool (exec.mjs) and applyFixPlan (fix-planner.mjs)
// both record here, into <runDir>/apply/write-record.json. It lives in backup.mjs
// because exec.mjs imports fix-planner.mjs, so a helper in exec.mjs would be circular.
// The record is run-directory state; nothing stages or commits it.

/** Record file, relative to the run directory. */
export const WRITE_RECORD_RELATIVE_PATH = path.join("apply", "write-record.json");
/** Content-addressed pre-image store, relative to the run directory. */
export const PRE_IMAGE_RELATIVE_DIR = path.join("apply", "pre-images");

const SHA256_HEX = /^[0-9a-f]{64}$/;

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

/** The run's write-record path, or null when there is no run directory. */
export function writeRecordPath(runDir) {
  return runDir ? path.join(runDir, WRITE_RECORD_RELATIVE_PATH) : null;
}

/** Normalize a plan target into the record's key form (posix, no leading ./). */
function recordKey(target) {
  const posix = String(target).replace(/\\/g, "/");
  return path.posix.normalize(posix).replace(/^(\.\/)+/, "");
}

/**
 * Read the run's write record.
 * @returns {{ status: "absent" } | { status: "ok", record: object } | { status: "unparseable", error: string }}
 */
export function readWriteRecord(runDir) {
  return readRecordFile(writeRecordPath(runDir));
}

/** readWriteRecord for an explicit record file path (also used for rotated attempt records). */
function readRecordFile(file) {
  if (!file || !fs.existsSync(file)) return { status: "absent" };
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    return { status: "unparseable", error: `unreadable: ${err.message}` };
  }
  try {
    const record = JSON.parse(raw);
    if (!record || typeof record !== "object" || !Array.isArray(record.entries)) {
      return { status: "unparseable", error: "record has no entries array" };
    }
    return { status: "ok", record };
  } catch (err) {
    return { status: "unparseable", error: err.message };
  }
}

function persistTmpPath(runDir) {
  return `${writeRecordPath(runDir)}.${process.pid}.tmp`;
}

function persistWriteRecord(runDir, record) {
  const file = writeRecordPath(runDir);
  ensureDir(path.dirname(file));
  const tmp = persistTmpPath(runDir);
  fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file);
}

/** Best-effort removal of a temp file a failed persistWriteRecord left behind. */
function removePersistTmp(runDir) {
  try { fs.rmSync(persistTmpPath(runDir), { force: true }); } catch { /* best effort */ }
}

/**
 * Stamp the CURRENT attempt's write record with the commit that completed it
 * (backlog.fix.exec-write-record-attempt-retention): record.completion = { at, commitId, fullCommitId }.
 * The stamp is evidence that the attempt committed, which lets retention prune it later.
 *
 * Best-effort and NEVER throws: it runs on the exec path after a commit, where a throw could turn
 * a successful exec into a failure. A missing or unparseable record, or a failed save, is logged
 * with console.error and returned as { ok: false, error, detail }; the record is left unchanged.
 * A missing stamp only keeps the attempt unprunable, which is the safe direction.
 *
 * @param {string|null|undefined} runDir
 * @param {{ commitId?: string|null, fullCommitId?: string|null }} stamp
 * @returns {{ ok: true } | { ok: false, error: string, detail: string }}
 */
export function stampWriteRecordCompletion(runDir, { commitId = null, fullCommitId = null } = {}) {
  const fail = (error, detail) => {
    console.error(`[rks.exec] write-record completion stamp not saved (${error}): ${detail}`);
    return { ok: false, error, detail };
  };
  try {
    if (!runDir) return fail("no_run_dir", "no run directory");
    const read = readWriteRecord(runDir);
    if (read.status === "absent") return fail("write_record_absent", `no write record at ${writeRecordPath(runDir)}`);
    if (read.status === "unparseable") return fail("write_record_unparseable", read.error);
    const record = {
      ...read.record,
      completion: {
        at: new Date().toISOString(),
        commitId: typeof commitId === "string" && commitId ? commitId : null,
        fullCommitId: typeof fullCommitId === "string" && fullCommitId ? fullCommitId : null,
      },
    };
    try {
      persistWriteRecord(runDir, record);
    } catch (err) {
      removePersistTmp(runDir);
      return fail("completion_stamp_persist_failed", err?.message || String(err));
    }
    return { ok: true };
  } catch (err) {
    return fail("completion_stamp_failed", err?.message || String(err));
  }
}

function loadRecordForWrite(runDir) {
  const read = readWriteRecord(runDir);
  if (read.status === "absent") return { version: 1, entries: [] };
  if (read.status === "unparseable") {
    // Never overwrite a record we cannot read: that would erase earlier pre-images.
    // Failing here stops the plan write, so nothing un-revertible lands on disk.
    throw new Error(`plan write record ${writeRecordPath(runDir)} is unparseable (${read.error}); refusing to write a plan target without a pre-image`);
  }
  return read.record;
}

/** Directory previous attempts' records are moved into, relative to the run directory. */
export const WRITE_RECORD_ATTEMPTS_RELATIVE_DIR = path.join("apply", "attempts");

/** A directory-name-safe label: no path separators, no colons (Windows-safe). */
function attemptLabel(raw) {
  return String(raw).replace(/[:/\\]/g, "-").replace(/^\.+/, "_");
}

/** Posix run-dir-relative path of the first candidate that exists on disk, else null. */
function observedAt(runDir, candidates) {
  for (const p of candidates) {
    if (fs.existsSync(p)) return path.relative(runDir, p).split(path.sep).join("/");
  }
  return null;
}

/**
 * How many PRUNABLE attempt directories apply/attempts/ keeps after a rotation
 * (backlog.fix.exec-write-record-attempt-retention). Non-prunable directories and the directory the
 * rotation just created are kept on top of these and never count against the limit.
 */
export const WRITE_RECORD_ATTEMPTS_KEEP = 10;

/** True when dir is absent, or is a directory with no entries. Anything else counts as non-empty. */
function isAbsentOrEmptyDir(dir) {
  let stat;
  try { stat = fs.lstatSync(dir); } catch (err) { return Boolean(err && err.code === "ENOENT"); }
  if (!stat.isDirectory()) return false;
  try { return fs.readdirSync(dir).length === 0; } catch { return false; }
}

/**
 * Fail-closed prunable test for one rotated attempt directory. Prunable ONLY when its record parses
 * AND (a) entries is empty with no pre-images, or (b) a persisted revertOutcome has an empty
 * leftBehind, or (c) a persisted completion names a commit. Everything else (no record, unparseable
 * record, leftBehind not empty, no outcome evidence, stray pre-images) is kept.
 * Returns { at } (ms, for ordering) when prunable, else null.
 */
function prunableAttempt(dir) {
  const read = readRecordFile(path.join(dir, path.basename(WRITE_RECORD_RELATIVE_PATH)));
  if (read.status !== "ok") return null;
  const record = read.record;
  const noPreImages = isAbsentOrEmptyDir(path.join(dir, path.basename(PRE_IMAGE_RELATIVE_DIR)));
  const emptyAttempt = record.entries.length === 0 && noPreImages;
  const outcome = record.revertOutcome;
  const cleanRevert = Boolean(outcome && typeof outcome === "object" && Array.isArray(outcome.leftBehind) && outcome.leftBehind.length === 0);
  // A persisted revert that left files behind (or an outcome we cannot read as clean) means the
  // pre-images may be the ONLY copy of pre-run bytes: never prunable, whatever else the record says.
  if (outcome !== undefined && !cleanRevert) return null;
  const completion = record.completion;
  const committed = Boolean(completion && typeof completion === "object" && typeof completion.commitId === "string" && completion.commitId);
  if (!emptyAttempt && !cleanRevert && !committed) return null;
  let at = typeof record.startedAt === "string" ? Date.parse(record.startedAt) : NaN;
  if (!Number.isFinite(at)) at = fs.statSync(dir).mtimeMs;
  return { at };
}

/**
 * After a successful rotation, prune apply/attempts/ to the WRITE_RECORD_ATTEMPTS_KEEP most recent
 * PRUNABLE directories (ordered by the record's startedAt, falling back to directory mtime). The
 * directory this rotation just created (keepLabel) is never a candidate. NEVER throws: any failure
 * is logged with console.warn and the directory stays.
 */
function pruneAttempts(runDir, keepLabel) {
  const attemptsDir = path.join(runDir, WRITE_RECORD_ATTEMPTS_RELATIVE_DIR);
  try {
    const candidates = [];
    for (const name of fs.readdirSync(attemptsDir)) {
      if (name === keepLabel) continue;
      const dir = path.join(attemptsDir, name);
      try {
        if (!fs.lstatSync(dir).isDirectory()) continue;
        const prunable = prunableAttempt(dir);
        if (prunable) candidates.push({ name, dir, at: prunable.at });
      } catch (err) {
        console.warn(`[rks.exec] write-record retention: could not assess ${dir}; kept (${err?.message || err})`);
      }
    }
    if (candidates.length <= WRITE_RECORD_ATTEMPTS_KEEP) return;
    candidates.sort((x, y) => (x.at - y.at) || (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
    for (const { dir } of candidates.slice(0, candidates.length - WRITE_RECORD_ATTEMPTS_KEEP)) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch (err) {
        console.warn(`[rks.exec] write-record retention: could not prune ${dir}; kept (${err?.message || err})`);
      }
    }
  } catch (err) {
    console.warn(`[rks.exec] write-record retention: pruning ${attemptsDir} failed; nothing more pruned (${err?.message || err})`);
  }
}

/** Remove dir only if it is empty: rmdirSync is non-recursive, so a non-empty dir survives. */
function removeDirIfEmpty(dir) {
  try { fs.rmdirSync(dir); } catch { /* non-empty or already gone: keep it */ }
}

/**
 * The error beginWriteRecordAttempt throws when rotation fails
 * (backlog.fix.exec-write-record-rotation-failure-diagnostics). It keeps the original error as
 * `cause` and states, as posix run-dir-relative paths observed after the failure, where the
 * record (`recordAt`) and the pre-image store (`preImagesAt`) are; null means not present.
 */
function rotationFailure(runDir, cause, step, { recordAt, preImagesAt }) {
  const where = (p) => (p === null ? "none" : p);
  const err = new Error(
    `beginWriteRecordAttempt: rotation failed while ${step}: ${cause?.message ?? String(cause)}. ` +
      `Write record is at: ${where(recordAt)}; pre-images are at: ${where(preImagesAt)} ` +
      `(relative to run dir ${runDir})`,
    { cause },
  );
  err.recordAt = recordAt;
  err.preImagesAt = preImagesAt;
  if (cause && typeof cause === "object" && cause.code) err.code = cause.code;
  return err;
}

/**
 * Begin a new exec attempt's write record (backlog.fix.exec-write-record-attempt-scope).
 *
 * The record is run-directory state, and one run directory can see several rks_exec
 * calls. A record carried over from a previous attempt would make rollback write back
 * that attempt's stale pre-image, or delete a file that attempt created and the operator
 * kept. So each attempt starts from a clean record.
 *
 * Any existing record and pre-image store are MOVED (never deleted) into
 * apply/attempts/<label>/, where <label> is the prior record's attemptId or, for a record
 * without one, `pre-attempt-<ISO timestamp>` with `:` and `.` written as `-`. A colliding label
 * gets a numeric suffix; an existing directory is never written into. Then a fresh
 * record { version: 1, attemptId, startedAt, entries: [] } is written atomically.
 *
 * backlog.fix.exec-write-record-attempt-retention: an empty record (parses, entries [], no or an
 * empty pre-image store) is overwritten in place, not rotated (rotatedTo null). After a rotation,
 * apply/attempts/ is pruned to the WRITE_RECORD_ATTEMPTS_KEEP most recent prunable directories
 * (see prunableAttempt); the directory just created is never pruned and pruning never throws.
 *
 * No-op returning null when runDir is falsy. THROWS when the rotation or the fresh write
 * fails: the caller must not write a plan target with a record it could not reset. A rotation
 * failure throws an Error with the original error as `cause` and `recordAt` / `preImagesAt`
 * naming where those pieces were observed afterwards; an attempt directory left empty by the
 * failure is removed non-recursively, and a non-empty one is kept.
 *
 * @param {string|null|undefined} runDir
 * @param {{ attemptId: string }} opts
 * @returns {{ attemptId: string, rotatedTo: string|null } | null}
 */
export function beginWriteRecordAttempt(runDir, { attemptId } = {}) {
  if (!runDir) return null;
  if (typeof attemptId !== "string" || !attemptId) {
    throw new Error("beginWriteRecordAttempt: attemptId must be a non-empty string");
  }
  const recordFile = writeRecordPath(runDir);
  const preDir = path.join(runDir, PRE_IMAGE_RELATIVE_DIR);
  const hasRecord = fs.existsSync(recordFile);
  const hasPreImages = fs.existsSync(preDir);

  // backlog.fix.exec-write-record-attempt-retention (Part 1): an EMPTY record (parses, entries [],
  // no pre-image store or an empty one) carries nothing a rollback could need, so it is overwritten
  // in place instead of rotated. An unparseable record is never overwritten: it still rotates.
  const overwriteInPlace = hasRecord
    && (() => {
      const prior = readWriteRecord(runDir);
      return prior.status === "ok" && prior.record.entries.length === 0;
    })()
    && isAbsentOrEmptyDir(preDir);

  let rotatedTo = null;
  let rotatedLabel = null;
  if (!overwriteInPlace && (hasRecord || hasPreImages)) {
    let priorId = null;
    if (hasRecord) {
      const prior = readWriteRecord(runDir);
      if (prior.status === "ok" && typeof prior.record.attemptId === "string" && prior.record.attemptId) {
        priorId = prior.record.attemptId;
      }
    }
    // Run-directory style timestamp: `:` and `.` become `-` (legal in every filename).
    const baseLabel = attemptLabel(priorId ?? `pre-attempt-${new Date().toISOString().replace(/[:.]/g, "-")}`);
    const attemptsDir = path.join(runDir, WRITE_RECORD_ATTEMPTS_RELATIVE_DIR);
    fs.mkdirSync(attemptsDir, { recursive: true });
    let label = baseLabel;
    let dest = path.join(attemptsDir, label);
    for (let n = 2; fs.existsSync(dest); n += 1) {
      label = `${baseLabel}-${n}`;
      dest = path.join(attemptsDir, label);
    }
    // mkdirSync without recursive fails if dest appeared meanwhile: never merge into it.
    fs.mkdirSync(dest);
    const movedRecord = path.join(dest, path.basename(recordFile));
    const movedPreDir = path.join(dest, path.basename(preDir));
    if (hasRecord) {
      try {
        fs.renameSync(recordFile, movedRecord);
      } catch (err) {
        removeDirIfEmpty(dest);
        throw rotationFailure(runDir, err, "moving the write record", {
          recordAt: observedAt(runDir, [recordFile, movedRecord]),
          preImagesAt: hasPreImages ? observedAt(runDir, [preDir, movedPreDir]) : null,
        });
      }
    }
    if (hasPreImages) {
      try {
        fs.renameSync(preDir, movedPreDir);
      } catch (err) {
        // Keep the record next to its pre-images: put it back before failing.
        if (hasRecord) {
          // If this also fails, the record stays (intact) under dest; the error below says so.
          try { fs.renameSync(movedRecord, recordFile); } catch { /* reported via recordAt */ }
        }
        // Report where each piece OBSERVABLY is now, not where it was meant to go.
        const recordAt = hasRecord ? observedAt(runDir, [recordFile, movedRecord]) : null;
        const preImagesAt = observedAt(runDir, [preDir, movedPreDir]);
        removeDirIfEmpty(dest);
        throw rotationFailure(runDir, err, "moving the pre-image store", { recordAt, preImagesAt });
      }
    }
    rotatedTo = path.join(WRITE_RECORD_ATTEMPTS_RELATIVE_DIR, label).split(path.sep).join("/");
    rotatedLabel = label;
  }

  persistWriteRecord(runDir, { version: 1, attemptId, startedAt: new Date().toISOString(), entries: [] });
  // Retention runs only after a successful rotation and the fresh write; it never throws.
  if (rotatedLabel !== null) pruneAttempts(runDir, rotatedLabel);
  return { attemptId, rotatedTo };
}

/**
 * Record a target's pre-image BEFORE a plan step writes it. The FIRST pre-image for a
 * target wins: a later write (another step, or a fix plan) leaves it untouched, so
 * rollback restores the true pre-run state. No-op when runDir is absent.
 * Throws when the record cannot be written, so the caller does not write unrecorded.
 *
 * @param {string} projectRoot
 * @param {string|null|undefined} runDir
 * @param {string} target plan target, relative to projectRoot
 * @param {{ source?: string }} [opts]
 */
export function recordPlanPreImage(projectRoot, runDir, target, { source = "plan" } = {}) {
  if (!runDir || !target) return null;
  // backlog.fix.exec-write-record-hardening: the ONE path the writer also writes; throws on an
  // absolute target or one that resolves outside projectRoot, before anything is recorded.
  const absPath = resolvePlanTarget(projectRoot, target);
  const key = recordKey(target);
  const record = loadRecordForWrite(runDir);
  // lstat, as revert does: a symlink (or any non-regular file) at the target is refused here, so
  // the plan never writes through it and the record never holds a referent's bytes.
  const stat = lstatOrNull(absPath);
  if (stat && !stat.isFile()) {
    throw new Error(`plan target ${target} is not a regular file (symlink, directory or special file); refusing to record or write through it`);
  }
  const existing = record.entries.find((e) => e && e.target === key);
  if (existing) return existing;

  let entry;
  if (stat) {
    const bytes = fs.readFileSync(absPath);
    const preImageHash = sha256(bytes);
    const preDir = path.join(runDir, PRE_IMAGE_RELATIVE_DIR);
    ensureDir(preDir);
    const prePath = path.join(preDir, preImageHash);
    if (!fs.existsSync(prePath)) fs.writeFileSync(prePath, bytes);
    entry = { target: key, existed: true, preImageHash, postExists: null, postHash: null, source, recordedAt: new Date().toISOString() };
  } else {
    entry = { target: key, existed: false, preImageHash: null, postExists: null, postHash: null, source, recordedAt: new Date().toISOString() };
  }
  // Directories the write will have to create (they do not exist now), root-relative, deepest
  // first. The writer records BEFORE it creates any directory, so these are exactly the plan's own.
  entry.createdDirs = missingParentDirs(projectRoot, absPath);
  // The attempt this entry belongs to; revertPlanWrites never touches another attempt's entry.
  entry.attemptId = typeof record.attemptId === "string" && record.attemptId ? record.attemptId : null;
  record.entries.push(entry);
  persistWriteRecord(runDir, record);
  return entry;
}

/**
 * Record what a plan step left on disk AFTER it wrote a target. The LAST post-write
 * hash wins. A delete records postExists false and a null hash. No-op when runDir is
 * absent or the target has no pre-image entry.
 */
export function recordPlanPostWrite(projectRoot, runDir, target) {
  if (!runDir || !target) return null;
  const absPath = resolvePlanTarget(projectRoot, target);
  const key = recordKey(target);
  const record = loadRecordForWrite(runDir);
  const entry = record.entries.find((e) => e && e.target === key);
  if (!entry) return null;
  try {
    const stat = lstatOrNull(absPath);
    if (stat && !stat.isFile()) {
      throw new Error(`plan target ${target} is not a regular file (symlink, directory or special file)`);
    }
    if (stat) {
      entry.postExists = true;
      entry.postHash = sha256(fs.readFileSync(absPath));
    } else {
      entry.postExists = false;
      entry.postHash = null;
    }
    delete entry.postError;
  } catch (err) {
    // The write already happened. Persist WHY no post-write hash exists (best effort), so revert
    // reports the recording failure instead of the generic "no post-write hash" reason.
    const message = err?.message || String(err);
    entry.postExists = null;
    entry.postHash = null;
    entry.postError = message;
    entry.postRecordedAt = new Date().toISOString();
    try { persistWriteRecord(runDir, record); } catch { /* best effort; the rethrow below still stops the plan */ }
    throw new Error(`post-write hash recording failed for plan target ${target}: ${message}`);
  }
  entry.postRecordedAt = new Date().toISOString();
  persistWriteRecord(runDir, record);
  return entry;
}

/** lstat that returns null for a missing path and throws for any other failure. */
function lstatOrNull(absPath) {
  try {
    return fs.lstatSync(absPath);
  } catch (err) {
    if (err && (err.code === "ENOENT" || err.code === "ENOTDIR")) return null;
    throw err;
  }
}

/** Parent directories of absPath that do not exist yet, root-relative posix, deepest first. */
function missingParentDirs(projectRoot, absPath) {
  const rootAbs = path.resolve(projectRoot);
  const dirs = [];
  let dir = path.dirname(absPath);
  while (dir !== rootAbs && dir.startsWith(`${rootAbs}${path.sep}`) && lstatOrNull(dir) === null) {
    dirs.push(path.relative(rootAbs, dir).split(path.sep).join("/"));
    dir = path.dirname(dir);
  }
  return dirs;
}

/**
 * Resolve a plan / fix-plan target to the ONE absolute path both the writer and the write record
 * use (backlog.fix.exec-write-record-hardening). Throws, with the target in the message, for an
 * empty target, an absolute target (inside or outside the root), and a target whose lexical
 * resolution or the realpath of its nearest existing ancestor leaves projectRoot.
 *
 * @param {string} projectRoot
 * @param {string} target plan target, relative to projectRoot
 * @returns {string} path.resolve(projectRoot, target)
 */
export function resolvePlanTarget(projectRoot, target) {
  if (typeof target !== "string" || !target.trim()) {
    throw new Error(`plan target ${JSON.stringify(target)} is empty; refused`);
  }
  if (path.isAbsolute(target) || path.win32.isAbsolute(target)) {
    throw new Error(`plan target ${target} is an absolute path; a plan target must be relative to the project root. Refused, nothing written`);
  }
  const resolved = resolveInsideRoot(projectRoot, target);
  if (!resolved) {
    throw new Error(`plan target ${target} resolves outside the project root (lexically or through a symlinked ancestor); refused, nothing written`);
  }
  // backlog.fix.exec-write-record-revert-and-containment-followups (e): the resolver itself refuses a
  // target that exists and is not a regular file (symlink, directory, special file), so a standalone
  // caller with no runDir never writes through one. An ABSENT target is still accepted (post-write
  // after delete_file). The record helpers keep their own checks as defense in depth.
  const stat = lstatOrNull(resolved.abs);
  if (stat && !stat.isFile()) {
    throw new Error(`plan target ${target} is not a regular file (symlink, directory or special file); refusing to record or write through it`);
  }
  return resolved.abs;
}

/**
 * First existing ancestor of absPath (absPath itself when it exists). Existence is tested with
 * lstat, so a dangling symlink counts as existing and becomes the anchor: realpath then throws on
 * it and the target is refused (backlog.fix.exec-write-record-revert-and-containment-followups (b)).
 */
function nearestExisting(absPath) {
  let p = absPath;
  while (lstatOrNull(p) === null) {
    const parent = path.dirname(p);
    if (parent === p) return p;
    p = parent;
  }
  return p;
}

/**
 * Resolve a recorded target and confirm it stays inside projectRoot, following any
 * symlinked ancestor. Returns { abs, rel } or null when it escapes.
 */
function escapes(rel) {
  return rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
}

function resolveInsideRoot(projectRoot, target) {
  let rootReal;
  try { rootReal = fs.realpathSync(projectRoot); } catch { rootReal = path.resolve(projectRoot); }
  const abs = path.resolve(projectRoot, String(target));
  const lexicalRel = path.relative(path.resolve(projectRoot), abs);
  if (!lexicalRel || escapes(lexicalRel)) return null;
  let anchorReal;
  try { anchorReal = fs.realpathSync(nearestExisting(path.dirname(abs))); } catch { return null; }
  const anchorRel = path.relative(rootReal, anchorReal);
  if (escapes(anchorRel)) return null;
  return { abs, rel: lexicalRel.split(path.sep).join("/") };
}

/**
 * After revert, remove the directories the plan created to hold the files it reverted (the
 * createdDirs of every reverted existed-false entry, collected by revertPlanWrites), in ONE pass,
 * deduped and deepest first (most path segments first), so a directory shared by several entries
 * and nested new directories are removed once all their plan files are gone. A directory is removed ONLY when it is relative, resolves
 * inside projectRoot, is a real directory (not a symlink) and is empty: rmdirSync never removes a
 * non-empty directory. A skipped directory is not a failure and is not reported. Directories that
 * existed before the run are never in createdDirs, so they are never candidates.
 */
function removeEmptyCreatedDirs(projectRoot, dirList) {
  const unique = [...new Set((Array.isArray(dirList) ? dirList : []).filter((d) => typeof d === "string" && d))];
  const depth = (d) => d.replace(/\\/g, "/").split("/").filter(Boolean).length;
  unique.sort((a, b) => depth(b) - depth(a));
  for (const dir of unique) {
    if (path.isAbsolute(dir)) continue;
    const resolved = resolveInsideRoot(projectRoot, dir);
    if (!resolved) continue;
    let stat;
    try { stat = fs.lstatSync(resolved.abs); } catch { continue; }
    if (stat.isSymbolicLink() || !stat.isDirectory()) continue;
    try { fs.rmdirSync(resolved.abs); } catch { /* not empty, or not removable: keep it */ }
  }
}

function isUnderProtectedPath(rel) {
  const first = rel.split("/")[0];
  return PROTECTED_PATHS.includes(first);
}

/**
 * Revert the plan's OWN writes under PROTECTED_PATHS from the run's write record.
 *
 * Per recorded protected target:
 *   - already at its pre-run state (absent for a created file, pre-image bytes for a
 *     modified or deleted one): counted as reverted, not written;
 *   - still holding what the plan wrote (post-write hash, or absent after a delete):
 *     reverted (delete a created file, write back / re-create the pre-image bytes);
 *   - anything else: NOT touched; listed in leftBehind with the reason.
 * A pre-image that is missing, unreadable or fails its integrity check is never
 * substituted (never HEAD, never a guess): the file is listed in leftBehind.
 * Targets outside PROTECTED_PATHS are skipped (the backup restore and
 * cleanupWorkingTree own them). Files the record does not list are never read,
 * written or deleted.
 *
 * No runDir, or no record: a no-op with an empty leftBehind.
 *
 * On a parseable record the outcome is saved into it as revertOutcome { at, reverted, leftBehind }
 * (best-effort; on failure outcomePersistError { error, detail } is added to the return value).
 *
 * @returns {{ reverted: string[], leftBehind: Array<{ path: string, reason: string }>, recordStatus: string, outcomePersistError?: { error: string, detail: string } }}
 */
export function revertPlanWrites(projectRoot, runDir) {
  const reverted = [];
  const leftBehind = [];
  if (!runDir) return { reverted, leftBehind, recordStatus: "no_run_dir" };
  const read = readWriteRecord(runDir);
  if (read.status === "absent") return { reverted, leftBehind, recordStatus: "absent" };
  if (read.status === "unparseable") {
    const file = writeRecordPath(runDir);
    const rel = path.relative(projectRoot, file);
    leftBehind.push({
      path: rel && !escapes(rel) ? rel.split(path.sep).join("/") : file,
      reason: `write record could not be parsed (${read.error}); no plan-written protected file was reverted, so any the plan wrote are still on disk`,
    });
    return { reverted, leftBehind, recordStatus: "unparseable" };
  }

  const recordAttemptId = typeof read.record.attemptId === "string" && read.record.attemptId ? read.record.attemptId : null;
  // backlog.fix.exec-write-record-revert-and-containment-followups (a): createdDirs of every
  // existed-false entry this call counted as reverted (atPostWrite deletes AND atPreRun already-absent
  // files). Never collected from a leftBehind or other-attempt entry. Cleaned once, after the loop.
  const cleanupDirs = [];
  const collectCreatedDirs = (entry) => {
    if (Array.isArray(entry.createdDirs)) cleanupDirs.push(...entry.createdDirs);
  };
  for (const entry of read.record.entries) {
    const target = entry && typeof entry.target === "string" ? entry.target : null;
    if (!target) {
      leftBehind.push({ path: String(entry?.target ?? "(missing target)"), reason: "write-record entry has no target; not reverted" });
      continue;
    }
    const resolved = resolveInsideRoot(projectRoot, target);
    if (!resolved) {
      leftBehind.push({ path: target, reason: "write-record target resolves outside the project root; refused, not touched" });
      continue;
    }
    if (!isUnderProtectedPath(resolved.rel)) continue;
    const { abs, rel } = resolved;

    // Defense in depth (backlog.fix.exec-write-record-attempt-scope): an entry stamped by a
    // DIFFERENT exec attempt describes bytes that attempt saw, not this one. Never revert it.
    if (typeof entry.attemptId === "string" && entry.attemptId && entry.attemptId !== recordAttemptId) {
      leftBehind.push({
        path: rel,
        reason: `write-record entry belongs to exec attempt ${entry.attemptId}, not the current attempt ${recordAttemptId}; not touched`,
      });
      continue;
    }

    try {
      // Pre-run state.
      let preBytes = null;
      if (entry.existed === true) {
        if (typeof entry.preImageHash !== "string" || !SHA256_HEX.test(entry.preImageHash)) {
          leftBehind.push({ path: rel, reason: "pre-image missing from the write record; not reverted (never restored from HEAD)" });
          continue;
        }
        const prePath = path.join(runDir, PRE_IMAGE_RELATIVE_DIR, entry.preImageHash);
        try {
          preBytes = fs.readFileSync(prePath);
        } catch (err) {
          leftBehind.push({ path: rel, reason: `pre-image missing or unreadable (${err.code || err.message}); not reverted (never restored from HEAD)` });
          continue;
        }
        if (sha256(preBytes) !== entry.preImageHash) {
          leftBehind.push({ path: rel, reason: "pre-image failed its integrity check; not reverted (never restored from HEAD)" });
          continue;
        }
      } else if (entry.existed !== false) {
        leftBehind.push({ path: rel, reason: "write-record entry does not say whether the file existed before the run; not reverted" });
        continue;
      }

      // Current state.
      let currentHash = null;
      let stat = null;
      try { stat = fs.lstatSync(abs); } catch { stat = null; }
      if (stat && !stat.isFile()) {
        leftBehind.push({ path: rel, reason: "target is no longer a regular file; not touched" });
        continue;
      }
      const currentExists = Boolean(stat);
      if (currentExists) currentHash = sha256(fs.readFileSync(abs));

      // Already at the pre-run state: counted, not written.
      const atPreRun = entry.existed === false ? !currentExists : (currentExists && currentHash === entry.preImageHash);
      if (atPreRun) {
        if (entry.existed === false) collectCreatedDirs(entry);
        reverted.push(rel);
        continue;
      }

      // Still what the plan wrote: revert.
      const hasPost = entry.postExists === true || entry.postExists === false;
      const atPostWrite = hasPost && (entry.postExists === false
        ? !currentExists
        : (currentExists && typeof entry.postHash === "string" && currentHash === entry.postHash));
      if (atPostWrite) {
        if (entry.existed === false) {
          fs.rmSync(abs, { force: true });
          collectCreatedDirs(entry);
        } else {
          ensureDir(path.dirname(abs));
          fs.writeFileSync(abs, preBytes);
        }
        reverted.push(rel);
        continue;
      }

      const postError = typeof entry.postError === "string" && entry.postError ? entry.postError : null;
      leftBehind.push({
        path: rel,
        reason: hasPost
          ? "changed after the plan wrote it (content matches neither the plan's post-write hash nor its pre-run state); not touched"
          : postError
            ? `post-write hash recording failed (${postError}); not touched`
            : "no post-write hash was recorded and the content differs from its pre-run state; not touched",
      });
    } catch (err) {
      leftBehind.push({ path: rel, reason: `revert failed: ${err.message}` });
    }
  }

  // One deferred cleanup pass (before the outcome persist). It never changes reverted / leftBehind:
  // a directory it skips is not a failure and is not reported.
  removeEmptyCreatedDirs(projectRoot, cleanupDirs);

  // backlog.fix.exec-write-record-attempt-retention: persist how this revert ended into the
  // attempt's own record, so retention can tell a clean revert (prunable) from one that left files
  // behind (never prunable). Best-effort: a failed save is logged, never thrown, and the observed
  // reverted / leftBehind are returned unchanged with outcomePersistError beside them. The live
  // record then has no revertOutcome, which counts as "no evidence" and keeps the attempt.
  try {
    persistWriteRecord(runDir, { ...read.record, revertOutcome: { at: new Date().toISOString(), reverted, leftBehind } });
  } catch (err) {
    removePersistTmp(runDir);
    const detail = err?.message || String(err);
    console.error(`[rks.exec] revert outcome not saved to the write record (attempt stays unprunable): ${detail}`);
    return { reverted, leftBehind, recordStatus: "ok", outcomePersistError: { error: "revert_outcome_persist_failed", detail } };
  }
  return { reverted, leftBehind, recordStatus: "ok" };
}
