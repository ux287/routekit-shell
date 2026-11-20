import path from "path";
import fs from "fs";
import YAML from "yaml";
import { pathToFileURL } from "url";
import dotenv from "dotenv";
import { snapshotGitEnv, restoreGitEnv } from "./shared/remote-env-scrub.mjs";

// { context, projectJsonPath, mtime }
const contextCache = new Map();

export function envProjectRoot() {
  const raw =
    (process.env.ROUTEKIT_PROJECT_ROOT && String(process.env.ROUTEKIT_PROJECT_ROOT).trim()) ||
    (process.env.RKS_PROJECT_ROOT && String(process.env.RKS_PROJECT_ROOT).trim()) ||
    null;
  if (!raw) return null;
  const resolved = path.resolve(raw);
  // If the path doesn't exist on disk, ignore it — stale env var after a project rename.
  // Fall through to registry lookup so the correct project is still found.
  if (!fs.existsSync(resolved)) {
    console.error(`[mcp] ROUTEKIT_PROJECT_ROOT points to non-existent path: ${resolved} — ignoring, falling back to registry`);
    return null;
  }
  return resolved;
}

export async function loadProjectContext(projectId, repoRoot) {
  if (!projectId) throw new Error("projectId is required");
  if (!repoRoot) throw new Error("repoRoot is required");
  const overrideRoot = envProjectRoot();
  const cacheKey = `${projectId}:${overrideRoot || ""}`;
  if (contextCache.has(cacheKey)) {
    const cached = contextCache.get(cacheKey);
    try {
      const currentMtime = fs.statSync(cached.projectJsonPath).mtimeMs;
      if (currentMtime === cached.mtime) return cached.context;
      console.error(`[mcp] project.json changed for ${projectId}, invalidating cache`);
    } catch (e) {
      // file gone or unreadable — fall through to reload
    }
    contextCache.delete(cacheKey);
  }

  let record = null;
  // Only use env override for the "self" project (the project running the MCP server)
  // For other projects (e.g., temp test projects), use registry lookup to get correct roots
  const selfProjectId = process.env.ROUTEKIT_PROJECT_ID || (() => {
    // In standalone/override mode, read project ID from local .rks/project.json at the override root
    if (overrideRoot) {
      const localProjectJsonPath = path.join(overrideRoot, '.rks', 'project.json');
      if (fs.existsSync(localProjectJsonPath)) {
        try {
          const localJson = JSON.parse(fs.readFileSync(localProjectJsonPath, 'utf8'));
          return localJson.id || null;
        } catch (e) {
          // ignore and fall through
        }
      }
    }
    return null;
  })();

  if (overrideRoot && projectId === selfProjectId) {
    record = { id: projectId, root: overrideRoot, path: overrideRoot };
    // Merge config from local registry (branches, stack, etc.)
    for (const registryName of ['routekit/registry.json', '.routekit/registry.json']) {
      const registryPath = path.join(overrideRoot, registryName);
      if (fs.existsSync(registryPath)) {
        try {
          const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
          const projects = registry.projects || [];
          const localRecord = projects.find(p => p.id === projectId);
          if (localRecord) {
            record = { ...localRecord, root: overrideRoot, path: overrideRoot };
            console.error(`[mcp] merged local registry config from ${registryName}`);
          }
        } catch (e) {
          console.warn(`[mcp] failed to read local registry ${registryName}: ${e.message}`);
        }
        break;
      }
    }
  } else {
    const { loadProjects } = await import(pathToFileURL(path.join(repoRoot, "packages/cli/src/project/index.js")).href);
    const projects = loadProjects(repoRoot);
    record = projects.find((p) => p.id === projectId) || null;
    if (!record) throw new Error(`Project not found: ${projectId}`);
    if (!record.root) throw new Error(`Project ${projectId} missing root in registry`);
  }

  // Load project-specific .env file (override=true to use project's keys over parent)
  // Protect routing env vars from being overwritten by the project .env file —
  // .mcp.json-injected values must survive dotenv so that subsequent envProjectRoot()
  // calls still see the correct (server-startup-time) ROUTEKIT_PROJECT_ROOT.
  const projectEnvPath = path.join(record.root, ".env");
  if (fs.existsSync(projectEnvPath)) {
    const savedRoutingVars = {
      ROUTEKIT_PROJECT_ROOT: process.env.ROUTEKIT_PROJECT_ROOT,
      RKS_PROJECT_ROOT: process.env.RKS_PROJECT_ROOT,
      ROUTEKIT_PROJECT_ID: process.env.ROUTEKIT_PROJECT_ID,
    };
    // backlog.fix.mcp-boot-dotenv-bypass-vars: the token-gate bypass variables are re-read from
    // process.env per request by server.mjs, so a project .env must neither add nor (via
    // override:true) overwrite them. Saved and restored exactly, like savedRoutingVars.
    const savedBypassVars = {
      RKS_SKIP_PREFLIGHT: process.env.RKS_SKIP_PREFLIGHT,
      RKS_TEST_MODE: process.env.RKS_TEST_MODE,
      NODE_ENV: process.env.NODE_ENV,
    };
    // backlog.feat.remote-surface-lane-isolation: lane, actor, run identity and notes location are
    // launcher-set and process-global (re-read per call by envLane, resolveAttribution, decideRemote and
    // resolveNotesDir). A project .env must not change them for the process, in any lane.
    const savedIdentityVars = {
      RKS_VIA: process.env.RKS_VIA,
      RKS_VIA_DEFAULT: process.env.RKS_VIA_DEFAULT,
      RKS_ACTOR: process.env.RKS_ACTOR,
      RKS_DISPATCH_RUN_ID: process.env.RKS_DISPATCH_RUN_ID,
      DENDRON_VAULT_PATH: process.env.DENDRON_VAULT_PATH,
      ROUTEKIT_NOTES_DIR: process.env.ROUTEKIT_NOTES_DIR,
    };
    // backlog.fix.remote-http-entry-env-leaks: the remote entry's bearer secret lives in this same .env
    // and must never re-enter process.env (child processes inherit it), and git location and
    // config-injection variables (GIT_CONFIG_KEY_<n> included) must not come from a project .env.
    // Saved and restored exactly: a launch value is kept, an .env-only value is removed.
    const savedLauncherSecretVars = {
      RKS_REMOTE_BEARER: process.env.RKS_REMOTE_BEARER,
    };
    const savedGitEnv = snapshotGitEnv(process.env);
    dotenv.config({ path: projectEnvPath, override: true });
    restoreGitEnv(process.env, savedGitEnv);
    for (const [k, v] of Object.entries(savedLauncherSecretVars)) {
      if (v !== undefined) process.env[k] = v;
      else delete process.env[k];
    }
    for (const [k, v] of Object.entries(savedIdentityVars)) {
      if (v !== undefined) process.env[k] = v;
      else delete process.env[k];
    }
    for (const [k, v] of Object.entries(savedRoutingVars)) {
      if (v !== undefined) process.env[k] = v;
      else delete process.env[k];
    }
    for (const [k, v] of Object.entries(savedBypassVars)) {
      if (process.env[k] !== v) {
        console.error(`[mcp] ignored ${k} from ${projectEnvPath}: token-gate bypass variables are not taken from .env files`);
      }
      if (v !== undefined) process.env[k] = v;
      else delete process.env[k];
    }
    console.error(`[mcp] loaded .env from ${projectEnvPath}`);
  }

  // Try .rks/ first (new standard), fall back to routekit/ (legacy)
  let projectJsonPath = path.join(record.root, ".rks", "project.json");
  if (!fs.existsSync(projectJsonPath)) {
    projectJsonPath = path.join(record.root, "routekit", "project.json");
  }
  if (!fs.existsSync(projectJsonPath)) {
    throw new Error(`Missing .rks/project.json or routekit/project.json for ${projectId}`);
  }
  const projectJson = JSON.parse(fs.readFileSync(projectJsonPath, "utf8"));
  const kgFile = projectJson.kgFile || "routekit/kg.yaml";
  const kgPath = path.isAbsolute(kgFile) ? kgFile : path.join(record.root, kgFile);
  if (!fs.existsSync(kgPath)) throw new Error(`KG file not found for ${projectId}: ${kgPath}`);
  const kg = YAML.parse(fs.readFileSync(kgPath, "utf8"));

  const context = {
    record,
    projectJson,
    kg,
    kgPath,
    projectJsonPath,
  };
  const mtime = fs.statSync(projectJsonPath).mtimeMs;
  console.error(`[mcp] loaded project ${projectId}: root=${record.root}`);
  contextCache.set(cacheKey, { context, projectJsonPath, mtime });
  return context;
}

export function resolveKgKey(kg, key) {
  if (!key) return kg;
  const parts = key.split(".").filter(Boolean);
  let current = kg;
  for (const part of parts) {
    if (current && typeof current === "object" && part in current) {
      current = current[part];
    } else {
      return undefined;
    }
  }
  return current;
}
