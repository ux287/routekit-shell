/**
 * R8 — One-shot in-flight migration: scan notes/ for stories at phase=implemented
 * and rewrite their phase to integrated. The data side of the manual
 * reset_to_integrated edge added in R1.3-followup-rks-release.
 *
 * Design (per research.2026.06.13.integrated-implemented-released-arc.md §7
 * Option A):
 *   - Stories at phase=implemented are residue from the pre-R1.3f cycle-complete
 *     agent, which overwrote phase to "implemented". R1.3f stopped that writer;
 *     R1.3-followup-rks-release migrated rks_release to read integrated. This
 *     migration backfills the legacy data so R1.4 can drop the implemented
 *     phase entirely.
 *   - The filename prefix (backlog.z_implemented.*) stays as the archival
 *     marker — the migration touches the phase frontmatter field ONLY.
 *
 * Discovery uses parseFrontmatter (proper YAML parse), so the scanner won't
 * false-match on body content (e.g. a code block that mentions `phase:
 * implemented`). The phase rewrite is a frontmatter-scoped regex that
 * preserves every other byte of the file — body content and other frontmatter
 * fields are byte-equal modulo the phase line.
 */
import fs from "node:fs";
import path from "node:path";
import { parseFrontmatter, extractFrontmatterBlock } from "../shared/frontmatter.mjs";
import { readNoteRaw, writeNoteRaw } from "../dendron.mjs";

/**
 * Rewrite the `phase: implemented` line inside a frontmatter block to
 * `phase: integrated`. Preserves the original quoting style (double, single,
 * or unquoted). Returns null if no phase=implemented line is found in the
 * frontmatter block — the caller should treat that as "no change needed".
 *
 * Scoped to the frontmatter block ONLY — body content (which may contain code
 * blocks referencing `phase: implemented`) is untouched.
 */
function rewritePhaseInContent(content) {
  const fmBlock = extractFrontmatterBlock(content);
  if (fmBlock === null) return null;
  const phaseLineRegex = /^phase:\s*(["']?)implemented\1\s*$/m;
  if (!phaseLineRegex.test(fmBlock)) return null;
  const newFmBlock = fmBlock.replace(phaseLineRegex, (_match, quote) => `phase: ${quote}integrated${quote}`);
  return content.replace(`---\n${fmBlock}\n---`, `---\n${newFmBlock}\n---`);
}

function listNoteFiles(notesDir) {
  if (!fs.existsSync(notesDir)) return [];
  return fs.readdirSync(notesDir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => path.join(notesDir, f));
}

/**
 * Migrate every note in `notesDir` whose frontmatter has `phase: implemented`
 * to `phase: integrated`. Idempotent — subsequent runs find zero matches.
 *
 * @param {object} opts
 * @param {string} opts.notesDir - Absolute path to the notes directory to scan.
 * @param {boolean} [opts.dryRun=false] - If true, no files are written; the
 *   return shape still reports the storyIds that WOULD migrate.
 * @returns {Promise<{ count: number, storyIds: string[], failures: Array<{ storyId: string, error: string }> }>}
 */
export async function migrateImplementedToIntegrated({ notesDir, dryRun = false } = {}) {
  if (!notesDir) {
    return { count: 0, storyIds: [], failures: [{ storyId: "(no notesDir)", error: "notesDir is required" }] };
  }
  const storyIds = [];
  const failures = [];
  const files = listNoteFiles(notesDir);
  for (const notePath of files) {
    let content;
    try {
      content = readNoteRaw(notePath);
    } catch (err) {
      failures.push({ storyId: path.basename(notePath, ".md"), error: `read failed: ${err.message}` });
      continue;
    }
    let parsed;
    try {
      parsed = parseFrontmatter(content);
    } catch (err) {
      failures.push({ storyId: path.basename(notePath, ".md"), error: `parse failed: ${err.message}` });
      continue;
    }
    if (parsed?.data?.phase !== "implemented") continue;
    const storyId = parsed.data.id || path.basename(notePath, ".md");
    const newContent = rewritePhaseInContent(content);
    if (newContent === null) {
      failures.push({ storyId, error: "phase=implemented declared in parse but rewrite found no matching line" });
      continue;
    }
    if (!dryRun) {
      try {
        writeNoteRaw(notePath, newContent);
      } catch (err) {
        failures.push({ storyId, error: `write failed: ${err.message}` });
        continue;
      }
    }
    storyIds.push(storyId);
  }
  return { count: storyIds.length, storyIds, failures };
}
