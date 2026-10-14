import path from "path";
import fs from "fs";

export async function handleNotesCommand({ sub, kv, SHELL_ROOT, ensureDir }) {
  if (sub === "seed") {
    const toSlug = kv.toSlug || kv.slug;
    const toVault = kv.toVault;
    const domains = (kv.domains || "design,docs").split(",").map((s) => s.trim()).filter(Boolean);

    if (!toSlug || !toVault) {
      console.error("usage: routekit notes seed --toSlug=<slug> --toVault=<abs path> [--domains=design,docs]");
      process.exit(1);
    }

    const { glob } = await import("glob");

    const fromVault = path.join(SHELL_ROOT, "notes");
    const toVaultAbs = path.resolve(toVault);

    if (!fs.existsSync(fromVault)) {
      console.error(`Shell vault not found: ${fromVault}`);
      process.exit(2);
    }

    ensureDir(toVaultAbs);

    function fmEnsureRagAndProjectTag(txt, slug) {
      return txt.replace(/^---\n([\s\S]*?)\n---/m, (fm) => {
        let block = fm;
        const hasRag = /^\s*rag\s*:/m.test(block);
        const isPrivate = /^\s*private\s*:\s*true/m.test(block);
        if (!hasRag && !isPrivate) block = block.replace(/^---\n/, "---\nrag: true\n");
        if (!/^\s*tags\s*:/m.test(block)) {
          block = block.replace(/^---\n/, `---\ntags: ["project:${slug}"]\n`);
        } else if (!new RegExp(`project:${slug}`).test(block)) {
          block = block.replace(/tags:\s*\[([^\]]*)\]/, (m, g) => `tags: [${g}${g.trim() ? ", " : ""}"project:${slug}"]`);
        }
        return block;
      });
    }

    let copied = 0;
    for (const d of domains) {
      const pattern = path.join(fromVault, `routekit-shell.${d}.*.md`);
      const files = await glob(pattern);

      for (const src of files) {
        const outName = path.basename(src).replace("routekit-shell", toSlug);
        const dest = path.join(toVaultAbs, outName);
        let txt = fs.readFileSync(src, "utf8")
          .replaceAll("routekit-shell", toSlug)
          .replaceAll("ROUTEKIT SHELL", toSlug.toUpperCase());
        txt = fmEnsureRagAndProjectTag(txt, toSlug);
        fs.writeFileSync(dest, txt);
        copied++;
      }
    }

    console.log(JSON.stringify({ ok: true, fromVault, toVault: toVaultAbs, toSlug, domains, copied }, null, 2));
    process.exit(0);
  }

  if (sub === "export") {
    const vault = kv.vault;
    const out = kv.out ? path.resolve(kv.out) : path.resolve("content");
    const types = (kv.types || "blog").split(",").map((s) => s.trim()).filter(Boolean);
    if (!vault) { console.error("usage: routekit notes export --vault=<abs> [--out=<dir>] [--types=blog,docs]"); process.exit(1); }
    const { exportNotes } = await import("../export-notes.js");
    try {
      const res = exportNotes({ vaultPath: vault, outDir: out, includeTypes: types });
      console.log(JSON.stringify(res, null, 2));
      process.exit(0);
    } catch (e) {
      console.error(String(e.stack || e));
      process.exit(1);
    }
  }

  if (sub === "flatten") {
    const vault = kv.vault;
    if (!vault) { console.error("usage: routekit notes flatten --vault=<abs>"); process.exit(1); }
    const { flattenVault } = await import("../notes-flatten.js");
    const res = flattenVault({ vaultPath: vault });
    console.log(JSON.stringify(res, null, 2));
    process.exit(0);
  }

  if (sub === "link") {
    const slug = kv.slug;
    const ns = kv.namespace || kv.ns || "clients.generic.projects";
    if (!slug) { console.error("usage: routekit notes link --slug=<slug> [--namespace=clients.generic.projects]"); process.exit(1); }
    const rootVault = process.env.HOME + "/Documents/projects/notes";
    const { linkProjectNotes } = await import("../notes-link.js");
    const res = linkProjectNotes({ rootVault, slug, namespace: ns });
    console.log(JSON.stringify(res, null, 2));
    process.exit(0);
  }
}
