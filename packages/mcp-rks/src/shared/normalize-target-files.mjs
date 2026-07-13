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
