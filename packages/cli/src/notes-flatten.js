import fs from "fs";
import path from "path";

/**
 * Flatten folder-style notes into dot-separated files at vault root.
 * Examples:
 *   vault/clients.generic.projects.demo-two/index.md
 *     -> vault/clients.generic.projects.demo-two.index.md
 *   vault/demo-two/notes.prompt-library.md
 *     -> vault/demo-two.notes.prompt-library.md
 *
 * Only moves *.md / *.mdx files from ONE level deep directories that do NOT start with a dot.
 * Removes now-empty folders after moving.
 */
export function flattenVault({ vaultPath }) {
  if (!fs.existsSync(vaultPath) || !fs.statSync(vaultPath).isDirectory()) {
    throw new Error(`vaultPath is not a directory: ${vaultPath}`);
  }
  const entries = fs.readdirSync(vaultPath, { withFileTypes: true });
  let moved = 0, skipped = 0, removedDirs = 0;

  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    if (ent.name.startsWith(".")) continue; // ignore .vscode, .dendron.cache, etc.
    const dir = path.join(vaultPath, ent.name);
    const inner = fs.readdirSync(dir, { withFileTypes: true });
    for (const f of inner) {
      if (!f.isFile()) continue;
      if (!/\.(md|mdx)$/i.test(f.name)) { skipped++; continue; }
      const newName = `${ent.name}.${f.name}`; // dir + '.' + filename
      const src = path.join(dir, f.name);
      const dst = path.join(vaultPath, newName);
      if (fs.existsSync(dst)) {
        // Already flattened previously; skip
        skipped++;
        continue;
      }
      fs.renameSync(src, dst);
      console.log(`move: ${path.relative(vaultPath, src)} -> ${newName}`);
      moved++;
    }
    // Try to remove dir if empty
    try {
      if (fs.readdirSync(dir).length === 0) {
        fs.rmdirSync(dir);
        console.log(`rmdir: ${path.relative(vaultPath, dir)}`);
        removedDirs++;
      }
    } catch {}
  }

  // Ensure root.md exists (Dendron vault sanity)
  const rootNote = path.join(vaultPath, "root.md");
  if (!fs.existsSync(rootNote)) {
    const now = new Date().toISOString().slice(0,10);
    fs.writeFileSync(rootNote, `---\nid: root\ntitle: Vault Root\ndesc: Auto-created root of vault\ncreated: ${now}\nupdated: ${now}\n---\n\nRoot of this vault.\n`);
    console.log("create: root.md");
  }

  return { moved, skipped, removedDirs };
}

/**
 * Seed flat notes at the vault root.
 * prefix = namespace ? `${namespace}.${slug}` : slug
 */
export function seedFlat({ vaultPath, slug, namespace }) {
  if (!fs.existsSync(vaultPath)) fs.mkdirSync(vaultPath, { recursive: true });
  const prefix = namespace ? `${namespace}.${slug}` : slug;
  const files = {
    [`${prefix}.index.md`]: `---\nid: ${prefix}.index\ntitle: ${slug} — Index\n---\n# ${slug}: Index\n\nLinks:\n- ![[${prefix}.prototype.shell-init]]\n- ![[${prefix}.notes.prompt-library]]\n`,
    [`${prefix}.prototype.shell-init.md`]: `---\nid: ${prefix}.prototype.shell-init\ntitle: ${slug} — Prototype Shell Init\n---\n- Goals\n- Risks\n- Milestones\n`,
    [`${prefix}.notes.prompt-library.md`]: `---\nid: ${prefix}.notes.prompt-library\ntitle: ${slug} — Prompt Library\n---\n\`\`\`prompt\n# Add prompts here\n\`\`\`\n`
  };
  let written = 0;
  for (const [name, content] of Object.entries(files)) {
    const p = path.join(vaultPath, name);
    if (!fs.existsSync(p)) {
      fs.writeFileSync(p, content);
      console.log(`write: ${name}`);
      written++;
    } else {
      console.log(`skip (exists): ${name}`);
    }
  }
  // Ensure root.md exists
  const rootNote = path.join(vaultPath, "root.md");
  if (!fs.existsSync(rootNote)) {
    const now = new Date().toISOString().slice(0,10);
    fs.writeFileSync(rootNote, `---\nid: root\ntitle: Vault Root\ndesc: Auto-created root of vault\ncreated: ${now}\nupdated: ${now}\n---\n\nRoot of this vault.\n`);
    console.log("create: root.md");
  }
  return { written, prefix };
}
