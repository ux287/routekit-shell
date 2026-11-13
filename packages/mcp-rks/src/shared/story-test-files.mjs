// Story testFiles reader (backlog.feat.landing-gate-combined-tree-test). Moved from
// guardrails-audit.mjs so the off-rail review evidence and the landing gate (story-ship.mjs,
// guardrails-audit.mjs gate beta, git-ship.mjs) share one implementation.
import fs from "fs";
import path from "path";
import { parseFrontmatter, resolveNotesDir } from "../dendron.mjs";

/**
 * Load testFiles from a story note, as path strings. Null when there is no problemId, no
 * note or no testFiles; read the same way loadStoryTargetFiles reads targetFiles.
 */
export function loadStoryTestFiles(projectRoot, problemId) {
  if (!problemId) return null;
  try {
    const notesDir = resolveNotesDir(projectRoot);
    const notePath = path.join(notesDir, `${problemId}.md`);
    if (!fs.existsSync(notePath)) return null;
    const parsed = parseFrontmatter(fs.readFileSync(notePath, "utf8"));
    const files = parsed?.data?.testFiles;
    if (!Array.isArray(files)) return null;
    return files.filter((f) => typeof f === "string" && f.trim() !== "").map((f) => f.trim());
  } catch {
    return null;
  }
}
