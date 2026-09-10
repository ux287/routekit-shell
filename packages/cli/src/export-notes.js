import fs from "fs";
import path from "path";
import matter from "gray-matter";

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.isFile() && /\.(md|mdx)$/i.test(e.name)) out.push(p);
  }
  return out;
}

export function exportNotes({ vaultPath, outDir, includeTypes = ["blog"], allowPublishFlag = true }) {
  if (!fs.existsSync(vaultPath)) {
    throw new Error(`vaultPath does not exist: ${vaultPath}`);
  }
  fs.mkdirSync(outDir, { recursive: true });
  let kept = 0, skipped = 0;

  for (const file of walk(vaultPath)) {
    const raw = fs.readFileSync(file, "utf8");
    const fm = matter(raw);
    const type = fm.data?.type;
    const publish = fm.data?.publish === true;
    const keep = (includeTypes.includes(type)) || (allowPublishFlag && publish);
    if (!keep) { skipped++; continue; }

    const sub = type || "misc";
    const base = path.basename(file).replace(/\.md$/i, ".mdx");
    const dest = path.join(outDir, sub, base);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, raw);
    kept++;
  }
  return { kept, skipped, outDir, from: vaultPath, types: includeTypes };
}