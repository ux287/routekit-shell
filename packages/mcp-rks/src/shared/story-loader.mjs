/**
 * Story Loader — unified story loading for all consumers.
 *
 * Single source of truth for: resolve path → read file → parse frontmatter → normalize targets.
 * Replaces inline story loading in planner.mjs, refine.mjs, plan-ready.mjs, and exec.mjs.
 */
import fs from "fs";
import { resolveNotePath, loadNoteContent } from "../dendron-notes.mjs";
import { parseFrontmatter } from "./frontmatter.mjs";
import { normalizeTargetFiles } from "./normalize-target-files.mjs";

/**
 * Load a story by problemId, returning parsed frontmatter, body, path, and normalized targetFiles.
 *
 * @param {string} projectRoot - Project root directory
 * @param {string} problemId - Story ID (e.g. 'backlog.feat.my-story')
 * @returns {{ frontmatter: object, body: string, path: string, targetFiles: Array<{path: string, action: string, desc?: string}>, rawContent: string }}
 * @throws {Error} if story file not found
 */
export function loadStory(projectRoot, problemId) {
  // Resolve and read
  const note = loadNoteContent(projectRoot, problemId);

  // Parse frontmatter
  const parsed = parseFrontmatter(note.content);
  const frontmatter = parsed.data || {};
  const body = parsed.content || "";

  // Normalize targetFiles from frontmatter
  const targetFiles = normalizeTargetFiles(frontmatter?.targetFiles || []);

  return {
    frontmatter,
    body,
    path: note.path,
    targetFiles,
    rawContent: note.content,
  };
}

/**
 * Load story and extract a single frontmatter field.
 * Convenience wrapper for consumers that only need one field (e.g. exec.mjs checking phase).
 *
 * @param {string} projectRoot
 * @param {string} problemId
 * @param {string} field - frontmatter field name
 * @param {*} defaultValue - default if field is missing
 * @returns {*} field value or default
 */
export function loadStoryField(projectRoot, problemId, field, defaultValue = null) {
  try {
    const { frontmatter } = loadStory(projectRoot, problemId);
    return frontmatter[field] ?? defaultValue;
  } catch {
    return defaultValue;
  }
}
