import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";

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

export function createBackup(projectRoot, problemId = null) {
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
    const res = spawnSync("git", ["stash", "push", "-u", "-m", message, "--", ":/", ":(exclude)notes"], { cwd: projectRoot, encoding: "utf8" });
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
      return { restored: false, error: "no backup stash was created for this run — nothing to restore" };
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
    // Restore all tracked files to match HEAD (except notes/ which we preserve)
    const checkout = spawnSync("git", ["checkout", "--", ".", ":!notes"], { cwd: projectRoot, encoding: "utf8" });
    if (checkout.status !== 0) {
      return { cleaned: false, method: "git-checkout", error: (checkout.stderr || "").trim() };
    }

    // Remove untracked files (artifacts from failed plan)
    // Exclude .rks/ to preserve diagnostics and telemetry
    // Exclude notes/ to preserve story metadata from failed builds
    const clean = spawnSync("git", ["clean", "-fd", "--exclude=.rks", "--exclude=notes"], { cwd: projectRoot, encoding: "utf8" });

    return {
      cleaned: true,
      method: "git-checkout+clean",
      details: (clean.stdout || "").trim(),
    };
  } catch (error) {
    return { cleaned: false, method: "git-checkout", error: error.message };
  }
}
