// backlog.fix.test-suite-deletes-live-governor-sessions — refuse deleting live session state under test.
// A leaf: node built-ins only, imported by governor-token.mjs and project-lease.mjs.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// packages/mcp-rks/src/shared -> repository root
export const SHELL_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

function real(p) {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

/** True only inside a vitest run, for the live repository root itself. */
export function isLiveRootUnderTest(root) {
  if (!process.env.VITEST || !root) return false;
  return real(root) === real(SHELL_REPO_ROOT);
}

/**
 * Record the violation where a swallowing try/catch cannot hide it (tests/setup.mjs afterEach
 * reads it), then throw. Never deletes anything.
 */
export function refuseLiveRootDeletion(what, target) {
  const message =
    `refused to delete ${what} at ${target}: it is under the live repository root ` +
    `${SHELL_REPO_ROOT} and VITEST is set. Call setProjectRoot(<temp dir>) before resetToken().`;
  if (!Array.isArray(globalThis.__RKS_LIVE_STATE_VIOLATIONS__)) globalThis.__RKS_LIVE_STATE_VIOLATIONS__ = [];
  globalThis.__RKS_LIVE_STATE_VIOLATIONS__.push(message);
  throw new Error(message);
}
