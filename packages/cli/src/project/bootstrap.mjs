import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { globSync } from "glob";
import YAML from "yaml";
import { upsertProject } from "./index.js";
import { sameDirectory, SelfSyncRefusedError } from "./sync.mjs";
import { loadSkillsExclude } from "./skills-manifest.mjs";
import { getRagConfig } from "../rag/config.mjs";
import { getDefaultVendoredMcpConfig, getDefaultWorkspaceMcpConfig, mergeMcpConfig } from "../mcp/config.mjs";
import { vendorViaCopy, vendorViaSubtree } from "../vendor/toolchain.mjs";
import {
  normalizeProtectedConfig,
  mergeProtectedConfigs,
  writeProjectProtectedConfig,
  projectProtectedRelativePath,
} from "../../../mcp-rks/src/server/project.mjs";
import { readRksVersion } from "./read-rks-version.mjs";

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function readJSON(p, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
}

function writeFileWithBackup(p, content) {
  ensureDir(path.dirname(p));
  if (fs.existsSync(p)) {
    const bak = p + `.bak.${Date.now()}`;
    fs.copyFileSync(p, bak);
  }
  fs.writeFileSync(p, content);
}

function writeJSONWithBackup(p, obj) {
  writeFileWithBackup(p, JSON.stringify(obj, null, 2) + "\n");
}

export function copyDirNoOverwrite(srcDir, destDir) {
  if (!fs.existsSync(srcDir) || !fs.statSync(srcDir).isDirectory()) return;
  ensureDir(destDir);
  const entries = fs.readdirSync(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const src = path.join(srcDir, entry.name);
    const dest = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyDirNoOverwrite(src, dest);
      continue;
    }
    if (!entry.isFile()) continue;
    if (fs.existsSync(dest)) continue;
    ensureDir(path.dirname(dest));
    fs.copyFileSync(src, dest);
  }
}

function ensureDendronYml({ projectRoot, projectId }) {
  const dendronPath = path.join(projectRoot, "dendron.yml");
  let needsWrite = false;
  if (!fs.existsSync(dendronPath)) {
    needsWrite = true;
  } else {
    try {
      const parsed = YAML.parse(fs.readFileSync(dendronPath, "utf8"));
      const vaults = parsed?.workspace?.vaults;
      if (parsed?.version !== 5 || !Array.isArray(vaults) || vaults.length === 0) needsWrite = true;
    } catch {
      needsWrite = true;
    }
  }
  if (!needsWrite) return dendronPath;
  const vaultName = String(projectId || "notes");
  const dendContent = `version: 5\nworkspace:\n  vaults:\n    - fsPath: notes\n      name: ${vaultName}\n      visibility: public\n`;
  writeFileWithBackup(dendronPath, dendContent);
  return dendronPath;
}

export function copyDirOverwrite(srcDir, destDir) {
  if (!fs.existsSync(srcDir) || !fs.statSync(srcDir).isDirectory()) return;
  ensureDir(destDir);
  const entries = fs.readdirSync(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const src = path.join(srcDir, entry.name);
    const dest = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyDirOverwrite(src, dest);
      continue;
    }
    if (!entry.isFile()) continue;
    ensureDir(path.dirname(dest));
    fs.copyFileSync(src, dest);
  }
}

function ensureGovernorArtifacts({ projectRoot, projectId, shellRoot }) {
  // backlog.fix.shell-self-sync-skill-wipe-health-gate: same self-target guard as syncProject —
  // bootstrap's skills loop has the identical rm-then-copy shape, so it wipes a shell bootstrapped
  // from itself exactly the same way. One implementation of the identity check, imported.
  if (sameDirectory(projectRoot, shellRoot)) {
    throw new SelfSyncRefusedError(
      `refusing to bootstrap ${projectRoot} from itself — projectRoot and shellRoot are the same ` +
        `directory. Bootstrapping a shell from itself deletes its skills.`,
      { projectRoot, shellRoot, at: "ensureGovernorArtifacts" },
    );
  }
  // Copy governor prompts (overwrite — child always gets latest)
  const srcPrompts = path.join(shellRoot, ".rks", "prompts");
  if (fs.existsSync(srcPrompts)) {
    const destPrompts = path.join(projectRoot, ".rks", "prompts");
    ensureDir(destPrompts);
    for (const file of fs.readdirSync(srcPrompts)) {
      if ((file.startsWith("governor-") || file.startsWith("agent-")) && file.endsWith(".md")) {
        fs.copyFileSync(path.join(srcPrompts, file), path.join(destPrompts, file));
      }
    }
  }

  // Copy skills (overwrite — child always gets latest, with projectId substitution)
  const srcSkills = path.join(shellRoot, ".claude", "skills");
  if (fs.existsSync(srcSkills)) {
    const skillsExclude = loadSkillsExclude(shellRoot);
    const destSkills = path.join(projectRoot, ".claude", "skills");
    ensureDir(destSkills);
    for (const entry of fs.readdirSync(srcSkills, { withFileTypes: true })) {
      if (!entry.isDirectory() || skillsExclude.has(entry.name)) continue;
      const srcSkill = path.join(srcSkills, entry.name);
      const destSkill = path.join(destSkills, entry.name);
      // Point-of-destruction guard — see syncProject. A symlinked dest defeats the entry guard.
      if (fs.existsSync(destSkill) && sameDirectory(srcSkill, destSkill)) {
        throw new SelfSyncRefusedError(
          `refusing to delete ${destSkill} — it is the same directory as its own copy source ${srcSkill}.`,
          { projectRoot, shellRoot, at: "skills" },
        );
      }
      if (fs.existsSync(destSkill)) fs.rmSync(destSkill, { recursive: true, force: true });
      copyDirOverwrite(srcSkill, destSkill);
      if (projectId && projectId !== "routekit-shell") {
        for (const f of fs.readdirSync(destSkill).filter(n => n.endsWith(".md"))) {
          const fp = path.join(destSkill, f);
          const content = fs.readFileSync(fp, "utf8");
          const updated = content.replace(/routekit-shell/g, projectId);
          if (updated !== content) fs.writeFileSync(fp, updated);
        }
      }
    }
  }

  // Copy agent definitions (e.g. the restricted `governor` agent-type) so children
  // inherit the launch-time tool restriction — without this, governors launched in a
  // child would fall back to general-purpose (all tools) and the restriction would not
  // reach child projects. Overwrite — child always gets latest. Tool names are
  // mcp__rks__* (not "routekit-shell"), so no substitution is applied here.
  const srcAgents = path.join(shellRoot, ".claude", "agents");
  if (fs.existsSync(srcAgents)) {
    const destAgents = path.join(projectRoot, ".claude", "agents");
    ensureDir(destAgents);
    for (const file of fs.readdirSync(srcAgents)) {
      if (file.endsWith(".md")) {
        fs.copyFileSync(path.join(srcAgents, file), path.join(destAgents, file));
      }
    }
  }
}

function ensureVitestRunner({ projectRoot, shellRoot }) {
  const srcRunner = path.join(shellRoot, "scripts", "vitest-runner.mjs");
  const srcSpawn = path.join(shellRoot, "scripts", "lib", "spawn-managed.mjs");
  if (fs.existsSync(srcRunner)) {
    const destScripts = path.join(projectRoot, "scripts");
    ensureDir(destScripts);
    fs.copyFileSync(srcRunner, path.join(destScripts, "vitest-runner.mjs"));
  }
  if (fs.existsSync(srcSpawn)) {
    const destLib = path.join(projectRoot, "scripts", "lib");
    ensureDir(destLib);
    fs.copyFileSync(srcSpawn, path.join(destLib, "spawn-managed.mjs"));
  }
  // No-overwrite: child project may have customized this shim
  const destShim = path.join(projectRoot, "vitest.config.unit.mjs");
  if (!fs.existsSync(destShim)) {
    const srcShim = path.join(shellRoot, "templates", "base", "vitest.config.unit.mjs");
    if (fs.existsSync(srcShim)) {
      fs.copyFileSync(srcShim, destShim);
    }
  }
  // No-overwrite: distribute the base config the shim re-exports, single-sourced
  // from templates/base/vitest.config.base.mjs (canonical), so the child's config
  // chain resolves out of the box without the child authoring its own config.
  const destBase = path.join(projectRoot, "vitest.config.base.mjs");
  if (!fs.existsSync(destBase)) {
    const srcBase = path.join(shellRoot, "templates", "base", "vitest.config.base.mjs");
    if (fs.existsSync(srcBase)) {
      fs.copyFileSync(srcBase, destBase);
    }
  }
}

function ensureHooksDir({ projectRoot, shellRoot }) {
  const hooksDir = path.join(projectRoot, ".routekit", "hooks");
  // Canonical source is packages/hooks/ — fall back to template for older installs
  const canonicalHooksDir = path.join(shellRoot, "packages", "hooks");
  const sourceHooksDir = fs.existsSync(canonicalHooksDir)
    ? canonicalHooksDir
    : path.join(shellRoot, "templates", "generic", ".routekit", "hooks");

  if (fs.existsSync(hooksDir)) {
    if (fs.existsSync(sourceHooksDir)) {
      copyDirNoOverwrite(sourceHooksDir, hooksDir);
    }
    return hooksDir;
  }

  ensureDir(hooksDir);
  if (fs.existsSync(sourceHooksDir)) {
    copyDirNoOverwrite(sourceHooksDir, hooksDir);
  }
  return hooksDir;
}

export function ensureMcpJson({ projectRoot, projectId, dev, shellRoot }) {
  const mcpPath = path.join(projectRoot, ".mcp.json");
  if (fs.existsSync(mcpPath)) return mcpPath;

  // Always point the child's rks server at the invoking shell's mcp-rks binary
  // (absolute path), matching repin-mcp's shellMcpBinary(shellRoot). The former
  // non-dev value "node_modules/@routekit/mcp-rks/bin/mcp-rks.mjs" pointed at the
  // workspace-only, UNPUBLISHED @routekit/mcp-rks package, which a fresh child's
  // `npm install` never fetches — so the child's rks MCP server died on first open
  // ("Cannot find module"). The `dev` flag no longer changes this path.
  const serverPath = path.join(shellRoot, "packages/mcp-rks/bin/mcp-rks.mjs");

  const config = {
    mcpServers: {
      rks: {
        command: "node",
        args: [serverPath],
        env: { ROUTEKIT_PROJECT_ID: projectId, ROUTEKIT_PROJECT_ROOT: projectRoot }
      }
    }
  };

  writeJSONWithBackup(mcpPath, config);
  return mcpPath;
}

function ensureClaudeMd({ projectRoot, projectId, shellRoot }) {
  const claudeMdPath = path.join(projectRoot, "CLAUDE.md");
  if (fs.existsSync(claudeMdPath)) return claudeMdPath;

  const templatePath = path.join(shellRoot, "templates", "base", "CLAUDE.md");
  if (!fs.existsSync(templatePath)) return claudeMdPath;

  let content = fs.readFileSync(templatePath, "utf8");
  content = content.replace(/__PROJECT_ID__/g, projectId);
  writeFileWithBackup(claudeMdPath, content);
  return claudeMdPath;
}

// The hook manifest is the authoritative map of hook name -> { tier, path }.
// Hooks deploy into tier subdirectories (.routekit/hooks/<tier>/<name>.mjs via
// ensureHooksDir/copyDirNoOverwrite), so every settings.json registration must
// point at that tiered path. A flat ".routekit/hooks/<name>.mjs" fails to load
// ("Cannot find module"), which Claude Code treats as a non-blocking hook error
// and runs the tool unredirected — silently disabling the entire guardrail layer
// in the child. See backlog.fix.child-bash-read-boundary-bypass.
function loadHookManifest(shellRoot) {
  if (!shellRoot) return null;
  const manifestPath = path.join(shellRoot, ".routekit", "hooks-manifest.json");
  try {
    return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch {
    // Synthetic/older shellRoot without a manifest — caller degrades to flat
    // paths so `routekit project attach` does not crash. Real rks shells always
    // ship the manifest, so real children get tiered (resolvable) registrations.
    return null;
  }
}

// Rewrite flat hook command paths (.routekit/hooks/<name>.mjs) to their tiered
// manifest paths (.routekit/hooks/<tier>/<name>.mjs) in an EXISTING child's
// settings.json. Repairs children scaffolded before the tier migration, whose
// generator emitted flat paths that no longer resolve. Idempotent: an
// already-tiered command contains a "/" after "hooks/" and is left untouched.
// Preserves env, permissions, and all non-hook content. Returns true if changed.
export function migrateChildSettingsHookPaths({ settingsPath, manifest }) {
  if (!manifest) return false;
  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  } catch {
    return false; // missing or hand-broken settings — do not corrupt it
  }
  // Match only a FLAT hook file: "hooks/" immediately followed by a basename
  // with no "/" before ".mjs". Tiered paths ("hooks/read/foo.mjs") never match.
  const flatRe = /(\.routekit\/hooks\/)([^"/]+\.mjs)/g;
  let changed = false;
  const rewrite = (cmd) =>
    cmd.replace(flatRe, (m, prefix, file) => {
      const entry = manifest[file.replace(/\.mjs$/, "")];
      if (!entry || !entry.path) return m; // unknown hook — leave untouched
      const next = `${prefix}${entry.path}`;
      if (next !== m) changed = true;
      return next;
    });
  const events = settings.hooks && typeof settings.hooks === "object" ? settings.hooks : {};
  for (const event of Object.keys(events)) {
    for (const group of Array.isArray(events[event]) ? events[event] : []) {
      for (const h of Array.isArray(group.hooks) ? group.hooks : []) {
        if (h && typeof h.command === "string") h.command = rewrite(h.command);
      }
    }
  }
  if (changed) writeJSONWithBackup(settingsPath, settings);
  return changed;
}

export function ensureClaudeSettings({ projectRoot, shellRoot }) {
  const claudeDir = path.join(projectRoot, ".claude");
  ensureDir(claudeDir);
  const settingsPath = path.join(claudeDir, "settings.json");

  const manifest = loadHookManifest(shellRoot);

  // Existing child: migrate any flat hook registrations to their tiered paths,
  // then return (we never overwrite a child's settings wholesale).
  if (fs.existsSync(settingsPath)) {
    if (manifest) migrateChildSettingsHookPaths({ settingsPath, manifest });
    return settingsPath;
  }

  // Fresh child: emit tiered hook paths sourced from the manifest. If the
  // manifest is unavailable (synthetic/older shellRoot), fall back to a flat
  // path so attach does not crash — real shells always have the manifest, and
  // the child-settings regression guard enforces tiered paths for real builds.
  const hookCmd = (name) => {
    const entry = manifest && manifest[name.replace(/\.mjs$/, "")];
    if (entry && entry.path) {
      return `node "$CLAUDE_PROJECT_DIR"/.routekit/hooks/${entry.path}`;
    }
    return `node "$CLAUDE_PROJECT_DIR"/.routekit/hooks/${name}`;
  };

  const settings = {
    env: {
      RKS_GUARDRAILS: "on"
    },
    permissions: {
      allow: [
        "mcp__rks__rks_preflight",
        "mcp__rks__rks_rag_init",
        "mcp__rks__rks_rag_embed",
        "mcp__rks__rks_rag_query",
        "mcp__rks__rks_rag_compact",
        "mcp__rks__rks_interview",
        "mcp__rks__rks_project_get",
        "mcp__rks__rks_kg_query",
        "mcp__rks__rks_analyze",
        "mcp__rks__rks_guardrails_on",
        "mcp__rks__rks_guardrails_status",
        "mcp__rks__rks_telemetry_query",
        "mcp__rks__rks_telemetry_report",
        "mcp__rks__rks_agent_research",
        "mcp__rks__rks_agent_git",
        "mcp__rks__rks_agent_dendron",
        "mcp__rks__rks_agent_telemetry",
        "mcp__rks__rks_agent_validate_story",
        "mcp__rks__rks_agent_external_research",
        "mcp__rks__rks_agent_ship",
        "mcp__rks__rks_agent_cycle_complete",
        "mcp__rks__rks_agent_story",
        "mcp__rks__rks_agent_lifecycle",
        "mcp__rks__rks_agent_delivery",
        "mcp__rks__rks_agent_recovery"
      ]
    },
    hooks: {
      PreToolUse: [
        {
          matcher: "*",
          hooks: [
            { type: "command", command: hookCmd("guardrails-gate.mjs") },
            { type: "command", command: hookCmd("guardrails-auto-enable.mjs") }
          ]
        },
        {
          matcher: "EnterPlanMode",
          hooks: [
            { type: "command", command: hookCmd("redirect-plan-to-backlog.mjs") }
          ]
        },
        {
          matcher: "Read",
          hooks: [
            { type: "command", command: hookCmd("redirect-read-to-agent.mjs") }
          ]
        },
        {
          matcher: "Grep",
          hooks: [
            { type: "command", command: hookCmd("redirect-grep-to-agent.mjs") }
          ]
        },
        {
          matcher: "Glob",
          hooks: [
            { type: "command", command: hookCmd("redirect-glob-to-agent.mjs") }
          ]
        },
        {
          matcher: "Task",
          hooks: [
            { type: "command", command: hookCmd("redirect-task-explore-to-agent.mjs") }
          ]
        },
        {
          matcher: "Read|Grep|Glob",
          hooks: [
            { type: "command", command: hookCmd("enforce-orchestration.mjs") }
          ]
        },
        {
          matcher: "Edit|Write",
          hooks: [
            { type: "command", command: hookCmd("protect-system-files.mjs") }
          ]
        },
        {
          matcher: "Edit|Write",
          hooks: [
            { type: "command", command: hookCmd("enforce-targetfile-scope.mjs") },
            { type: "command", command: hookCmd("enforce-plan-scope.mjs") },
            { type: "command", command: hookCmd("enforce-dendron-note-creation.mjs") }
          ]
        },
        {
          matcher: "mcp__rks__rks_validate_story",
          hooks: [
            { type: "command", command: hookCmd("redirect-validate-story-to-agent.mjs") }
          ]
        },
        {
          matcher: "mcp__rks__rks_git_commit|mcp__rks__rks_git_branch|mcp__rks__rks_checkout|mcp__rks__rks_git_merge|mcp__rks__rks_git_state|mcp__rks__rks_stash|mcp__rks__rks_restore|mcp__rks__rks_cherry_pick|mcp__rks__rks_tag",
          hooks: [
            { type: "command", command: hookCmd("redirect-git-tools-to-agent.mjs") }
          ]
        },
        {
          matcher: "mcp__rks__dendron_create_note|mcp__rks__dendron_edit_note|mcp__rks__dendron_read_note|mcp__rks__dendron_update_field|mcp__rks__dendron_fix_frontmatter|mcp__rks__dendron_validate_schema|mcp__rks__dendron_mark_implemented",
          hooks: [
            { type: "command", command: hookCmd("redirect-dendron-tools-to-agent.mjs") }
          ]
        },
        {
          matcher: "mcp__rks__rks_rag_query|mcp__rks__rks_kg_query",
          hooks: [
            { type: "command", command: hookCmd("redirect-rag-tools-to-agent.mjs") }
          ]
        },
        {
          matcher: "WebSearch",
          hooks: [
            { type: "command", command: hookCmd("redirect-websearch-to-agent.mjs") }
          ]
        },
        {
          matcher: "Bash",
          hooks: [
            { type: "command", command: hookCmd("redirect-read-bash-to-agent.mjs") },
            { type: "command", command: hookCmd("block-git-during-off-rail.mjs") },
            { type: "command", command: hookCmd("enforce-git-workflow.mjs") },
            { type: "command", command: hookCmd("enforce-branch-workflow.mjs") },
            { type: "command", command: hookCmd("check-dependency-security.mjs") }
          ]
        }
      ],
      PostToolUse: [
        {
          matcher: "mcp__rks__rks_agent_run|mcp__rks__rks_agent_research|mcp__rks__rks_agent_validate_story|mcp__rks__rks_agent_git|mcp__rks__rks_agent_dendron|mcp__rks__rks_agent_telemetry|mcp__rks__rks_agent_external_research|mcp__rks__rks_agent_ship|mcp__rks__rks_agent_cycle_complete|mcp__rks__rks_agent_story|mcp__rks__rks_agent_delivery|mcp__rks__rks_agent_recovery",
          hooks: [
            { type: "command", command: hookCmd("track-agent-provenance.mjs") }
          ]
        },
        {
          matcher: "Read|Grep|Glob|Bash|WebFetch|WebSearch",
          hooks: [
            { type: "command", command: hookCmd("monitor-context.mjs") }
          ]
        },
        {
          matcher: "Edit|Write",
          hooks: [
            { type: "command", command: hookCmd("track-write-telemetry.mjs") },
            { type: "command", command: hookCmd("check-docs-sync.mjs") }
          ]
        },
        {
          matcher: "Bash",
          hooks: [
            { type: "command", command: hookCmd("guardrails-auto-enable.mjs") }
          ]
        }
      ]
    }
  };

  writeJSONWithBackup(settingsPath, settings);
  return settingsPath;
}

function ensureMcpConfig({ projectRoot, preferVendored }) {
  const vscodeDir = path.join(projectRoot, ".vscode");
  ensureDir(vscodeDir);
  const mcpPath = path.join(vscodeDir, "mcp.json");
  const defaults = preferVendored ? getDefaultVendoredMcpConfig() : getDefaultWorkspaceMcpConfig();
  const applyBinding = (cfg) => {
    const next = cfg && typeof cfg === "object" ? { ...cfg } : {};
    const servers = next.servers && typeof next.servers === "object" ? { ...next.servers } : {};
    for (const [name, server] of Object.entries(servers)) {
      if (!server || typeof server !== "object") continue;
      const bound = { ...server };
      if (!bound.cwd) bound.cwd = ".";
      const existingEnv = bound.env && typeof bound.env === "object" ? bound.env : {};
      bound.env = {
        ROUTEKIT_PROJECT_ROOT: existingEnv.ROUTEKIT_PROJECT_ROOT ?? ".",
        RKS_PROJECT_ROOT: existingEnv.RKS_PROJECT_ROOT ?? ".",
        ...existingEnv,
      };
      servers[name] = bound;
    }
    next.servers = servers;
    return next;
  };
  try {
    if (!fs.existsSync(mcpPath)) {
      writeFileWithBackup(mcpPath, JSON.stringify(applyBinding(defaults), null, 2) + "\n");
    } else {
      const existing = readJSON(mcpPath, {});
      const merged = mergeMcpConfig(existing, defaults);
      writeFileWithBackup(mcpPath, JSON.stringify(applyBinding(merged), null, 2) + "\n");
    }
  } catch {
    // best-effort
  }
  return mcpPath;
}

function toTomlString(value) {
  return `"${String(value ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function toTomlArray(values) {
  return `[${values.map(toTomlString).join(", ")}]`;
}

function normalizeCodexServer(server, projectRoot) {
  const base = server && typeof server === "object" ? { ...server } : {};
  const env = base.env && typeof base.env === "object" ? { ...base.env } : {};
  if (!base.cwd || base.cwd === ".") base.cwd = projectRoot;
  if (env.ROUTEKIT_PROJECT_ROOT == null || env.ROUTEKIT_PROJECT_ROOT === ".") env.ROUTEKIT_PROJECT_ROOT = projectRoot;
  if (env.RKS_PROJECT_ROOT == null || env.RKS_PROJECT_ROOT === ".") env.RKS_PROJECT_ROOT = projectRoot;
  base.env = env;
  return base;
}

function renderCodexConfig({ servers } = {}) {
  const lines = [];
  for (const [name, server] of Object.entries(servers || {})) {
    if (!server || typeof server !== "object") continue;
    lines.push(`[mcp_servers.${name}]`);
    if (server.command) lines.push(`command = ${toTomlString(server.command)}`);
    if (Array.isArray(server.args)) lines.push(`args = ${toTomlArray(server.args)}`);
    if (server.cwd) lines.push(`cwd = ${toTomlString(server.cwd)}`);
    lines.push("");
    const env = server.env && typeof server.env === "object" ? server.env : null;
    if (env && Object.keys(env).length) {
      lines.push(`[mcp_servers.${name}.env]`);
      for (const [key, value] of Object.entries(env)) {
        lines.push(`${key} = ${toTomlString(value)}`);
      }
      lines.push("");
    }
  }
  return lines.join("\n").replace(/\n+$/, "\n");
}

function ensureCodexConfig({ projectRoot, preferVendored }) {
  const codexDir = path.join(projectRoot, ".codex");
  ensureDir(codexDir);
  const configPath = path.join(codexDir, "config.toml");
  if (fs.existsSync(configPath)) return configPath;

  const defaults = preferVendored ? getDefaultVendoredMcpConfig() : getDefaultWorkspaceMcpConfig();
  const absProjectRoot = path.resolve(projectRoot);
  const servers = {};
  for (const [name, server] of Object.entries(defaults?.servers || {})) {
    servers[name] = normalizeCodexServer(server, absProjectRoot);
  }
  const content = renderCodexConfig({ servers });
  writeFileWithBackup(configPath, content);
  return configPath;
}

function ensureCodexShim({ projectRoot, shellRoot }) {
  const codexBinDir = path.join(projectRoot, ".codex", "bin");
  const shimPath = path.join(codexBinDir, "codex");
  if (fs.existsSync(shimPath)) return shimPath;
  const templatePath = path.join(shellRoot, "scripts", "mcp", "codex-shim.sh");
  if (!fs.existsSync(templatePath)) return shimPath;
  ensureDir(codexBinDir);
  fs.copyFileSync(templatePath, shimPath);
  fs.chmodSync(shimPath, 0o755);
  return shimPath;
}

function ensureNotes({ projectRoot, projectId, nowIso, stackTemplate, shellRoot }) {
  const notesDir = path.join(projectRoot, "notes");
  ensureDir(notesDir);

  // Always seed base template notes (how-to guides)
  try {
    const baseNotesDir = path.join(shellRoot, "templates", "base", "notes");
    if (fs.existsSync(baseNotesDir)) {
      copyDirNoOverwrite(baseNotesDir, notesDir);
    }
  } catch {
    // best-effort
  }

  if (stackTemplate?.stackId) {
    // Stack-specific notes (may override base)
    try {
      const templateRoot = path.join(shellRoot, "templates", stackTemplate.stackId);
      const seedNotesDir = path.join(templateRoot, "skeleton", "notes");
      copyDirNoOverwrite(seedNotesDir, notesDir);
    } catch {
      // best-effort
    }
  } else {
    // Attach mode: add welcome note (simplified namespace — no project-slug prefix)
    const welcomeNotePath = path.join(notesDir, "welcome.md");
    if (!fs.existsSync(welcomeNotePath)) {
      const welcome = `# Welcome to ${projectId}\n\nThis repository has been attached to RouteKit as a runtime.\n\n- Project ID: ${projectId}\n- Attached: ${nowIso}\n\nYou can run:\n\n  routekit plan ${projectId} \"Describe the change you want\"\n\nor initialize RAG with:\n\n  routekit rag init ${projectId}\n`;
      writeFileWithBackup(welcomeNotePath, welcome);
    }
  }

  return notesDir;
}

function ensureProjectMeta({ projectRoot, projectId, stackId }) {
  const routekitDir = path.join(projectRoot, "routekit");
  ensureDir(routekitDir);
  const projectJsonPath = path.join(routekitDir, "project.json");
  const existing = readJSON(projectJsonPath, {});
  const now = new Date().toISOString();
  const projectMeta = {
    ...existing,
    id: projectId,
    root: ".",
    kgFile: "routekit/kg.yaml",
    stack: stackId || existing.stack || existing.template || null,
    attached: true,
    createdAt: existing.createdAt || now,
    attachedAt: now,
  };
  writeJSONWithBackup(projectJsonPath, projectMeta);

  const registryPath = path.join(routekitDir, "registry.json");
  const registry = readJSON(registryPath, { projects: [] });
  if (!Array.isArray(registry.projects)) registry.projects = [];
  const existingIndex = registry.projects.findIndex((p) => p.id === projectId);
  const entry = { id: projectId, path: projectRoot, stack: projectMeta.stack, attached: true, addedAt: now };
  if (existingIndex >= 0) registry.projects[existingIndex] = { ...registry.projects[existingIndex], ...entry };
  else registry.projects.push(entry);
  writeJSONWithBackup(registryPath, registry);

  return { routekitDir, projectJsonPath, registryPath, projectMeta };
}

function ensureKgAndProtected({ projectRoot, projectId, stackTemplate, shellRoot }) {
  const routekitDir = path.join(projectRoot, "routekit");
  ensureDir(routekitDir);
  const kgPath = path.join(routekitDir, "kg.yaml");
  if (stackTemplate?.kgPath && fs.existsSync(path.join(shellRoot, stackTemplate.kgPath))) {
    const absKg = path.join(shellRoot, stackTemplate.kgPath);
    const kgContent = fs.readFileSync(absKg, "utf8");
    writeFileWithBackup(kgPath, kgContent.endsWith("\n") ? kgContent : kgContent + "\n");

    if (stackTemplate.protectedConfigPath && fs.existsSync(path.join(shellRoot, stackTemplate.protectedConfigPath))) {
      try {
        const absProt = path.join(shellRoot, stackTemplate.protectedConfigPath);
        const parsed = YAML.parse(fs.readFileSync(absProt, "utf8"));
        const templateConfig = normalizeProtectedConfig(parsed);
        const projectProtectedPath = path.join(projectRoot, projectProtectedRelativePath);
        let merged = templateConfig;
        if (fs.existsSync(projectProtectedPath)) {
          const existing = YAML.parse(fs.readFileSync(projectProtectedPath, "utf8"));
          merged = mergeProtectedConfigs(normalizeProtectedConfig(existing), templateConfig);
        }
        writeProjectProtectedConfig(projectRoot, merged);
      } catch {
        // best-effort
      }
    }
    return kgPath;
  }

  if (!fs.existsSync(kgPath)) {
    const kgContent = `# RouteKit KG config for ${projectId}\nname: ${projectId}\nversion: 1\nsources:\n  - name: project-files\n    type: filesystem\n    path: .\n`;
    writeFileWithBackup(kgPath, kgContent);
  }
  return kgPath;
}

function ensureRagConfig(projectRoot) {
  try {
    const { configPath } = getRagConfig(projectRoot);
    return configPath;
  } catch {
    return null;
  }
}

function ensurePackageScripts({ projectRoot, projectId, vendored }) {
  const pkgPath = path.join(projectRoot, "package.json");
  const pkg = fs.existsSync(pkgPath) ? readJSON(pkgPath, {}) : { name: projectId, version: "1.0.0" };
  pkg.scripts = pkg.scripts || {};
  if (vendored) {
    pkg.scripts["rks:verify"] = "node tools/routekit-shell/packages/cli/bin/routekit.js project verify";
    pkg.scripts["rks:plan"] = `node tools/routekit-shell/packages/cli/bin/routekit.js plan ${projectId}`;
    pkg.scripts["rks:exec"] = `node tools/routekit-shell/packages/cli/bin/routekit.js exec ${projectId}`;
    pkg.scripts["rks:rag:init"] = `node tools/routekit-shell/packages/cli/bin/routekit.js rag init ${projectId}`;
    pkg.scripts["rks:rag:embed"] = `node tools/routekit-shell/packages/cli/bin/routekit.js rag embed ${projectId}`;
    pkg.scripts["rks:rag:query"] = `node tools/routekit-shell/packages/cli/bin/routekit.js rag query ${projectId}`;
  } else {
    if (!pkg.scripts["rks:plan"]) pkg.scripts["rks:plan"] = `routekit plan ${projectId}`;
    if (!pkg.scripts["rks:exec"]) pkg.scripts["rks:exec"] = `routekit exec ${projectId}`;
  }
  writeJSONWithBackup(pkgPath, pkg);
  return pkgPath;
}

/**
 * Bootstrap a usable git workflow for a freshly-scaffolded project: git init
 * (if needed), a baseline commit of the full scaffold, creation of the
 * branch-model branches, and checkout of the working branch — so the project is
 * immediately build-ready (rks_plan requires the working branch + a baseline
 * commit) with NO manual git surgery.
 *
 * Idempotent/safe: if the directory is already a git repo WITH commits, this is
 * a no-op and never clobbers existing history (important for `attach` onto an
 * existing repo). Best-effort: a git failure is reported, not thrown, so it
 * never crashes init.
 *
 * @param {object} args
 * @param {string} args.projectRoot
 * @param {{working?:string, integration?:string, production?:string}} args.branches
 */
export function ensureGitBootstrap({ projectRoot, branches } = {}) {
  const root = path.resolve(projectRoot);
  const gitDir = path.join(root, ".git");
  const run = (gitArgs) => execFileSync("git", gitArgs, { cwd: root, stdio: "pipe" });

  const alreadyRepo = fs.existsSync(gitDir);
  if (alreadyRepo) {
    // Never clobber an existing repo that already has history.
    try {
      execFileSync("git", ["rev-parse", "--verify", "HEAD"], { cwd: root, stdio: "ignore" });
      return { bootstrapped: false, reason: "existing-history" };
    } catch {
      // repo exists but has no commits yet — fall through and create the baseline
    }
  }

  const production = branches?.production || "main";
  const integration = branches?.integration || production;
  const working = branches?.working || production;

  try {
    if (!alreadyRepo) run(["init"]);
    run(["add", "-A"]);
    run([
      "-c", "user.name=RouteKit",
      "-c", "user.email=routekit@local",
      "commit", "--no-verify", "-m",
      "chore: initialize project from routekit-shell template",
    ]);
    // Normalize the initial branch to the production branch name, then add the rest.
    run(["branch", "-M", production]);
    for (const b of [integration, working]) {
      if (b && b !== production) {
        try { run(["branch", b]); } catch { /* branch already exists */ }
      }
    }
    if (working && working !== production) run(["checkout", working]);
    return {
      bootstrapped: true,
      working,
      branches: Array.from(new Set([production, integration, working].filter(Boolean))),
    };
  } catch (err) {
    return { bootstrapped: false, reason: "git-error", error: err?.message || String(err) };
  }
}

/**
 * Attach RouteKit to a project. This is the core primitive.
 * Called by both `routekit attach` and `routekit init` (after scaffolding).
 */
// Resolve the dependency-install command for a project ecosystem. Shaped as an
// ecosystem-keyed switch so future ecosystems (python/pip, rust/cargo) slot in
// without re-architecting; only the node/npm branch is implemented now.
export function resolveInstallCommand(ecosystem) {
  switch (ecosystem) {
    case "node":
      return { cmd: "npm", args: ["install", "--no-audit", "--no-fund"] };
    // Future: case "python": return { cmd: "pip", args: ["install", "-r", "requirements.txt"] };
    //         case "rust":   return { cmd: "cargo", args: ["build"] };
    default:
      return null;
  }
}

// Detect a project's ecosystem from its on-disk manifest. A package.json marks
// a node/npm project; future manifests (requirements.txt, Cargo.toml) branch here.
export function detectEcosystem(projectRoot) {
  if (fs.existsSync(path.join(projectRoot, "package.json"))) return "node";
  return null;
}

// Install a freshly-scaffolded child's declared deps so it runs hands-free (no
// manual `npm install`). Bounded + best-effort + NON-FATAL, mirroring the P0
// install in packages/mcp-rks/src/server/exec.mjs: a failed/slow/throwing
// install warns and lets the scaffold succeed — it never aborts project
// creation. node/npm only for now (the resolver is ecosystem-shaped for later).
// `spawn` is injectable for tests; it defaults to spawnSync.
export function runDependencyInstall(projectRoot, { spawn = spawnSync } = {}) {
  const installCmd = resolveInstallCommand(detectEcosystem(projectRoot));
  if (!installCmd) return { ran: false };
  try {
    const r = spawn(installCmd.cmd, installCmd.args, {
      cwd: projectRoot,
      timeout: 180000,
      encoding: "utf8",
    });
    if (r.status !== 0) {
      console.warn(
        `[rks.attach] ${installCmd.cmd} ${installCmd.args.join(" ")} exited ` +
          `${r.status ?? "(timeout/signal)"} — scaffolding succeeded; ` +
          `run it manually in the project if its deps are needed.`,
      );
      return { ran: true, ok: false };
    }
    return { ran: true, ok: true };
  } catch (e) {
    console.warn(
      `[rks.attach] dependency install failed to spawn: ${e?.message} — ` +
        `scaffolding succeeded; run it manually in the project.`,
    );
    return { ran: true, ok: false, threw: true };
  }
}

export async function attachProject({
  shellRoot,
  projectRoot,
  projectId,
  stackId = null,
  stackTemplate = null,
  vendor = null,
  vendorRef = "main",
  vendorRemote = null,
  gitInit = false,
  yes = false,
  dev = false,
  branchModel = "3-branch",
} = {}) {
  if (!shellRoot) throw new Error("shellRoot is required");
  if (!projectRoot) throw new Error("projectRoot is required");
  if (!projectId) throw new Error("projectId is required");

  const absProjectRoot = path.resolve(projectRoot);
  const nowIso = new Date().toISOString();

  const meta = ensureProjectMeta({ projectRoot: absProjectRoot, projectId, stackId });

  // Write branch config into .rks/project.json (the canonical config loadProjectContext reads)
  const baseBranch = branchModel === "2-branch" ? "main" : "dev";
  const branches = branchModel === "3-branch"
    ? { working: "dev", integration: "staging", production: "main" }
    : { working: "main", integration: "main", production: "main" };
  const rksDir = path.join(absProjectRoot, ".rks");
  ensureDir(rksDir);
  const rksProjectJsonPath = path.join(rksDir, "project.json");
  // Stamp the ACTUAL shell release version (not the frozen "0.1.0" literal) so
  // `routekit project upgrade` can compute a real from→to jump. "0.1.0" is the
  // UNSTAMPED sentinel, used only if the shell version can't be read.
  const currentRksVersion = readRksVersion(shellRoot);
  try {
    const rksJson = readJSON(rksProjectJsonPath, {});
    rksJson.baseBranch = baseBranch;
    rksJson.branches = branches;
    // Advance the stamp on re-attach — but never clobber a real version with the
    // sentinel if the read failed.
    if (currentRksVersion) rksJson.rksVersion = currentRksVersion;
    writeJSONWithBackup(rksProjectJsonPath, rksJson);
  } catch {
    // .rks/project.json doesn't exist yet — create it
    writeJSONWithBackup(rksProjectJsonPath, {
      id: projectId,
      rksVersion: currentRksVersion || "0.1.0",
      kgFile: "routekit/kg.yaml",
      baseBranch,
      branches,
    });
  }

  upsertProject(
    {
      id: projectId,
      stack: meta.projectMeta.stack,
      root: absProjectRoot,
      path: absProjectRoot,
      attached: true,
      addedAt: nowIso,
      branches,
    },
    shellRoot
  );

  const kgPath = ensureKgAndProtected({ projectRoot: absProjectRoot, projectId, stackTemplate, shellRoot });
  const notesDir = ensureNotes({ projectRoot: absProjectRoot, projectId, nowIso, stackTemplate, shellRoot });
  const dendronPath = ensureDendronYml({ projectRoot: absProjectRoot, projectId });

  const mcpJsonPath = ensureMcpJson({ projectRoot: absProjectRoot, projectId, dev, shellRoot });
  // Note: ensureMcpConfig (.vscode/mcp.json) intentionally removed — it conflicts
  // with .mcp.json and causes Claude Code MCP connection failures in child projects.
  const claudeSettingsPath = ensureClaudeSettings({ projectRoot: absProjectRoot, shellRoot });
  const preferVendored = true;
  const codexConfigPath = ensureCodexConfig({ projectRoot: absProjectRoot, preferVendored });
  const codexShimPath = ensureCodexShim({ projectRoot: absProjectRoot, shellRoot });
  const ragConfigPath = ensureRagConfig(absProjectRoot);

  let vendorResult = null;
  const destRel = path.join("tools", "routekit-shell");
  if (vendor === "copy") {
    vendorResult = await vendorViaCopy({ shellRoot, projectRoot: absProjectRoot, destRel, yes });
  } else if (vendor === "subtree") {
    vendorResult = await vendorViaSubtree({
      shellRoot,
      projectRoot: absProjectRoot,
      destRel,
      remoteName: "routekit-shell",
      remoteUrl: vendorRemote,
      ref: vendorRef,
      gitInit,
    });
  }

  ensurePackageScripts({ projectRoot: absProjectRoot, projectId, vendored: Boolean(vendorResult?.ok) });

  // Basic project health: ensure notes isn't empty for generic projects (template may seed already).
  try {
    const matches = globSync("**/*.md", { cwd: notesDir, nodir: true, dot: true });
    if (!matches.length) {
      const fallback = path.join(notesDir, "welcome.md");
      if (!fs.existsSync(fallback)) writeFileWithBackup(fallback, `# ${projectId}\n`);
    }
  } catch {
    // ignore
  }

  // Write needsOnboarding flag for interview flow
  const routekitStateDir = path.join(absProjectRoot, ".routekit");
  ensureDir(routekitStateDir);
  const statePath = path.join(routekitStateDir, "state.json");
  if (!fs.existsSync(statePath)) {
    writeJSONWithBackup(statePath, { needsOnboarding: true });
  }

  // Seed .gitignore from base template (don't overwrite existing)
  const gitignoreDest = path.join(absProjectRoot, ".gitignore");
  if (!fs.existsSync(gitignoreDest)) {
    const gitignoreSrc = path.join(shellRoot, "templates", "base", ".gitignore");
    if (fs.existsSync(gitignoreSrc)) {
      fs.copyFileSync(gitignoreSrc, gitignoreDest);
    }
  }

  // Seed CLAUDE.md from base template with projectId substitution
  ensureClaudeMd({ projectRoot: absProjectRoot, projectId, shellRoot });

  // Seed hooks from template — hooks are the enforcement layer
  const hooksDir = ensureHooksDir({ projectRoot: absProjectRoot, shellRoot });

  // Refresh the vendored hook-lib closure on re-attach. ensureHooksDir uses
  // copyDirNoOverwrite, which seeds packages/hooks/lib/ into FRESH children but
  // SKIPS files that already exist — so a re-attach would keep a stale lib/. The
  // deployed read/system hooks statically import this closure (../lib/…), so it
  // must track the shell's current copy. Overwrite it from the canonical source.
  const shellHookLibDir = path.join(shellRoot, "packages", "hooks", "lib");
  if (fs.existsSync(shellHookLibDir)) {
    copyDirOverwrite(shellHookLibDir, path.join(hooksDir, "lib"));
  }

  // Seed governor prompts and skills — required for Governors to function
  ensureGovernorArtifacts({ projectRoot: absProjectRoot, projectId, shellRoot });

  // Seed vitest runner scripts — required for rks exec test runs
  ensureVitestRunner({ projectRoot: absProjectRoot, shellRoot });

  // Seed .routekit policy files from template (don't overwrite existing)
  const templateRoutekitDir = path.join(shellRoot, "templates", "generic", ".routekit");
  const destRoutekitDir = path.join(absProjectRoot, ".routekit");
  if (fs.existsSync(templateRoutekitDir)) {
    const policyFiles = fs.readdirSync(templateRoutekitDir).filter(f => f.endsWith(".yaml"));
    for (const file of policyFiles) {
      const dest = path.join(destRoutekitDir, file);
      if (!fs.existsSync(dest)) {
        fs.copyFileSync(path.join(templateRoutekitDir, file), dest);
      }
    }
  }

  // Write branch-policy.yaml matching the chosen branchModel
  const branchPolicyPath = path.join(destRoutekitDir, "branch-policy.yaml");
  if (branchModel === "2-branch") {
    const policy = `# Branch workflow policy — 2-branch model
# feature/* → main

base_branch: main
protected_branches:
  - main
feature_branch_pattern: "^(feature|fix|refactor|docs|chore|rks)/.+"
require_tests_before_merge: true
merge_test_command: "npm test"
block_direct_commits_to:
  - main
block_merge_to_main: true
exempt_branches: []
`;
    writeFileWithBackup(branchPolicyPath, policy);
  } else {
    const policy = `# Branch workflow policy — 3-branch model
# feature/* → dev → main

base_branch: dev
protected_branches:
  - main
  - dev
feature_branch_pattern: "^(feature|fix|refactor|docs|chore|rks)/.+"
require_tests_before_merge: true
merge_test_command: "npm test"
block_direct_commits_to:
  - main
  - dev
block_merge_to_main: true
exempt_branches: []
`;
    writeFileWithBackup(branchPolicyPath, policy);
  }

  // Bootstrap a usable git workflow LAST (after all scaffolding) so the baseline
  // commit captures the full tree and the project is immediately build-ready —
  // git repo on the working branch with a clean baseline and the branch model.
  const gitBootstrap = ensureGitBootstrap({ projectRoot: absProjectRoot, branches });

  // Install the stack's declared deps so a fresh child is runnable hands-free
  // (no manual `npm install`). Bounded + non-fatal — a failed install warns and
  // the scaffold still succeeds. Single install site for the scaffold flow.
  runDependencyInstall(absProjectRoot);

  return {
    ok: true,
    projectRoot: absProjectRoot,
    projectId,
    gitBootstrap,
    routekitDir: meta.routekitDir,
    projectJsonPath: meta.projectJsonPath,
    registryPath: meta.registryPath,
    kgPath,
    dendronPath,
    notesDir,
    mcpJsonPath,
    claudeSettingsPath,
    codexConfigPath,
    codexShimPath,
    hooksDir,
    ragConfigPath,
    vendor: vendorResult,
  };
}

/** @deprecated Use attachProject instead */
export const bootstrapProject = attachProject;
