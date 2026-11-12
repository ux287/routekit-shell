import fs from "fs";
import path from "path";

export function resolveNotePath(projectRoot, problemId) {
  if (!problemId) return null;
  const clean = problemId.replace(/\.md$/, "");
  const notesDir = path.join(projectRoot, "notes");
  // Exact match (full dotted path)
  const dottedPath = path.join(notesDir, `${clean}.md`);
  if (fs.existsSync(dottedPath)) return dottedPath;
  // Try splitting dots into directory separators
  const relative = clean.split(".").join(path.sep) + ".md";
  const hierarchicalPath = path.join(notesDir, relative);
  if (fs.existsSync(hierarchicalPath)) return hierarchicalPath;
  // Short ID fallback: search for *.{shortId}.md
  try {
    const files = fs.readdirSync(notesDir);
    const suffix = `.${clean}.md`;
    const match = files.find(f => f.endsWith(suffix));
    if (match) return path.join(notesDir, match);
  } catch (e) {}
  return null;
}

export function loadNoteContent(projectRoot, problemId) {
  const resolved = resolveNotePath(projectRoot, problemId);
  if (!resolved) {
    throw new Error(`Problem note not found: ${problemId}`);
  }
  const content = fs.readFileSync(resolved, "utf8");
  return { path: resolved, content };
}
