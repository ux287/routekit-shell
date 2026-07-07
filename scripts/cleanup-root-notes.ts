import fs from "fs";
import path from "path";

type MovePlan = { from: string; to: string; reason: string };

const ROOT = path.resolve("notes");
const DEST_SCRATCH = path.join(ROOT, "scratch");
const DEST_ARCHIVE = path.join(ROOT, "archive");
const DEST_ROOT = path.join(ROOT, "root"); // legacy holding

function ensureDirs() {
  [DEST_SCRATCH, DEST_ARCHIVE, DEST_ROOT].forEach(d => fs.mkdirSync(d, { recursive: true }));
}

function isMarkdown(p: string) { return /\.mdx?$/.test(p); }
function isCanonical(p: string) { return /\/(decisions|specs)\//.test(p); }
function isJournalLike(name: string) {
  return /^\d{4}-\d{2}-\d{2}/.test(name) || /journal|daily|log/i.test(name);
}
function isAllCaps(name: string) { return /^[A-Z0-9_-]+\.mdx?$/.test(name); }

function classify(file: string): MovePlan | null {
  const rel = path.relative(ROOT, file);
  const base = path.basename(file, path.extname(file));
  
  // Skip canonical Dendron notes
  if (base.startsWith("decisions.") || base.startsWith("specs.")) return null;
  if (!isMarkdown(file)) return null;

  if (isJournalLike(base)) {
    return { from: file, to: path.join(DEST_ARCHIVE, path.basename(file)), reason: "journal-like" };
  }
  if (isAllCaps(base)) {
    return { from: file, to: path.join(DEST_SCRATCH, path.basename(file)), reason: "all-caps scratch" };
  }
  
  // Move non-hierarchical notes to scratch (no dots in name except file extension)
  if (!base.includes('.')) {
    return { from: file, to: path.join(DEST_SCRATCH, path.basename(file)), reason: "non-hierarchical note" };
  }
  
  // Move notes that look like root clutter
  if (base.startsWith("root.") || base.includes("temp") || base.includes("scratch")) {
    return { from: file, to: path.join(DEST_ROOT, path.basename(file)), reason: "root-level clutter" };
  }
  
  return null;
}

function* walk(dir: string): Generator<string> {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      yield* walk(p);
    } else {
      yield p;
    }
  }
}

async function main() {
  const dry = process.argv.includes("--dry-run");
  ensureDirs();

  const plans: MovePlan[] = [];
  for (const f of walk(ROOT)) {
    const plan = classify(f);
    if (plan) plans.push(plan);
  }

  console.log(`Found ${plans.length} files to move.`);
  plans.forEach(p => console.log(`- ${p.reason}: ${path.relative(process.cwd(), p.from)} -> ${path.relative(process.cwd(), p.to)}`));

  if (dry) { console.log("\nDry run complete. Rerun without --dry-run to apply."); return; }

  // apply moves (create unique targets on conflict)
  for (const p of plans) {
    const dir = path.dirname(p.to);
    fs.mkdirSync(dir, { recursive: true });
    let target = p.to;
    let i = 1;
    while (fs.existsSync(target)) {
      const ext = path.extname(p.to);
      const name = path.basename(p.to, ext);
      target = path.join(dir, `${name}.${i}${ext}`);
      i++;
    }
    fs.renameSync(p.from, target);
  }
  console.log("Move complete.");
}

main().catch(e => { console.error(e); process.exit(1); });