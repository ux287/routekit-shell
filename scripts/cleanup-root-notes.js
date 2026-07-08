import fs from "fs";
import path from "path";
const ROOT = path.resolve("notes");
const DEST_SCRATCH = path.join(ROOT, "scratch");
const DEST_ARCHIVE = path.join(ROOT, "archive");
const DEST_ROOT = path.join(ROOT, "root"); // legacy holding
function ensureDirs() {
    [DEST_SCRATCH, DEST_ARCHIVE, DEST_ROOT].forEach(d => fs.mkdirSync(d, { recursive: true }));
}
function isMarkdown(p) { return /\.mdx?$/.test(p); }
function isCanonical(p) { return /\/(decisions|specs)\//.test(p); }
function isJournalLike(name) {
    return /^\d{4}-\d{2}-\d{2}/.test(name) || /journal|daily|log/i.test(name);
}
function isAllCaps(name) { return /^[A-Z0-9_-]+\.mdx?$/.test(name); }
function classify(file) {
    const rel = path.relative(ROOT, file);
    if (rel.startsWith("decisions/") || rel.startsWith("specs/"))
        return null;
    if (!isMarkdown(file))
        return null;
    const base = path.basename(file);
    if (isJournalLike(base)) {
        return { from: file, to: path.join(DEST_ARCHIVE, base), reason: "journal-like" };
    }
    if (isAllCaps(base)) {
        return { from: file, to: path.join(DEST_SCRATCH, base), reason: "all-caps scratch" };
    }
    // default: push legacy root notes into 'root/'
    const dir = path.dirname(rel);
    if (dir === "." || dir === "") {
        return { from: file, to: path.join(DEST_ROOT, base), reason: "root-level markdown" };
    }
    return null;
}
function* walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
            yield* walk(p);
        }
        else {
            yield p;
        }
    }
}
async function main() {
    const dry = process.argv.includes("--dry-run");
    ensureDirs();
    const plans = [];
    for (const f of walk(ROOT)) {
        const plan = classify(f);
        if (plan)
            plans.push(plan);
    }
    console.log(`Found ${plans.length} files to move.`);
    plans.forEach(p => console.log(`- ${p.reason}: ${path.relative(process.cwd(), p.from)} -> ${path.relative(process.cwd(), p.to)}`));
    if (dry) {
        console.log("\nDry run complete. Rerun without --dry-run to apply.");
        return;
    }
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
