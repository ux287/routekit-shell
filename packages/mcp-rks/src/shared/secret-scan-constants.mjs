// packages/mcp-rks/src/shared/secret-scan-constants.mjs
// backlog.feat.preflight-secret-scan-posture
// Single source of the gitleaks pre-commit secret-scan constants and the side-effect-free
// scanner-resolution helpers. scripts/install-git-hooks.mjs imports and re-exports these;
// packages/mcp-rks/src/server/preflight.mjs (checkSecretScanPosture) imports them directly.
// No import here may resolve outside packages/mcp-rks: the npm package ships only bin/, src/, templates/.
import fs from "node:fs";
import path from "node:path";

export const PRE_COMMIT_MARKER = "# rks-gitleaks-pre-commit (managed)";
export const HOOK_REL = ".routekit/git-hooks/pre-commit";
export const HOOKS_PATH_REL = path.posix.dirname(HOOK_REL);
export const OVERRIDE_ENV = "RKS_ALLOW_UNSCANNED_COMMIT";

/** `<git-common-dir>/rks-tools`, shared by every linked worktree of one repository. */
export function rksToolsDirFromCommonDir(commonDirAbs) {
  return path.join(commonDirAbs, "rks-tools");
}

/**
 * The rks-tools scanner candidates, in the pre-commit hook's own resolution order
 * (<git-common-dir>/rks-tools/gitleaks/gitleaks, then gitleaks.exe). Single source of that order;
 * tests/unit/preflight-secret-scan-posture.test.mjs ties it to .routekit/git-hooks/pre-commit.
 */
export const RKS_TOOLS_SCANNER_NAMES = Object.freeze(["gitleaks", "gitleaks.exe"]);

/**
 * True when `file` is a regular file that is executable: stat isFile(), plus X_OK on non-win32
 * (win32 has no executable bit). Any error (absent, unreadable, not executable) returns false.
 */
export function isExecutableFile(file, platform = process.platform) {
  try {
    if (!fs.statSync(file).isFile()) return false;
    if (platform !== "win32") fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// D16: a scanner counts as observed only when an executable file is found on disk.
export function findGitleaksOnPath(env = process.env, platform = process.platform) {
  const name = platform === "win32" ? "gitleaks.exe" : "gitleaks";
  for (const dir of String((env && env.PATH) || "").split(path.delimiter).filter(Boolean)) {
    const f = path.join(dir, name);
    if (isExecutableFile(f, platform)) return f;
  }
  return null;
}
