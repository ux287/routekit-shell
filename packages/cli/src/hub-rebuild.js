import fs from "fs";
import path from "path";
import yaml from "yaml";

/**
 * Build a zero-duplication hub:
 * - Reads dendron.yml
 * - Finds all vaults whose fsPath ends with /notes
 * - For each vault, finds *.index.md and treats "<slug>.index.md" -> slug
 * - Writes clients.generic.index.md in ROOT vault with bullets to each "<slug>.index"
 *
 * mode = "links" (default)  -> [[slug.index]]
 * mode = "transclude"       -> ![[slug.index]]
 */
export async function rebuildHub({ root, rootVault, mode = "links" }) {
  const dendPath = path.join(root, "dendron.yml");
  const dend = yaml.parse(fs.readFileSync(dendPath, "utf8"));
  const vaults = (dend?.workspace?.vaults || [])
    .map(v => v.fsPath)
    .filter(Boolean)
    .map(p => path.resolve(root, p))
    .filter(p => p.endsWith("/notes") || p.endsWith("\\notes"));

  const slugs = new Set();
  for (const v of vaults) {
    if (!fs.existsSync(v)) continue;
    for (const f of fs.readdirSync(v)) {
      if (f.endsWith(".index.md")) {
        const slug = f.replace(/\.index\.md$/, "");
        // ignore container-like notes that aren't project indexes
        if (slug && slug !== "clients.generic.projects" && slug !== "root") {
          slugs.add(slug);
        }
      }
    }
  }

  const sorted = Array.from(slugs).sort((a,b)=>a.localeCompare(b));
  const bullet = (s) => mode === "transclude" ? `- ![[${s}.index]]` : `- [[${s}.index]]`;

  const body =
`---
id: clients.generic.index
title: Client Projects Hub
---

# Client Projects

This list is generated. It links directly to each project's index in its own vault.

${sorted.map(bullet).join("\n")}

`;

  const dest = path.join(rootVault, "clients.generic.index.md");
  fs.writeFileSync(dest, body);
  return { dest, count: sorted.length, mode, vaults };
}
