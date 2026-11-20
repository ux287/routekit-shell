// Shared backup location for rks CLI writers.
// backlog.fix.child-writer-sibling-bak-dirties-tree
//
// Backups go under <root>/.rks/.backup/, never next to the file: a sibling
// <file>.bak.<n> is an untracked file outside .rks/, which rks_exec's dirty-tree
// gate (packages/mcp-rks/src/utils/git.mjs getUncommittedFiles) refuses.
import fs from "node:fs";
import path from "node:path";

export const BACKUP_DIR = path.join(".rks", ".backup");

export function findBackupRoot(filePath) {
  const start = path.dirname(path.resolve(filePath));
  let dir = start;
  for (;;) {
    if (fs.existsSync(path.join(dir, ".rks")) || fs.existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}

export function backupPathFor(filePath, stamp = Date.now()) {
  const abs = path.resolve(filePath);
  const root = findBackupRoot(abs);
  return path.join(root, BACKUP_DIR, `${path.relative(root, abs)}.bak.${stamp}`);
}

// Never overwrites an existing backup. Two writes of one file in the same
// millisecond (ensureHookRegistration then mergeRksPermissionAllow, in
// ensureClaudeSettings / doctor Checks 6+7 / upgradeProject) would otherwise map to
// the same <rel>.bak.<stamp> and the second copy would replace the pre-write original.
// COPYFILE_EXCL fails with EEXIST instead; the stamp is then incremented, so the name
// keeps the /\.bak\.\d+$/ shape and later backups sort after earlier ones.
export function backupBeforeWrite(filePath, stamp = Date.now()) {
  if (!fs.existsSync(filePath)) return null;
  let n = Math.trunc(Number(stamp));
  for (;;) {
    const dest = backupPathFor(filePath, n);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    try {
      fs.copyFileSync(filePath, dest, fs.constants.COPYFILE_EXCL);
      return dest;
    } catch (err) {
      if (err && err.code === "EEXIST") {
        n += 1;
        continue;
      }
      throw err;
    }
  }
}
