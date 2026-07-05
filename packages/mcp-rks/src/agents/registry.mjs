/**
 * Agent Registry
 *
 * Maps agent names to their factory functions.
 * Also generates MCP tool definitions for per-agent convenience tools.
 */

import { createProductOwnerAgent, ProductOwnerInputSchema } from './product-owner.mjs';
import { createResearchAgent, ResearchInputSchema } from './research.mjs';
import { createGitAgent, GitInputSchema } from './git.mjs';
import { createDendronAgent, DendronInputSchema } from './dendron.mjs';
import { createTelemetryAgent, TelemetryInputSchema } from './telemetry.mjs';
import { createShipAgent, ShipInputSchema } from './ship.mjs';
import { createCycleCompleteAgent, CycleCompleteInputSchema } from './cycle-complete.mjs';
import { createStoryAgent, StoryInputSchema } from './story.mjs';
import { createDeliveryAgent, DeliveryInputSchema } from './delivery.mjs';
import { createRecoveryAgent, RecoveryInputSchema } from './recovery.mjs';
import { createPlannerAgent, PlannerInputSchema } from './planner.mjs';
import { zodToJsonSchema } from './zod-to-json-schema.mjs';
import { discoverProjectAgents, registerProjectAgents } from './discovery.mjs';

/**
 * Agent registry — maps agent name to { factory, inputSchema, description }.
 * Core agents are defined here. Project-specific agents are discovered
 * from .rks/agents/*.json at startup via initProjectAgents().
 */
const AGENTS = {
  'product-owner': {
    factory: createProductOwnerAgent,
    inputSchema: ProductOwnerInputSchema,
    description: 'Run the Product Owner agent to validate story readiness. Returns structured verdict with quality/completeness scores, gap detection, and RAG benchmarking.',
    toolName: 'rks_agent_validate_story',
    source: 'core',
  },
  'research': {
    factory: createResearchAgent,
    inputSchema: ResearchInputSchema,
    description: 'Run the Research agent to answer questions about the codebase, architecture, and documentation. Returns synthesized answers with sources and confidence scores.',
    toolName: 'rks_agent_research',
    source: 'core',
  },
  'git': {
    factory: createGitAgent,
    inputSchema: GitInputSchema,
    description: 'Run the Git agent to execute atomic git operations (status, branch, checkout, commit, stash, reset, diff, log). Returns structured summaries, not raw output.',
    toolName: 'rks_agent_git',
    source: 'core',
  },
  'dendron': {
    factory: createDendronAgent,
    inputSchema: DendronInputSchema,
    description: 'Run the Dendron agent to manage project notes — create, read, edit, validate frontmatter, update fields, and manage backlog lifecycle. Returns summaries, not raw file contents.',
    toolName: 'rks_agent_dendron',
    source: 'core',
  },
  'telemetry': {
    factory: createTelemetryAgent,
    inputSchema: TelemetryInputSchema,
    description: 'Run the Telemetry agent to query telemetry data, detect patterns, triage failures, and suggest improvements. Returns analysis summaries with actionable suggestions.',
    toolName: 'rks_agent_telemetry',
    source: 'core',
  },
  'ship': {
    factory: createShipAgent,
    inputSchema: ShipInputSchema,
    description: 'Run the Ship agent to handle the full code shipping workflow: branch, commit, push, PR creation, merge, and staging sync. Returns structured results with per-step status.',
    toolName: 'rks_agent_ship',
    source: 'core',
  },
  'cycle-complete': {
    factory: createCycleCompleteAgent,
    inputSchema: CycleCompleteInputSchema,
    description: 'Run the Cycle Complete agent for post-ship lifecycle: mark story implemented, update epic, run governance checks, verify git state, embed RAG. Ensures nothing is forgotten after shipping.',
    toolName: 'rks_agent_cycle_complete',
    source: 'core',
  },
  'story': {
    factory: createStoryAgent,
    inputSchema: StoryInputSchema,
    description: 'Run the Story agent to manage story lifecycle: read stories, validate readiness, check dependencies, advance phases, and list backlog items. Returns structured lifecycle status.',
    toolName: 'rks_agent_story',
    source: 'core',
  },
  'delivery': {
    factory: createDeliveryAgent,
    inputSchema: DeliveryInputSchema,
    description: 'Run the Delivery agent for walk-away autonomy: batch stories into a release by composing Story, Ship, and Cycle Complete agents. Validates, ships, and completes the full release pipeline.',
    toolName: 'rks_agent_delivery',
    source: 'core',
  },
  'recovery': {
    factory: createRecoveryAgent,
    inputSchema: RecoveryInputSchema,
    description: 'Run the Recovery agent to diagnose and repair broken state: git issues, stale locks, hook problems, RAG corruption. Composes Git Agent for complex repairs.',
    toolName: 'rks_agent_recovery',
    source: 'core',
  },
  'planner': {
    factory: createPlannerAgent,
    inputSchema: PlannerInputSchema,
    description: 'Run the Planner agent to design implementation plans for backlog stories. Cross-delegates to Research Agent for architecture context and PO Agent for story validation.',
    toolName: 'rks_agent_plan',
    source: 'core',
  },
};

/**
 * Initialize project-specific agents from .rks/agents/*.json.
 * Call this once at MCP server startup after projectRoot is known.
 * @param {string} projectRoot - Absolute path to the project root
 * @returns {{ registered: string[], skipped: string[] }}
 */
export function initProjectAgents(projectRoot) {
  const projectAgents = discoverProjectAgents(projectRoot);
  if (projectAgents.length === 0) return { registered: [], skipped: [] };
  const result = registerProjectAgents(AGENTS, projectAgents);
  if (result.registered.length > 0) {
    console.error(`[agent-registry] Registered project agents: ${result.registered.join(', ')}`);
  }
  return result;
}

/**
 * Get an agent factory by name.
 * @param {string} name
 * @returns {Function|null} Factory function or null if not found
 */
export function getAgent(name) {
  return AGENTS[name]?.factory || null;
}

/**
 * List all registered agent names.
 * @returns {string[]}
 */
export function listAgents() {
  return Object.keys(AGENTS);
}

/**
 * List agents with their source (core vs project).
 * @returns {Array<{ name: string, source: string, description: string }>}
 */
export function listAgentsWithSource() {
  return Object.entries(AGENTS).map(([name, config]) => ({
    name,
    source: config.source || 'core',
    description: config.description,
  }));
}

/**
 * Generate MCP tool definitions for all registered agents.
 * Returns both the generic rks_agent_run tool and per-agent convenience tools.
 * @returns {Array<object>} MCP tool definition objects
 */
export function generateAgentToolDefinitions() {
  const tools = [];

  // Generic agent runner tool
  tools.push({
    name: 'rks_agent_run',
    description: `Run a specialized agent in isolated server-side context. Available agents: ${listAgents().join(', ')}.`,
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: `Agent name. One of: ${listAgents().join(', ')}` },
        input: { type: 'object', description: 'Agent-specific input payload (varies by agent)' },
      },
      required: ['agent', 'input'],
    },
  });

  // Per-agent convenience tools
  for (const [name, config] of Object.entries(AGENTS)) {
    tools.push({
      name: config.toolName,
      description: config.description,
      inputSchema: zodToJsonSchema(config.inputSchema),
    });
  }

  return tools;
}

/**
 * Get agent config entry by MCP tool name (for per-agent convenience tools).
 * @param {string} toolName - e.g., "rks_agent_validate_story"
 * @returns {{ name: string, factory: Function } | null}
 */
export function getAgentByToolName(toolName) {
  for (const [name, config] of Object.entries(AGENTS)) {
    if (config.toolName === toolName) {
      return { name, factory: config.factory };
    }
  }
  return null;
}
