import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { loadProjectContext } from "../project-context.mjs";
import YAML from "yaml";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const repoRoot = path.resolve(__dirname, "../../../..");
export const guardrailPolicyRelativePath = path.join("guardrails", "policy.json");
export const projectProtectedRelativePath = path.join(".rks", "protected-files.yml");

export function slugify(value) {
  return (value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72) || "task";
}

export function pascalCase(value) {
  return value
    .split(/[^a-z0-9]/i)
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())
    .join("") || "GeneratedPage";
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

export function normalizeProtectedConfig(raw) {
  if (!raw) return { protected: undefined, projectProtected: undefined };
  if (Array.isArray(raw)) {
    const uniq = Array.from(new Set(raw.filter((v) => typeof v === "string" && v.trim().length)));
    return { protected: uniq.length ? uniq : undefined, projectProtected: undefined };
  }
  if (typeof raw === "object") {
    const prot = Array.isArray(raw.protected)
      ? raw.protected.filter((v) => typeof v === "string" && v.trim().length)
      : [];
    const projectProt = Array.isArray(raw.projectProtected)
      ? raw.projectProtected.filter((v) => typeof v === "string" && v.trim().length)
      : [];
    return {
      protected: prot.length ? Array.from(new Set(prot)) : undefined,
      projectProtected: projectProt.length ? Array.from(new Set(projectProt)) : undefined,
    };
  }
  return { protected: undefined, projectProtected: undefined };
}

export function mergeProtectedConfigs(base = {}, incoming = {}) {
  const allProtected = [
    ...(base.protected || []),
    ...(incoming.protected || []),
  ];
  const allProjectProtected = [
    ...(base.projectProtected || []),
    ...(incoming.projectProtected || []),
  ];
  const uniq = (arr) => Array.from(new Set(arr.filter((v) => typeof v === "string" && v.trim().length)));
  const merged = {
    protected: uniq(allProtected),
    projectProtected: uniq(allProjectProtected),
  };
  if (!merged.protected.length) merged.protected = undefined;
  if (!merged.projectProtected.length) merged.projectProtected = undefined;
  return merged;
}

export function loadProjectProtectedConfig(projectRoot) {
  const protectedPath = path.join(projectRoot, projectProtectedRelativePath);
  if (!fs.existsSync(protectedPath)) return { protected: undefined, projectProtected: undefined };
  try {
    const raw = fs.readFileSync(protectedPath, "utf8");
    const parsed = YAML.parse(raw);
    return normalizeProtectedConfig(parsed);
  } catch (error) {
    console.warn(`[protected] Unable to parse ${protectedPath}: ${error.message}`);
    return { protected: undefined, projectProtected: undefined };
  }
}

export function writeProjectProtectedConfig(projectRoot, config) {
  const normalized = normalizeProtectedConfig(config);
  const protectedPath = path.join(projectRoot, projectProtectedRelativePath);
  ensureDir(path.dirname(protectedPath));
  const toWrite = {};
  if (normalized.protected) toWrite.protected = normalized.protected;
  if (normalized.projectProtected) toWrite.projectProtected = normalized.projectProtected;
  fs.writeFileSync(protectedPath, YAML.stringify(toWrite));
  return protectedPath;
}

export function isProtectedPath(relPath, patterns = []) {
  if (!relPath || !patterns?.length) return false;
  // const escape = (s) => s.replace(/[.+?^${}()|[\\]\\/]/g, "\\$&");
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return patterns.some((pat) => {
    if (!pat || typeof pat !== "string") return false;
    const escaped = escape(pat.trim());
    const regexSrc = escaped
      .replace(/\\\*\\\*/g, ".*")
      .replace(/\\\*/g, "[^/]*")
      .replace(/\\\?/g, ".");
    const re = new RegExp(`^${regexSrc}$`);
    return re.test(relPath);
  });
}

export async function loadContext(projectId) {
  try {
    return await loadProjectContext(projectId, repoRoot);
  } catch (error) {
    throw new McpError(ErrorCode.InvalidParams, error.message || String(error));
  }
}

// Directories to skip during recursive file listing (prevents stack overflow)
const SKIP_DIRS = new Set(['.tmp', 'node_modules', '.git', 'dist', 'build', '.next', '.nuxt', '.cache']);

export function listRelativeFiles(root, subPath) {
  const absolute = path.join(root, subPath);
  if (!fs.existsSync(absolute)) return [];
  const entries = fs.readdirSync(absolute, { withFileTypes: true });
  const items = [];
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const rel = path.join(subPath, entry.name);
    if (entry.isDirectory()) {
      items.push(...listRelativeFiles(root, rel));
    } else if (entry.isFile()) {
      items.push(rel);
    }
  }
  return items;
}

export function extractPageName(task) {
  const match = /page (?:called|named) ([a-z0-9- ]+)/i.exec(task);
  if (match) return match[1].trim();
  return task.split(/[.,]/)[0].trim();
}

export function buildPageContent(componentName) {
  return `import { HeroSection } from "../components/HeroSection";
import { CTASection } from "../components/CTASection";

export function ${componentName}() {
  return (
    <main className="space-y-16">
      <HeroSection />
      <section className="rounded-3xl bg-white p-10 text-center shadow-sm">
        <h2 className="text-3xl font-semibold text-slate-900">${componentName} Story</h2>
        <p className="mt-4 text-slate-600">
          Replace this placeholder with narrative that supports the new page objective.
        </p>
      </section>
      <CTASection />
    </main>
  );
}
`;
}

export function loadGuardrailPolicy(projectRoot) {
  const policyPath = path.join(projectRoot, guardrailPolicyRelativePath);
  if (!fs.existsSync(policyPath)) return null;
  try {
    const raw = fs.readFileSync(policyPath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    console.warn(`[guardrails] Unable to parse ${policyPath}: ${error.message}`);
    return null;
  }
}

export function matchGuardrailScenario(policy, slug = "") {
  const scenarios = Array.isArray(policy?.scenarios) ? policy.scenarios : [];
  for (const scenario of scenarios) {
    const labels = scenario?.match?.labels || [];
    if (labels.some((pattern) => slug.includes(pattern))) {
      return scenario;
    }
  }
  return policy?.default || null;
}

export function enforceGuardrail(toolName, { projectRoot, slug }) {
  const policy = loadGuardrailPolicy(projectRoot);
  if (!policy) return null;
  const scenario = matchGuardrailScenario(policy, slug || "");
  if (!scenario) return null;
  if (Array.isArray(scenario.allowedTools) && !scenario.allowedTools.includes(toolName)) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      `Guardrail "${scenario.id || "unknown"}" blocks ${toolName}. Allowed tools: ${scenario.allowedTools.join(", ")}`
    );
  }
  if (toolName === "rks.exec" && scenario.requiresReview) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      `Guardrail "${scenario.id || "unknown"}" requires human review before running ${toolName}.`
    );
  }
  return { scenario };
}

export function simulateGuardrailPolicy(projectRoot, label = "") {
  const policy = loadGuardrailPolicy(projectRoot);
  if (!policy) {
    throw new McpError(ErrorCode.InvalidParams, "Guardrail policy not found. Create guardrails/policy.json first.");
  }
  const scenario = matchGuardrailScenario(policy, label);
  const formatScenario = (entry) =>
    entry
      ? {
        id: entry.id || null,
        description: entry.description || null,
        allowedTools: entry.allowedTools || null,
        requiresReview: Boolean(entry.requiresReview),
      }
      : null;
  return {
    policyPath: path.join(projectRoot, guardrailPolicyRelativePath),
    label: label || null,
    matchedScenario: formatScenario(scenario),
    defaultScenario: formatScenario(policy.default || null),
    scenarios: Array.isArray(policy.scenarios) ? policy.scenarios.map(formatScenario) : [],
  };
}

/**
 * Branch topology configuration.
 * Defines which branches serve which roles in the workflow.
 *
 * Schema:
 * - working: branch for daily work (default: "staging")
 * - integration: branch for CI/preview builds (default: "staging")
 * - production: branch for production releases (default: "main")
 */
const DEFAULT_BRANCH_CONFIG = {
  working: "staging",
  integration: "staging",
  production: "main",
};

/**
 * Workflow configuration for branch operations.
 *
 * Schema:
 * - autoMergeIntegration: auto-merge PRs to integration branch (default: true)
 * - workingBranchLocal: working branch is local-only, not on origin (default: false)
 */
const DEFAULT_WORKFLOW_CONFIG = {
  autoMergeIntegration: true,
  workingBranchLocal: false,
};

/**
 * Get branch configuration from project record.
 * Merges project-specific config with defaults.
 * Respects baseBranch from project.json when no explicit branches config exists.
 *
 * @param {object} projectRecord - Project record from registry
 * @param {object} [projectJson] - Optional project.json with baseBranch
 * @returns {object} Branch configuration { working, integration, production }
 */
export function getBranchConfig(projectRecord, projectJson) {
  const branches = projectRecord?.branches || projectJson?.branches || {};
  // Derive working/integration from baseBranch if no explicit branches config
  const baseBranch = projectJson?.baseBranch || projectRecord?.baseBranch;
  const defaults = baseBranch
    ? { working: baseBranch, integration: baseBranch, production: "main" }
    : DEFAULT_BRANCH_CONFIG;
  return {
    ...defaults,
    ...branches,
  };
}

/**
 * Get workflow configuration from project record.
 * Merges project-specific config with defaults.
 *
 * @param {object} projectRecord - Project record from registry
 * @returns {object} Workflow configuration { autoMergeIntegration, workingBranchLocal }
 */
export function getWorkflowConfig(projectRecord, projectJson) {
  const workflow = projectRecord?.workflow || {};
  const branchConfig = getBranchConfig(projectRecord, projectJson);

  // For 3-branch workflows, default autoMergeIntegration to false
  // This makes promote/release human-led checkpoints
  const isThreeBranch = branchConfig.working !== branchConfig.integration;
  const defaultAutoMerge = isThreeBranch ? false : DEFAULT_WORKFLOW_CONFIG.autoMergeIntegration;

  return {
    ...DEFAULT_WORKFLOW_CONFIG,
    autoMergeIntegration: workflow.autoMergeIntegration ?? defaultAutoMerge,
    ...workflow,
  };
}

/**
 * Validate branch name - must be alphanumeric with hyphens/underscores/slashes.
 *
 * @param {string} name - Branch name to validate
 * @returns {boolean} Whether the branch name is valid
 */
export function isValidBranchName(name) {
  if (!name || typeof name !== "string") return false;
  // Allow alphanumeric, hyphens, underscores, and slashes (for namespaced branches)
  return /^[a-zA-Z0-9/_-]+$/.test(name) && name.length <= 100;
}

/**
 * Validate entire branch config object.
 *
 * @param {object} config - Branch configuration to validate
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateBranchConfig(config) {
  const errors = [];

  if (!config || typeof config !== "object") {
    return { valid: true, errors: [] }; // Empty config is valid (uses defaults)
  }

  for (const [key, value] of Object.entries(config)) {
    if (!["working", "integration", "production"].includes(key)) {
      errors.push(`Unknown branch role: ${key}`);
      continue;
    }
    if (!isValidBranchName(value)) {
      errors.push(`Invalid branch name for ${key}: "${value}"`);
    }
  }

  return { valid: errors.length === 0, errors };
}
