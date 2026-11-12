/**
 * Canonical normalizer and resolver for targetFiles arrays.
 *
 * targetFiles can arrive as plain strings, objects with various key names,
 * or mixed arrays. normalizeTargetFiles converts them to a consistent
 * { path, action } shape. resolveTargets extends that with disk existence
 * checks and mismatch detection.
 */
import fs from "fs";
import nodePath from "path";

/**
 * Normalize raw targetFiles to a consistent shape.
 * @param {Array} targetFiles - Raw targetFiles from frontmatter
 * @returns {Array<{ path: string, action: string, reason?: string, desc?: string }>}
 */
export function normalizeTargetFiles(targetFiles) {
  if (!Array.isArray(targetFiles)) return [];
  return targetFiles.map(tf => {
    if (typeof tf === 'string') {
      const cleaned = tf.replace(/^["']|["']$/g, '');
      return { path: cleaned, action: 'EDIT' };
    }
    if (typeof tf === 'object' && tf !== null) {
      const filePath = tf.path || tf.file || tf.name || tf.target;
      if (!filePath) return null;
      let action = 'EDIT';
      if (tf.action === 'CREATE' || tf.create === true || tf.op === 'create') {
        action = 'CREATE';
      } else if (tf.action === 'DELETE') {
        action = 'DELETE';
      } else if (tf.action) {
        action = tf.action;
      }
      return { path: filePath, action, reason: tf.reason, desc: tf.desc };
    }
    return null;
  }).filter(Boolean);
}

/**
 * Every key `normalizeTargetFiles` above actually consults. Anything else on an entry is
 * discarded by construction, because the normalizer builds a fresh object rather than
 * spreading the input.
 *
 * The path and action aliases are listed deliberately: a report that diffed input keys
 * against OUTPUT keys would flag `file`, `name`, `target`, `op`, `create` and `action` as
 * dropped, when each is read and honoured. Recognised-but-renamed is not dropped.
 */
export const KNOWN_TARGET_FILE_KEYS = Object.freeze([
  "path", "file", "name", "target",
  "action", "op", "create",
  "reason", "desc",
]);

/**
 * Normalize, and additionally report what the normalization discarded.
 *
 * `normalizeTargetFiles` keeps its signature and behaviour: it has many callers that want
 * the array and nothing else. This is the reporting wrapper for the WRITE path, where a
 * silently dropped key is a caller's data going missing under a success result.
 *
 * Two losses are reported separately because they differ in severity:
 *   - droppedKeys    — the entry survived, but some of its keys did not.
 *   - droppedEntries — the WHOLE entry was removed by the `.filter(Boolean)` below, the
 *                      coarser loss and the easier one to miss.
 */
export function inspectTargetFiles(targetFiles) {
  const known = new Set(KNOWN_TARGET_FILE_KEYS);
  const droppedKeys = [];
  const droppedEntries = [];

  if (Array.isArray(targetFiles)) {
    targetFiles.forEach((tf, index) => {
      // A bare string carries no keys to lose.
      if (typeof tf === "string") return;
      if (typeof tf !== "object" || tf === null) {
        droppedEntries.push({ index, reason: "entry is neither a string nor an object" });
        return;
      }
      const filePath = tf.path || tf.file || tf.name || tf.target;
      if (!filePath) {
        droppedEntries.push({ index, reason: "entry has no path, file, name or target key" });
        return;
      }
      const unknown = Object.keys(tf).filter((k) => !known.has(k));
      if (unknown.length > 0) droppedKeys.push({ index, path: filePath, keys: unknown });
    });
  }

  return { normalized: normalizeTargetFiles(targetFiles), droppedKeys, droppedEntries };
}

/**
 * Normalize targetFiles AND resolve against the filesystem.
 * Returns enriched entries with absPath, exists flag, and mismatch detection.
 *
 * @param {string} projectRoot - Project root directory
 * @param {Array} targetFiles - Raw targetFiles from frontmatter
 * @returns {Array<{ path: string, absPath: string, action: string, exists: boolean, mismatch: string|null, desc?: string }>}
 */
export function resolveTargets(projectRoot, targetFiles) {
  const normalized = normalizeTargetFiles(targetFiles);
  return normalized.map(entry => {
    const absPath = nodePath.resolve(projectRoot, entry.path);
    const exists = fs.existsSync(absPath);

    let mismatch = null;
    if (entry.action === 'CREATE' && exists) {
      mismatch = 'CREATE but file exists';
    } else if (entry.action === 'EDIT' && !exists) {
      mismatch = 'EDIT but file does not exist';
    }

    return {
      path: entry.path,
      absPath,
      action: entry.action,
      exists,
      mismatch,
      desc: entry.desc,
    };
  });
}
