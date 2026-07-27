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

export function createBackup(projectRoot) {
  const backupsDir = path.join(projectRoot, ".rks", "backups");
  ensureDir(backupsDir);
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const folder = path.join(backupsDir, `backup-${ts}`);
  ensureDir(folder);

  // If repo has git, try to stash (preferred; fast and reversible)
  if (fs.existsSync(path.join(projectRoot, ".git"))) {
    const res = spawnSync("git", ["stash", "push", "-u", "-m", `rks.exec backup ${ts}`], { cwd: projectRoot, encoding: "utf8" });
    const success = res.status === 0;
    const msg = (res.stdout || res.stderr || "").trim();
    const stashRefMatch = msg.match(/stash@\{[0-9]+\}/);
    const stashRef = stashRefMatch ? stashRefMatch[0] : null;
    return { type: "git-stash", success, msg, stashRef };
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
    // Prefer to apply a known stashRef, otherwise try to find the most recent matching stash
    if (backupMeta.stashRef) {
      const applyRes = spawnSync("git", ["stash", "apply", backupMeta.stashRef], { cwd: projectRoot, encoding: "utf8" });
      return { restored: applyRes.status === 0, msg: (applyRes.stdout || applyRes.stderr || "").trim() };
    }

    // Find a stash entry created by rks.exec
    const list = spawnSync("git", ["stash", "list"], { cwd: projectRoot, encoding: "utf8" });
    const lines = (list.stdout || "").split("\n").filter(Boolean);
    const match = lines.find((l) => l.includes("rks.exec backup"));
    if (!match) return { restored: false, error: "no matching stash found" };
    const ref = match.split(":")[0];
    const pop = spawnSync("git", ["stash", "pop", ref], { cwd: projectRoot, encoding: "utf8" });
    return { restored: pop.status === 0, msg: (pop.stdout || pop.stderr || "").trim() };
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
