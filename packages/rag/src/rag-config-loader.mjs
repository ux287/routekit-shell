/**
 * Shared dynamic resolver for @routekit/cli's RAG configuration.
 *
 * packages/rag must keep ZERO STATIC imports that escape src/ — the cycle-freedom invariant enforced
 * by tests/unit/rag-import-redirect.test.mjs (the same invariant Stage 1's host-hook inversion, v0.34.1,
 * established). The one outbound coupling — @routekit/cli's getRagPaths/getRagConfig — is reached via a
 * RUNTIME dynamic import(), which the cycle-freedom scanner does not flag. This is the sanctioned
 * pattern packages/rag/src/tools.mjs already carried (its getRagPathsFor body, relocated here so the
 * absorbed embed/query/init pipeline and tools all share ONE config-seam code path).
 */
import path from "path";
import fs from "fs";
import { fileURLToPath, pathToFileURL } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Walk up from this module to the monorepo root (a package.json with workspaces / a routekit-shell name).
function findRepoRoot(startDir) {
  if (process.env.ROUTEKIT_REPO_ROOT) return process.env.ROUTEKIT_REPO_ROOT;
  let dir = startDir;
  for (let i = 0; i < 10; i++) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
      if (pkg.workspaces || pkg.name?.startsWith("routekit-shell")) return dir;
    } catch { /* no package.json here */ }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(startDir, "../../../..");
}

const repoRoot = findRepoRoot(__dirname);

// Runtime dynamic import of @routekit/cli's rag config — NOT a static import (that would violate
// cycle-freedom). Resolved from repoRoot so it works regardless of the caller's cwd.
async function loadCliRagConfig() {
  const modulePath = path.join(repoRoot, "packages/cli/src/rag/config.mjs");
  return import(pathToFileURL(modulePath).href);
}

/**
 * Resolve the project's RAG paths ({ unified, notes, code, kg }) via @routekit/cli.
 * @param {string} projectRoot
 */
export async function getRagPathsFor(projectRoot) {
  const { getRagPaths } = await loadCliRagConfig();
  return getRagPaths(projectRoot);
}

/**
 * Resolve the project's RAG config ({ config, configPath }) via @routekit/cli.
 * @param {string} projectRoot
 */
export async function getRagConfigFor(projectRoot) {
  const { getRagConfig } = await loadCliRagConfig();
  return getRagConfig(projectRoot);
}
