import fs from "fs";
import path from "path";

/**
 * Create/update root-vault stubs that transclude project-local notes.
 * @param {object} opts
 * @param {string} opts.rootVault  - absolute path to root vault
 * @param {string} opts.slug       - project slug, e.g. "ux287-com"
 * @param {string} [opts.namespace="clients.generic.projects"]
 */
export function linkProjectNotes({ rootVault, slug, namespace = "clients.generic.projects" }) {
  if (!rootVault || !slug) throw new Error("linkProjectNotes: rootVault and slug required");
  if (!fs.existsSync(rootVault)) fs.mkdirSync(rootVault, { recursive: true });

  const make = (suffix, transclusion) => {
    const key = `${namespace}.${slug}.${suffix}`;
    const filename = `${key}.md`;
    const dest = path.join(rootVault, filename);
    const fmId = key;
    const body =
`---
id: ${fmId}
title: ${slug} — ${suffix.replace(/\./g, " ")}
---
![[${slug}.${transclusion}]]
`;
    if (!fs.existsSync(dest)) {
      fs.writeFileSync(dest, body);
      console.log("write:", dest);
    } else {
      const existing = fs.readFileSync(dest, "utf8");
      if (!existing.includes(`![[${slug}.${transclusion}]]`)) {
        fs.writeFileSync(dest, body);
        console.log("update:", dest);
      } else {
        console.log("skip (exists):", dest);
      }
    }
    return dest;
  };

  const out = {
    index: make("index", "index"),
    prototype: make("prototype.shell-init", "prototype.shell-init"),
    promptlib: make("notes.prompt-library", "notes.prompt-library")
  };

  // ensure root.md exists in root vault
  const rootNote = path.join(rootVault, "root.md");
  if (!fs.existsSync(rootNote)) {
    const now = new Date().toISOString().slice(0,10);
    fs.writeFileSync(rootNote, `---\nid: root\ntitle: Root Vault\ncreated: ${now}\nupdated: ${now}\n---\n`);
    console.log("create:", rootNote);
  }

  return out;
}
