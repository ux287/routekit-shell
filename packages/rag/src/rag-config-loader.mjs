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

/**
 * Walk up from this module to the monorepo root (a package.json with workspaces / a
 * routekit-shell name).
 *
 * Three stages, in order:
 *   1. ROUTEKIT_REPO_ROOT — returned VERBATIM, before any filesystem work.
 *   2. A bounded upward marker walk.
 *   3. On walk failure: THROW.
 *
 * Stage 3 used to be `return path.resolve(startDir, "../../../..")` — four hops from a
 * three-deep module, which lands on the repository's PARENT. That form was correct at this
 * module's pre-extraction four-deep home and was never updated when it moved. It is dormant
 * in the workspace layout (the walk succeeds at hop 3 via the root package.json's
 * "workspaces") but live in a release mirror or a node_modules/@routekit/rag install — the
 * OSS distribution case — where it would silently resolve config, the LanceDB store, and the
 * embed manifest against a directory outside the consumer's project.
 *
 * A corrected hop count is deliberately NOT the fix: "../../.." is merely correct at today's
 * depth and silently wrong at the next relocation, which is exactly how this defect arose.
 * repoRoot's only job is to locate packages/cli/src/rag/config.mjs, so a wrong root surfaces
 * later as an opaque ERR_MODULE_NOT_FOUND. An eager, self-describing throw is strictly better
 * diagnostics, and ROUTEKIT_REPO_ROOT is the documented escape hatch for layouts the walk
 * cannot classify.
 *
 * Exported as an additive test seam — resolution is otherwise unobservable because repoRoot
 * is frozen at module load. NOT part of the @routekit/rag barrel.
 *
 * @param {string} startDir Directory to begin the upward walk from.
 * @returns {string} An identified repository root.
 * @throws {Error} When no root can be identified.
 */
export function findRepoRoot(startDir) {
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
  throw new Error(
    `[@routekit/rag] Could not locate the repository root. Searched upward from ` +
      `"${startDir}" for a package.json declaring "workspaces" or named "routekit-shell*", ` +
      `and found none within 10 levels. Set ROUTEKIT_REPO_ROOT to the absolute path of the ` +
      `repository root to resolve this explicitly.`,
  );
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
