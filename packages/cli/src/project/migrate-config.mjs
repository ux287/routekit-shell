/**
 * migrate-config.mjs — apply pending project.json schema migrations.
 *
 * Reads via loadProjectMetadata (which knows the canonical path,
 * `<projectRoot>/routekit/project.json`) and writes via saveProjectMetadata
 * (which stamps updatedAt, normalizes schemaVersion, and validates). No raw
 * fs reads/writes — the canonical I/O surface is non-negotiable.
 *
 * Baseline: absent schemaVersion is treated as 1 (the current state IS the
 * baseline). No synthetic 0→1 migration. First real migration added will be
 * { fromVersion: 1, toVersion: 2 }.
 */
import { loadProjectMetadata, saveProjectMetadata } from "./metadata.js";
import { migrations } from "./migrations/index.mjs";

/**
 * Apply any pending migrations from the registry to the project's metadata.
 *
 * @param {object} args
 * @param {string} args.projectRoot - Absolute path to the child project root.
 * @returns {{
 *   ok: true,
 *   applied: string[],        // ['1→2', '2→3', ...]
 *   fromVersion: number,
 *   currentVersion: number,
 *   noOp: boolean,
 * }}
 * @throws if the project's metadata file is missing or malformed.
 */
export function migrateConfig({ projectRoot } = {}) {
  if (!projectRoot || typeof projectRoot !== "string") {
    throw new Error("migrateConfig: projectRoot is required");
  }
  const meta = loadProjectMetadata(projectRoot);
  if (!meta) {
    throw new Error(`No project metadata found at ${projectRoot} — run \`routekit project attach\` first.`);
  }

  const fromVersion = meta.schemaVersion ?? 1;
  let currentVersion = fromVersion;
  let working = { ...meta };
  const applied = [];

  for (const m of migrations) {
    if (m.fromVersion === currentVersion) {
      working = m.apply(working);
      working.schemaVersion = m.toVersion;
      currentVersion = m.toVersion;
      applied.push(`${m.fromVersion}→${m.toVersion}`);
    }
  }

  if (applied.length === 0) {
    return { ok: true, applied: [], fromVersion, currentVersion, noOp: true };
  }

  saveProjectMetadata(projectRoot, working);
  return { ok: true, applied, fromVersion, currentVersion, noOp: false };
}
