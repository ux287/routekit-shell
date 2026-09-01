/**
 * rks plugin loader — installs a validated declarative plugin's contributions into a target
 * project (backlog.feat.plugin-surface-v1). OSS, additive plumbing: NO gating, entitlement,
 * licensing, telemetry, or signing — those are deferred Pro capabilities.
 *
 * It REUSES the same bootstrap copy primitives rks uses to place agents/skills/hooks — it does
 * not reimplement copying. Surface placement mirrors bootstrap:
 *   agents → <projectRoot>/.claude/agents/    (overwrite — latest wins, like governor artifacts)
 *   skills → <projectRoot>/.claude/skills/    (overwrite)
 *   hooks  → <projectRoot>/.routekit/hooks/   (NO-overwrite — preserve project customizations)
 *
 * Validate-before-install: an invalid manifest, or a declared contribution source that does not
 * exist, installs NOTHING (no partial corruption of the target).
 */
import fs from "node:fs";
import path from "node:path";
import { validateManifest, MANIFEST_FILENAME } from "./manifest-schema.mjs";
import { copyDirOverwrite, copyDirNoOverwrite } from "../project/bootstrap.mjs";

/**
 * Read + validate a plugin's manifest file (rks-plugin.json) from a plugin directory.
 * @returns {{ ok:true, manifest:object } | { ok:false, error:string, errors?:Array }}
 */
export function loadManifest(pluginRoot) {
  const file = path.join(pluginRoot, MANIFEST_FILENAME);
  if (!fs.existsSync(file)) {
    return { ok: false, error: `no ${MANIFEST_FILENAME} found in ${pluginRoot}` };
  }
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    return { ok: false, error: `invalid ${MANIFEST_FILENAME}: ${e.message}` };
  }
  const v = validateManifest(manifest);
  if (!v.ok) return { ok: false, error: "manifest failed validation", errors: v.errors };
  return { ok: true, manifest };
}

/**
 * Install a plugin's declared contributions into a target project.
 * @param {{ manifest: object, pluginRoot: string, projectRoot: string }} args
 * @param {{ copyDirOverwrite?: Function, copyDirNoOverwrite?: Function }} [deps] injectable
 *   copy primitives (default: the bootstrap exports) — enables delegation witnesses in tests.
 * @returns {{ ok:true, name, version, installed:string[] }
 *          | { ok:false, phase:'validate'|'resolve', errors:Array<{field,message}> }}
 *   Never throws for validation/resolution failures. Installs nothing unless everything resolves.
 */
export function installPlugin({ manifest, pluginRoot, projectRoot }, deps = {}) {
  const _copyOverwrite = deps.copyDirOverwrite || copyDirOverwrite;
  const _copyNoOverwrite = deps.copyDirNoOverwrite || copyDirNoOverwrite;

  // Gate 1: manifest validity.
  const validation = validateManifest(manifest);
  if (!validation.ok) {
    return { ok: false, phase: "validate", errors: validation.errors };
  }

  // Build the install plan from the declared surfaces.
  const c = manifest.contributes;
  const plan = [];
  if (c.agents !== undefined) {
    plan.push({ surface: "agents", src: path.join(pluginRoot, c.agents), dest: path.join(projectRoot, ".claude", "agents"), overwrite: true });
  }
  if (c.skills !== undefined) {
    plan.push({ surface: "skills", src: path.join(pluginRoot, c.skills), dest: path.join(projectRoot, ".claude", "skills"), overwrite: true });
  }
  if (c.hooks !== undefined) {
    plan.push({ surface: "hooks", src: path.join(pluginRoot, c.hooks), dest: path.join(projectRoot, ".routekit", "hooks"), overwrite: false });
  }

  // Gate 2: validate-before-install — every declared source must exist as a directory BEFORE we
  // copy anything, so a bad path never leaves the target half-installed.
  const missing = plan.filter((p) => !fs.existsSync(p.src) || !fs.statSync(p.src).isDirectory());
  if (missing.length > 0) {
    return {
      ok: false,
      phase: "resolve",
      errors: missing.map((m) => ({ field: `contributes.${m.surface}`, message: `contribution source not found: ${path.relative(pluginRoot, m.src) || m.src}` })),
    };
  }

  // Install — delegate copying to the reused bootstrap primitives.
  const installed = [];
  for (const p of plan) {
    if (p.overwrite) _copyOverwrite(p.src, p.dest);
    else _copyNoOverwrite(p.src, p.dest);
    installed.push(p.surface);
  }

  return { ok: true, name: manifest.name, version: manifest.version, installed };
}
