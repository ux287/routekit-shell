// Shared protected rks paths. Importers (keep this list current):
//   read/redirect-read-bash-to-agent.mjs  (backlog.fix.child-bash-protected-rks-config-write-routes)
//   system/block-git-during-off-rail.mjs  (backlog.fix.child-bash-protected-rks-config-write-routes)
//   system/protect-system-files.mjs       (backlog.fix.child-config-write-deny-rks-project-json)
// sync-hooks --check skips lib/; byte parity of the three copies is asserted by
// tests/unit/bash-protected-rks-config.test.mjs.
import fs from "fs";
import path from "path";

export const PROTECTED_CONFIG_PATHS = Object.freeze([
  ".rks/project.json",
  ".rks/rag/config.json",
  ".routekit/command-policy.yaml",
  ".rks/protected-files.yml",
]);

export const PROTECTED_STATE_PATHS = Object.freeze([
  ".rks/active-scope.json",
  ".rks/telemetry/research-agent-outage.json",
  ".rks/guardrails-state.json",
]);

export const PROTECTED_RKS_PATHS = Object.freeze([...PROTECTED_CONFIG_PATHS, ...PROTECTED_STATE_PATHS]);

// Fragment -> protected path. Bare project.json is too common to be a fragment.
const FRAGMENTS = Object.freeze([
  [".rks/project.json", ".rks/project.json"],
  ["rag/config.json", ".rks/rag/config.json"],
  ["command-policy.yaml", ".routekit/command-policy.yaml"],
  ["protected-files.yml", ".rks/protected-files.yml"],
  ["active-scope.json", ".rks/active-scope.json"],
  ["research-agent-outage.json", ".rks/telemetry/research-agent-outage.json"],
  ["guardrails-state.json", ".rks/guardrails-state.json"],
]);

const ANCESTOR_DIRS = Object.freeze(new Set([".", ".rks", ".rks/rag", ".rks/telemetry", ".routekit"]));

/** Protected paths whose fragment occurs in text (case-insensitive, backslashes folded). */
export function protectedPathsNamedIn(text) {
  const lower = String(text ?? "").toLowerCase().replace(/\\/g, "/");
  const hits = new Set();
  for (const [frag, p] of FRAGMENTS) if (lower.includes(frag)) hits.add(p);
  return [...hits];
}

/** Protected paths a git checkout/restore pathspec word may touch. Fail-closed. */
export function pathspecProtectedPaths(word, projectDir, baseDir = projectDir) {
  const w = String(word ?? "");
  if (!w) return [];
  if (w.startsWith(":") || /[*?[]/.test(w)) return [...PROTECTED_RKS_PATHS];
  const named = protectedPathsNamedIn(w);
  if (named.length) return named;
  const root = path.resolve(projectDir);
  const rel = path.relative(root, path.resolve(root, baseDir, w)).split(path.sep).join("/").toLowerCase() || ".";
  if (rel.split("/").every((s) => s === "..")) return [...PROTECTED_RKS_PATHS];
  if (ANCESTOR_DIRS.has(rel)) return PROTECTED_RKS_PATHS.filter((p) => rel === "." || p.startsWith(rel + "/"));
  return PROTECTED_RKS_PATHS.includes(rel) ? [rel] : [];
}

/**
 * Config paths exempted by an EXACT allowedFiles entry of a scoped off-rail session.
 * Any read/parse problem yields an empty set (deny). State paths are never returned.
 */
export function exemptConfigPaths(projectDir) {
  try {
    const root = path.resolve(projectDir);
    const scope = JSON.parse(fs.readFileSync(path.join(root, ".rks", "active-scope.json"), "utf8"));
    if (!scope || scope.writeMode !== "scoped" || !Array.isArray(scope.allowedFiles)) return new Set();
    const out = new Set();
    for (const entry of scope.allowedFiles) {
      if (typeof entry !== "string" || /[*?[]/.test(entry)) continue;
      const rel = path.relative(root, path.resolve(root, entry)).split(path.sep).join("/");
      if (PROTECTED_CONFIG_PATHS.includes(rel)) out.add(rel);
    }
    return out;
  } catch {
    return new Set();
  }
}
