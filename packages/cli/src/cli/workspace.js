import path from "path";
import fs from "fs";

export function createWorkspaceHelpers({ PROJECTS_ROOT, WORKSPACE_DIR, WORKSPACE_PATH, ROOT_VAULT, ensureDir, readJSON, writeJSON }) {
  function ensureWorkspace() {
    ensureDir(WORKSPACE_DIR);
    if (!fs.existsSync(WORKSPACE_PATH)) {
      const ws = { folders: [{ name: "projects", path: ".." }], settings: {} };
      writeJSON(WORKSPACE_PATH, ws);
    }
  }
  function relPathFromWorkspace(absPath) { return path.relative(WORKSPACE_DIR, absPath) || "."; }
  function normalizeFolders(flds) {
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
  function workspaceList({ pretty = false } = {}) {
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
  return {
    workspaceAdd,
    workspaceRemove,
    workspaceRename,
    workspacePrune,
    workspaceFix,
    workspaceList,
    workspaceHealth,
  };
}

export async function handleWorkspaceCommand({ sub, kv, helpers }) {
  const {
    workspaceAdd,
    workspaceRemove,
    workspaceRename,
    workspacePrune,
    workspaceFix,
    workspaceList,
    workspaceHealth,
  } = helpers;
  if (sub === "add") { const abs = kv.path ? path.resolve(kv.path) : null; const name = kv.name || null; if (!abs) { console.error("usage: routekit workspace add --path=<abs> [--name=<label>]"); process.exit(1); } workspaceAdd({ name, absPath: abs }); process.exit(0); }
  if (sub === "remove") { const abs = kv.path ? path.resolve(kv.path) : null; if (!abs) { console.error("usage: routekit workspace remove --path=<abs>"); process.exit(1); } workspaceRemove({ absPath: abs }); process.exit(0); }
  if (sub === "rename") { const abs = kv.path ? path.resolve(kv.path) : null; const name = kv.name; if (!abs || !name) { console.error("usage: routekit workspace rename --path=<abs> --name=<label>"); process.exit(1); } workspaceRename({ absPath: abs, name }); process.exit(0); }
  if (sub === "prune") { workspacePrune(); process.exit(0); }
  if (sub === "fix") { workspaceFix(); process.exit(0); }
  if (sub === "list") { workspaceList({ pretty: !!kv.pretty }); process.exit(0); }
  if (sub === "health") { workspaceHealth(); process.exit(0); }
}
