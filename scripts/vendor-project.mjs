#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SHELL_ROOT = path.resolve(__dirname, "..");

async function resolveProjectRoot(projectId) {
  const { getProjectById } = await import("../packages/cli/src/project/index.js");
  const project = getProjectById(projectId, SHELL_ROOT);
  if (!project || !(project.root || project.path)) return null;
  return path.resolve(project.root || project.path);
}

function removeDir(dir) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function shouldIgnore(relPath) {
  const parts = relPath.split(path.sep);
  if (parts.includes("node_modules")) return true;
  if (parts.includes(".git")) return true;
  if (parts.includes(".turbo")) return true;
  if (parts.includes(".pnpm-store")) return true;
  if (parts.includes(".cache")) return true;
  if (parts.includes("coverage")) return true;
  if (parts.includes("dist")) return true;
  if (parts.includes("build")) return true;
  if (parts[0] && parts[0].startsWith("tmp")) return true;
  return false;
}

async function copyRepo(destDir) {
  await fs.promises.mkdir(destDir, { recursive: true });
  const filter = (src) => {
    const rel = path.relative(SHELL_ROOT, src);
    if (!rel) return true;
    if (rel.startsWith("..")) return false;
    if (shouldIgnore(rel)) return false;
    return true;
  };
  await fs.promises.cp(SHELL_ROOT, destDir, {
    recursive: true,
    filter,
    dereference: false,
  });
}

async function updatePackageJson(projectRoot) {
  const pkgPath = path.join(projectRoot, "package.json");
  if (!fs.existsSync(pkgPath)) {
    console.warn(`[vendor] package.json not found at ${pkgPath}, skipping script injection.`);
    return;
  }
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  pkg.scripts = pkg.scripts || {};
  const scripts = {
    "rks:plan": "node tools/routekit-shell/packages/cli/bin/routekit.js plan",
    "rks:exec": "node tools/routekit-shell/packages/cli/bin/routekit.js exec",
    "rks:rag:init": "node tools/routekit-shell/packages/cli/bin/routekit.js rag init",
  };
  let changed = false;
  for (const [k, v] of Object.entries(scripts)) {
    if (pkg.scripts[k] !== v) {
      pkg.scripts[k] = v;
      changed = true;
    }
  }
  if (changed) {
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
    console.log(`[vendor] updated package.json scripts in ${pkgPath}`);
  } else {
    console.log("[vendor] package.json scripts already present; no changes.");
  }
}

async function copyHooks(projectRoot) {
  const srcHooksDir = path.join(SHELL_ROOT, ".routekit", "hooks");
  const destHooksDir = path.join(projectRoot, ".routekit", "hooks");

  if (!fs.existsSync(srcHooksDir)) {
    console.warn("[vendor] no hooks found in rks .routekit/hooks/, skipping.");
    return;
  }

  // Always overwrite hooks (they come from rks)
  removeDir(destHooksDir);
  await fs.promises.mkdir(destHooksDir, { recursive: true });
  await fs.promises.cp(srcHooksDir, destHooksDir, { recursive: true });
  console.log(`[vendor] copied hooks to ${destHooksDir}`);
}

async function copyEnforcementConfig(projectRoot) {
  const srcConfig = path.join(SHELL_ROOT, "templates", "generic", ".routekit", "enforcement.yaml");
  const destConfig = path.join(projectRoot, ".routekit", "enforcement.yaml");

  // Don't overwrite existing config (project-specific customizations)
  if (fs.existsSync(destConfig)) {
    console.log("[vendor] enforcement.yaml already exists, preserving project config.");
    return;
  }

  if (!fs.existsSync(srcConfig)) {
    console.warn("[vendor] no template enforcement.yaml found, skipping.");
    return;
  }

  await fs.promises.mkdir(path.dirname(destConfig), { recursive: true });
  await fs.promises.copyFile(srcConfig, destConfig);
  console.log(`[vendor] created default enforcement.yaml at ${destConfig}`);
}

async function setupClaudeSettings(projectRoot) {
  const srcTemplate = path.join(SHELL_ROOT, "templates", "generic", ".claude", "settings.json.template");
  const destSettings = path.join(projectRoot, ".claude", "settings.json");

  if (fs.existsSync(destSettings)) {
    console.log("[vendor] .claude/settings.json exists. Add hooks config manually if needed:");
    console.log(`
  "hooks": {
    "PreToolUse": [{
      "matcher": "Read|Grep|Glob",
      "hooks": [{
        "type": "command",
        "command": "node \\"$CLAUDE_PROJECT_DIR\\"/.routekit/hooks/enforce-orchestration.mjs"
      }]
    }]
  }
`);
    return;
  }

  if (!fs.existsSync(srcTemplate)) {
    console.warn("[vendor] no settings.json template found, skipping.");
    return;
  }

  await fs.promises.mkdir(path.dirname(destSettings), { recursive: true });
  await fs.promises.copyFile(srcTemplate, destSettings);
  console.log(`[vendor] created .claude/settings.json at ${destSettings}`);
}

async function main() {
  const projectId = process.argv[2];
  if (!projectId) {
    console.error("usage: node scripts/vendor-project.mjs <projectId>");
    process.exit(1);
  }
  const projectRoot = await resolveProjectRoot(projectId);
  if (!projectRoot) {
    console.error(`Project not found in registry: ${projectId}`);
    process.exit(1);
  }

  const vendorDir = path.join(projectRoot, "tools", "routekit-shell");
  console.log(`[vendor] removing existing vendor dir if any: ${vendorDir}`);
  removeDir(vendorDir);

  console.log("[vendor] copying routekit-shell into child project...");
  await copyRepo(vendorDir);

  await updatePackageJson(projectRoot);

  console.log("[vendor] setting up hooks infrastructure...");
  await copyHooks(projectRoot);
  await copyEnforcementConfig(projectRoot);
  await setupClaudeSettings(projectRoot);

  console.log(`\nVendored routekit-shell into ${vendorDir}`);
}

main().catch((err) => {
  console.error("[vendor] failed:", err?.message || err);
  process.exit(1);
});
