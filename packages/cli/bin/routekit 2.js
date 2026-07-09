#!/usr/bin/env node
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";
import os from "os";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SHELL_ROOT = path.resolve(path.join(__dirname, "../../.."));
const TEMPLATES_DIR = path.join(SHELL_ROOT, "templates");

const HOME = os.homedir();
const PROJECTS_ROOT = path.resolve(path.join(HOME, "Documents", "projects"));
const WORKSPACE_DIR = path.join(PROJECTS_ROOT, ".vscode");
const WORKSPACE_PATH = path.join(WORKSPACE_DIR, "projects.code-workspace");
const ROOT_VAULT = path.join(PROJECTS_ROOT, "notes");

// ---------- utils ----------
function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }
function readJSON(p, fallback = {}) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fallback; } }
function writeFileWithBackup(p, content) {
  ensureDir(path.dirname(p));
  if (fs.existsSync(p)) {
    const bak = p + `.bak.${Date.now()}`;
    fs.copyFileSync(p, bak);
    console.log("backup:", bak);
  }
  fs.writeFileSync(p, content);
  console.log("wrote:", p);
}
function writeJSON(p, obj) { writeFileWithBackup(p, JSON.stringify(obj, null, 2)); }
function copyDir(src, dest, tokenMap = {}) {
  const entries = fs.readdirSync(src, { withFileTypes: true });
  ensureDir(dest);
  for (const e of entries) {
    const s = path.join(src, e.name);
    const dName = e.name.replace(/__slug__/g, tokenMap.slug || "__slug__");
    const d = path.join(dest, dName);
    if (e.isDirectory()) copyDir(s, d, tokenMap);
    else {
      let buf = fs.readFileSync(s, "utf8");
      for (const [k, v] of Object.entries(tokenMap)) buf = buf.replaceAll(`__${k}__`, v);
      ensureDir(path.dirname(d));
      fs.writeFileSync(d, buf);
      console.log("wrote:", d);
    }
  }
}
function parseArgs(argv) {
  const parts = argv.slice(2);
  const cmd = parts[0];
  const sub = parts[1] && !parts[1].startsWith("--") ? parts[1] : null;
  const kv = Object.fromEntries(
    parts.filter(s => s.startsWith("--")).map(s => {
      const [k, ...rest] = s.replace(/^--/, "").split("=");
      return [k, rest.join("=") || true];
    })
  );
  return { cmd, sub, kv };
}
function usage() {
  console.log(`routekit commands:

  project init    --slug=<slug> [--title="<Title>"] [--target=<abs path>]

  notes seed      --slug=<slug> --vault=<abs path to root vault>
  notes export    --vault=<abs> [--out=<dir>] [--types=blog,docs]

  workspace add      --path=<abs> [--name=<label>]
  workspace remove   --path=<abs>
  workspace rename   --path=<abs> --name=<label>
  workspace list     [--pretty]
  workspace prune
  workspace fix      # dedupe & sort by name/path, keeps projects root

  workspace health

  rag ingest|embed --project=<abs path>    # placeholders
  snapshot         --project=<abs path>    # placeholder
`); process.exit(1);
}

// ---------- workspace helpers ----------
function ensureWorkspace() {
  ensureDir(WORKSPACE_DIR);
  if (!fs.existsSync(WORKSPACE_PATH)) {
    const ws = { folders: [{ name: "projects", path: ".." }], settings: {} };
    writeJSON(WORKSPACE_PATH, ws);
  }
}
function relPathFromWorkspace(absPath) { return path.relative(WORKSPACE_DIR, absPath) || "."; }
function normalizeFolders(flds) {
  // normalize to { path, name? }, drop dupes by path, keep projects root
  const out = [];
  const seen = new Set();
  for (const f of flds) {
    const item = { path: f.path, ...(f.name ? { name: f.name } : {}) };
    const key = item.path;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}
function sortFolders(flds) {
  // keep projects root (.. ) first
  const root = flds.filter(f => f.path === "..");
  const rest = flds.filter(f => f.path !== "..");
  rest.sort((a, b) => (a.name || a.path).localeCompare(b.name || b.path));
  return root.concat(rest);
}
function pathExistsFromWorkspace(rel) {
  const abs = path.resolve(WORKSPACE_DIR, rel);
  return fs.existsSync(abs);
}
function workspaceRead() {
  ensureWorkspace();
  return readJSON(WORKSPACE_PATH, { folders: [], settings: {} });
}
function workspaceWrite(ws) {
  ws.folders = sortFolders(normalizeFolders(ws.folders));
  writeJSON(WORKSPACE_PATH, ws);
}
function workspaceAdd({ name, absPath }) {
  const ws = workspaceRead();
  const rel = relPathFromWorkspace(absPath);
  if (!ws.folders.some(f => f.path === rel)) {
    ws.folders.push(name ? { name, path: rel } : { path: rel });
    workspaceWrite(ws);
    console.log("workspace: added", rel);
  } else {
    console.log("workspace: already has", rel);
  }
}
function workspaceRemove({ absPath }) {
  const ws = workspaceRead();
  const rel = relPathFromWorkspace(absPath);
  const before = ws.folders.length;
  ws.folders = ws.folders.filter(f => f.path !== rel || f.path === "..");
  if (ws.folders.length !== before) {
    workspaceWrite(ws);
    console.log("workspace: removed", rel);
  } else {
    console.log("workspace: not found", rel);
  }
}
function workspaceRename({ absPath, name }) {
  const ws = workspaceRead();
  const rel = relPathFromWorkspace(absPath);
  let changed = false;
  ws.folders = ws.folders.map(f => {
    if (f.path === rel && rel !== "..") { changed = true; return { path: rel, name }; }
    return f;
  });
  if (changed) { workspaceWrite(ws); console.log("workspace: renamed", rel, "→", name); }
  else console.log("workspace: not found or cannot rename root", rel);
}
function workspacePrune() {
  const ws = workspaceRead();
  const keep = [];
  for (const f of ws.folders) {
    if (f.path === "..") { keep.push(f); continue; }
    if (pathExistsFromWorkspace(f.path)) keep.push(f);
    else console.log("workspace: pruned missing", f.path);
  }
  ws.folders = keep;
  workspaceWrite(ws);
}
function workspaceFix() {
  const ws = workspaceRead();
  workspaceWrite(ws);
  console.log("workspace: normalized (deduped & sorted)");
}
function workspaceList({ pretty=false } = {}) {
  const ws = workspaceRead();
  const rows = ws.folders.map(f => {
    const abs = path.resolve(WORKSPACE_DIR, f.path);
    const exists = f.path === ".." ? true : fs.existsSync(abs);
    return { name: f.name || path.basename(abs) || f.path, path: f.path, abs, exists };
  });
  if (pretty) {
    for (const r of rows) {
      const flag = r.exists ? "✔" : "✖";
      console.log(`${flag}  ${r.name}  —  ${r.path}`);
    }
  } else {
    console.log(JSON.stringify(rows, null, 2));
  }
}
function workspaceHealth() {
  const issues = [];
  if (!fs.existsSync(PROJECTS_ROOT)) issues.push({ type: "error", msg: "Projects root missing", path: PROJECTS_ROOT });
  if (!fs.existsSync(WORKSPACE_PATH)) issues.push({ type: "error", msg: "Workspace file missing", path: WORKSPACE_PATH });
  if (!fs.existsSync(ROOT_VAULT)) issues.push({ type: "warn", msg: "Root vault not found (optional)", path: ROOT_VAULT });
  const ws = workspaceRead();
  const seen = new Set();
  for (const f of ws.folders) {
    if (seen.has(f.path)) issues.push({ type: "warn", msg: "Duplicate folder path", path: f.path });
    seen.add(f.path);
  }
  for (const f of ws.folders) {
    if (f.path === "..") continue;
    const abs = path.resolve(WORKSPACE_DIR, f.path);
    if (!fs.existsSync(abs)) issues.push({ type: "warn", msg: "Missing folder", path: f.path });
  }
  console.log(JSON.stringify({ projectsRoot: PROJECTS_ROOT, workspaceFile: WORKSPACE_PATH, issues }, null, 2));
}

// ---------- command router ----------
const { cmd, sub, kv } = parseArgs(process.argv);
if (!cmd) usage();

if (cmd === "project" && sub === "init") {
  const slug = kv.slug;
  const title = kv.title || slug;
  if (!slug) { console.error("missing --slug"); usage(); }
  const target = kv.target ? path.resolve(kv.target) : path.join(PROJECTS_ROOT, slug);
  console.log("Scaffolding project:", { slug, title, target });
  ensureDir(target);
  copyDir(path.join(TEMPLATES_DIR, "app-web"), target, { slug, title });

  // Patch @routekit/design dep for npm (workspace/link -> file:abs)
  (function patchDesignDep(){
    try{
      const pkgPath = path.join(target,"package.json");
      const pkg = JSON.parse(fs.readFileSync(pkgPath,"utf8"));
      const dep = pkg?.dependencies?.["@routekit/design"];
      if (dep) {
        if (dep.startsWith("workspace:") || dep.startsWith("link:") || dep === "*") {
          const designAbs = path.join(SHELL_ROOT,"packages","design");
          pkg.dependencies["@routekit/design"] = "file:" + designAbs;
          fs.writeFileSync(pkgPath, JSON.stringify(pkg,null,2));
          console.log("patched @routekit/design ->", pkg.dependencies["@routekit/design"]);
        }
      } else {
        // ensure it exists at all
        const designAbs = path.join(SHELL_ROOT,"packages","design");
        pkg.dependencies = pkg.dependencies || {};
        pkg.dependencies["@routekit/design"] = "file:" + designAbs;
        fs.writeFileSync(pkgPath, JSON.stringify(pkg,null,2));
        console.log("added @routekit/design ->", pkg.dependencies["@routekit/design"]);
      }
    } catch(e){ console.warn("design dep patch skipped:", e.message); }
  })();
  const cfg = { slug, title, notesRoots: [`clients.generic.projects.${slug}.index`], namespace: `routekit/${slug}/1.0` };
  writeFileWithBackup(path.join(target, "routekit.json"), JSON.stringify(cfg, null, 2));

  // Add to workspace & seed notes if vault exists
  workspaceAdd({ name: slug, absPath: target });
  if (fs.existsSync(ROOT_VAULT)) {
    const dest = path.join(ROOT_VAULT, "clients.generic.projects." + slug);
    ensureDir(dest);
    copyDir(path.join(TEMPLATES_DIR, ".notes"), dest, { slug });
    console.log("notes: seeded into", dest);
  } else {
    console.log("notes: skipped (no root vault at", ROOT_VAULT, ")");
  }
  console.log("\nNext: cd", target, "&& npm install && git init -b main && code .");
  process.exit(0);
}

if (cmd === "notes" && sub === "seed") {
  const slug = kv.slug, vault = kv.vault;
  if (!slug || !vault) { console.error("usage: routekit notes seed --slug=<slug> --vault=<abs path>"); process.exit(1); }
  const dest = path.join(vault, "clients.generic.projects." + slug);
  ensureDir(dest);
  copyDir(path.join(TEMPLATES_DIR, ".notes"), dest, { slug });
  console.log("Seeded notes into:", dest);
  process.exit(0);
}

if (cmd === "workspace" && sub === "add")    { const abs = kv.path ? path.resolve(kv.path) : null; const name = kv.name || null; if (!abs) { console.error("usage: routekit workspace add --path=<abs> [--name=<label>]"); process.exit(1); } workspaceAdd({ name, absPath: abs }); process.exit(0); }
if (cmd === "workspace" && sub === "remove") { const abs = kv.path ? path.resolve(kv.path) : null; if (!abs) { console.error("usage: routekit workspace remove --path=<abs>"); process.exit(1); } workspaceRemove({ absPath: abs }); process.exit(0); }
if (cmd === "workspace" && sub === "rename") { const abs = kv.path ? path.resolve(kv.path) : null; const name = kv.name; if (!abs || !name) { console.error("usage: routekit workspace rename --path=<abs> --name=<label>"); process.exit(1); } workspaceRename({ absPath: abs, name }); process.exit(0); }
if (cmd === "workspace" && sub === "prune")  { workspacePrune(); process.exit(0); }
if (cmd === "workspace" && sub === "fix")    { workspaceFix(); process.exit(0); }
if (cmd === "workspace" && sub === "list")   { workspaceList({ pretty: !!kv.pretty }); process.exit(0); }
if (cmd === "workspace" && sub === "health") { workspaceHealth(); process.exit(0); }

if (cmd === "notes" && sub === "export") {
  const vault = kv.vault;
  const out   = kv.out   ? path.resolve(kv.out) : path.resolve("content");
  const types = (kv.types || "blog").split(",").map(s => s.trim()).filter(Boolean);
  if (!vault) { console.error("usage: routekit notes export --vault=<abs> [--out=<dir>] [--types=blog,docs]"); process.exit(1); }
  const { exportNotes } = await import("../src/export-notes.js");
  try {
    const res = exportNotes({ vaultPath: vault, outDir: out, includeTypes: types });
    console.log(JSON.stringify(res, null, 2));
    process.exit(0);
  } catch (e) {
    console.error(String(e.stack||e));
    process.exit(1);
  }
}

if (cmd === "rag" || cmd === "snapshot") { console.log("(placeholder)", cmd, sub ?? "", kv); process.exit(0); }


if (cmd === "notes" && sub === "flatten") {
  const vault = kv.vault;
  if (!vault) { console.error("usage: routekit notes flatten --vault=<abs>"); process.exit(1); }
  const { flattenVault } = await import("../src/notes-flatten.js");
  const res = flattenVault({ vaultPath: vault });
  console.log(JSON.stringify(res, null, 2));
  process.exit(0);
}


if (cmd === "notes" && sub === "link") {
  const slug = kv.slug;
  const ns = kv.namespace || kv.ns || "clients.generic.projects";
  if (!slug) { console.error("usage: routekit notes link --slug=<slug> [--namespace=clients.generic.projects]"); process.exit(1); }
  const rootVault = process.env.HOME + "/Documents/projects/notes";
  const { linkProjectNotes } = await import("../src/notes-link.js");
  const res = linkProjectNotes({ rootVault, slug, namespace: ns });
  console.log(JSON.stringify(res, null, 2));
  process.exit(0);
}


if (cmd === "hub") {
  if (sub === "rebuild") {
    const mode = kv.mode || "links";
    const root = process.env.HOME + "/Documents/projects";
    const rootVault = root + "/notes";
    const { rebuildHub } = await import("../src/hub-rebuild.js");
    const res = await rebuildHub({ root, rootVault, mode });
    console.log(JSON.stringify(res, null, 2));
    process.exit(0);
  }
}

usage();