import fs from "node:fs";
import path from "node:path";

function fileExists(filePath) {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function findProjectRootMarker(fromDir) {
  let current = path.resolve(fromDir);
  while (true) {
    const marker = path.join(current, "routekit", "project.json");
    if (fileExists(marker)) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function findVendoredShellRoot(fromDir) {
  const abs = path.resolve(fromDir);
  const parts = abs.split(path.sep);
  for (let i = parts.length - 1; i >= 1; i -= 1) {
    if (parts[i] !== "routekit-shell" || parts[i - 1] !== "tools") continue;
    const candidate = parts.slice(0, i - 1).join(path.sep) || path.sep;
    if (candidate && fileExists(candidate)) return candidate;
  }
  return null;
}

/**
 * Resolve the active RouteKit project root for CLI operations.
 *
 * Precedence:
 * 1) ROUTEKIT_PROJECT_ROOT env override
 * 2) Walk up from cwd for routekit/project.json
 * 3) If cwd is inside .../tools/routekit-shell/..., return the directory above tools/
 * 4) Fallback to cwd
 */
export function resolveProjectRoot({ cwd = process.cwd(), env = process.env } = {}) {
  const override = env?.ROUTEKIT_PROJECT_ROOT;
  if (isNonEmptyString(override)) {
    return { projectRoot: path.resolve(String(override).trim()), reason: "env" };
  }

  const resolvedCwd = path.resolve(cwd || process.cwd());

  const markerRoot = findProjectRootMarker(resolvedCwd);
  if (markerRoot) return { projectRoot: markerRoot, reason: "marker" };

  const vendoredRoot = findVendoredShellRoot(resolvedCwd);
  if (vendoredRoot) return { projectRoot: vendoredRoot, reason: "vendored" };

  return { projectRoot: resolvedCwd, reason: "cwd" };
}
