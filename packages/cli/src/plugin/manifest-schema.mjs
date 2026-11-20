/**
 * rks plugin manifest — the OSS declarative plugin surface (backlog.feat.plugin-surface-v1).
 *
 * A manifest DECLARES which of rks's existing surfaces a plugin contributes — agents, skills,
 * and/or hooks — as directories within the plugin. It carries NO executable plugin logic of its
 * own (declarative-only; programmatic "code plugins" are a deferred Pro capability). This module
 * is the format + validator; the loader (loader.mjs) installs a validated manifest.
 *
 * Validation is FAIL-CLOSED: unknown top-level fields and unknown `contributes` surfaces are
 * rejected, so typos and future/Pro-only fields surface instead of being silently ignored.
 * Contribution paths must be RELATIVE and within the plugin (no absolute paths, no `..`).
 *
 * Shape:
 *   {
 *     "name": "my-plugin",            // required, non-empty string
 *     "version": "1.0.0",             // required, non-empty string
 *     "description": "…",             // optional string
 *     "contributes": {                // required; at least one surface
 *       "agents": "agents",           // optional relative dir → .claude/agents/
 *       "skills": "skills",           // optional relative dir → .claude/skills/
 *       "hooks":  "hooks"             // optional relative dir → .routekit/hooks/
 *     }
 *   }
 */
import path from "node:path";

export const MANIFEST_FILENAME = "rks-plugin.json";
export const ALLOWED_TOP_FIELDS = Object.freeze(["name", "version", "description", "contributes"]);
export const ALLOWED_SURFACES = Object.freeze(["agents", "skills", "hooks"]);

const TOP = new Set(ALLOWED_TOP_FIELDS);
const SURFACES = new Set(ALLOWED_SURFACES);

function isRelativeSafe(p) {
  if (typeof p !== "string" || p.trim() === "") return false;
  if (path.isAbsolute(p)) return false;
  // reject any parent-traversal segment (posix or win separators)
  return !p.split(/[\\/]/).includes("..");
}

/**
 * Validate a plugin manifest OBJECT. Pure — no filesystem access.
 * @returns {{ ok: boolean, errors: Array<{ field: string, message: string }> }}
 *   errors is [] when ok. Never throws.
 */
export function validateManifest(manifest) {
  if (manifest == null || typeof manifest !== "object" || Array.isArray(manifest)) {
    return { ok: false, errors: [{ field: "(root)", message: "manifest must be a JSON object" }] };
  }

  const errors = [];
  const err = (field, message) => errors.push({ field, message });

  // Fail-closed on unknown top-level fields.
  for (const key of Object.keys(manifest)) {
    if (!TOP.has(key)) err(key, `unknown top-level field '${key}' (allowed: ${ALLOWED_TOP_FIELDS.join(", ")})`);
  }

  if (typeof manifest.name !== "string" || manifest.name.trim() === "") {
    err("name", "required, must be a non-empty string");
  }
  if (typeof manifest.version !== "string" || manifest.version.trim() === "") {
    err("version", "required, must be a non-empty string");
  }
  if (manifest.description !== undefined && typeof manifest.description !== "string") {
    err("description", "must be a string when present");
  }

  const c = manifest.contributes;
  if (c == null || typeof c !== "object" || Array.isArray(c)) {
    err("contributes", "required object declaring at least one of: " + ALLOWED_SURFACES.join(", "));
  } else {
    for (const key of Object.keys(c)) {
      if (!SURFACES.has(key)) err(`contributes.${key}`, `unknown surface '${key}' (allowed: ${ALLOWED_SURFACES.join(", ")})`);
    }
    const present = ALLOWED_SURFACES.filter((s) => c[s] !== undefined);
    if (present.length === 0) {
      err("contributes", "must declare at least one of: " + ALLOWED_SURFACES.join(", "));
    }
    for (const s of present) {
      if (typeof c[s] !== "string" || c[s].trim() === "") {
        err(`contributes.${s}`, "must be a non-empty relative directory path");
      } else if (!isRelativeSafe(c[s])) {
        err(`contributes.${s}`, "must be a relative path within the plugin (no absolute paths or '..')");
      }
    }
  }

  return { ok: errors.length === 0, errors };
}
