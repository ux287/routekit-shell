/**
 * Agent Config Loader
 *
 * Loads agent configuration from .rks/agents.yaml and prompts from
 * dendron notes (notes/agents.{name}.prompt.md).
 *
 * Precedence: env var > agents.yaml > hardcoded default
 * Prompt: dendron note > inline fallback
 */

import fs from 'fs';
import path from 'path';

// ENV var names per agent (backwards-compatible)
const ENV_MODEL_MAP = {
  'product-owner': 'RKS_PO_MODEL',
  'research': 'RKS_RESEARCH_MODEL',
  'git': 'RKS_GIT_MODEL',
  'dendron': 'RKS_DENDRON_MODEL',
  'telemetry': 'RKS_TELEMETRY_MODEL',
  'ship': 'RKS_SHIP_MODEL',
  'cycle-complete': 'RKS_CYCLE_COMPLETE_MODEL',
  'story': 'RKS_STORY_MODEL',
  'delivery': 'RKS_DELIVERY_MODEL',
  'recovery': 'RKS_RECOVERY_MODEL',
  'planner': 'RKS_PLANNER_MODEL',
  'lifecycle': 'RKS_LIFECYCLE_MODEL',
};

// Hardcoded defaults (last resort)
// fallbackModel: if set, runner retries failed agents with this model
const DEFAULTS = {
  'product-owner': { model: 'claude-sonnet-4-6', maxTurns: 5, timeoutMs: 60_000 },
  'research': { model: 'claude-haiku-4-5-20251001', fallbackModel: 'claude-sonnet-4-6', maxTurns: 7, timeoutMs: 60_000 },
  'git': { model: 'claude-haiku-4-5-20251001', maxTurns: 7, timeoutMs: 45_000 },
  'dendron': { model: 'claude-haiku-4-5-20251001', maxTurns: 5, timeoutMs: 30_000 },
  'telemetry': { model: 'claude-haiku-4-5-20251001', maxTurns: 5, timeoutMs: 30_000 },
  'ship': { model: 'claude-sonnet-4-6', maxTurns: 8, timeoutMs: 120_000 },
  'cycle-complete': { model: 'claude-haiku-4-5-20251001', maxTurns: 7, timeoutMs: 90_000 },
  'story': { model: 'claude-sonnet-4-6', maxTurns: 7, timeoutMs: 90_000 },
  'delivery': { model: 'claude-sonnet-4-6', maxTurns: 15, timeoutMs: 300_000 },
  'recovery': { model: 'claude-sonnet-4-6', maxTurns: 10, timeoutMs: 120_000 },
  'planner': { model: 'claude-sonnet-4-6', fallbackModel: 'claude-sonnet-4-6', maxTurns: 10, timeoutMs: 120_000 },
  'lifecycle': { model: 'claude-sonnet-4-6', maxTurns: 12, timeoutMs: 300_000 },
};

const GLOBAL_DEFAULTS = { model: 'claude-sonnet-4-6', maxTurns: 10, timeoutMs: 120_000 };

let _yamlCache = null;
let _yamlCachePath = null;

/**
 * Parse a simple YAML config (agents.yaml is flat enough for this).
 * Avoids adding a YAML dependency — handles our known structure only.
 */
function parseSimpleYaml(text) {
  const result = {};
  let currentAgent = null;

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    // Top-level key (e.g., "agents:")
    if (!line.startsWith(' ') && !line.startsWith('\t')) {
      continue; // skip top-level keys like "agents:"
    }

    // Agent name (2-space indent, e.g., "  product-owner:")
    const agentMatch = trimmed.match(/^([a-z][\w-]*):$/);
    if (agentMatch && (line.startsWith('  ') || line.startsWith('\t'))) {
      const indent = line.length - line.trimStart().length;
      if (indent <= 4) {
        currentAgent = agentMatch[1];
        result[currentAgent] = result[currentAgent] || {};
        continue;
      }
    }

    // Property (4-space indent, e.g., "    model: claude-sonnet-4-6")
    if (currentAgent) {
      const propMatch = trimmed.match(/^(\w+):\s*(.+)$/);
      if (propMatch) {
        const [, key, rawValue] = propMatch;
        const value = rawValue.trim();
        // Coerce numeric values
        const num = Number(value);
        result[currentAgent][key] = isNaN(num) ? value : num;
      }
    }
  }

  return result;
}

/**
 * Load agents.yaml config. Cached per projectRoot path.
 * @param {string} projectRoot
 * @returns {object} Parsed config keyed by agent name
 */
function loadYamlConfig(projectRoot) {
  const configPath = path.join(projectRoot, '.rks', 'agents.yaml');

  if (_yamlCache && _yamlCachePath === configPath) {
    return _yamlCache;
  }

  try {
    if (fs.existsSync(configPath)) {
      const text = fs.readFileSync(configPath, 'utf8');
      _yamlCache = parseSimpleYaml(text);
      _yamlCachePath = configPath;
      return _yamlCache;
    }
  } catch {
    // Fall through to empty
  }

  _yamlCache = {};
  _yamlCachePath = configPath;
  return _yamlCache;
}

/**
 * Load agent prompt from .rks/prompts/agent-{name}.md.
 * Strips frontmatter, returns body text or null if not found.
 * Hot-reloaded on every call — no caching.
 * @param {string} agentName
 * @param {string} projectRoot
 * @returns {string|null} Prompt text or null if not found
 */
export function loadAgentPrompt(agentName, projectRoot) {
  const filename = agentName === 'governor' ? 'governor-agent.md' : `agent-${agentName}.md`;
  const promptPath = path.join(projectRoot, '.rks', 'prompts', filename);

  try {
    if (!fs.existsSync(promptPath)) return null;

    const content = fs.readFileSync(promptPath, 'utf8');

    // Strip frontmatter (--- ... ---)
    const fmMatch = content.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
    const body = fmMatch ? fmMatch[1].trim() : content.trim();

    return body || null;
  } catch {
    return null;
  }
}

/**
 * Load merged agent configuration.
 *
 * Precedence: env var > agents.yaml > hardcoded default
 *
 * @param {string} agentName - e.g., "product-owner"
 * @param {string} projectRoot - Project root path
 * @returns {{ model: string, fallbackModel: string|undefined, maxTurns: number, timeoutMs: number, prompt: string|null }}
 */
export function loadAgentConfig(agentName, projectRoot) {
  const yamlConfig = loadYamlConfig(projectRoot);
  const agentYaml = yamlConfig[agentName] || {};
  const agentDefaults = DEFAULTS[agentName] || GLOBAL_DEFAULTS;

  // Model: env > yaml > default
  const envKey = ENV_MODEL_MAP[agentName];
  const envModel = envKey ? process.env[envKey] : undefined;
  const model = envModel || agentYaml.model || agentDefaults.model;

  // Fallback model: yaml > default (no env override — explicit config only)
  const fallbackModel = agentYaml.fallbackModel || agentDefaults.fallbackModel;

  // Runtime settings: yaml > default
  const maxTurns = agentYaml.maxTurns || agentDefaults.maxTurns;
  const timeoutMs = agentYaml.timeoutMs || agentDefaults.timeoutMs;

  // Prompt: dendron note (loaded fresh each time for hot-reload)
  const prompt = loadAgentPrompt(agentName, projectRoot);

  return { model, fallbackModel, maxTurns, timeoutMs, prompt };
}

/**
 * Clear the YAML config cache (for testing).
 */
export function clearConfigCache() {
  _yamlCache = null;
  _yamlCachePath = null;
}
