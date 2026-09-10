/**
 * Agent Discovery
 *
 * Reads project-specific agent definitions from .rks/agents/*.json
 * and registers them alongside core agents in the registry.
 *
 * Discovery happens at MCP server startup. Invalid definitions are
 * skipped with warnings — they don't block startup.
 */

import fs from 'fs';
import path from 'path';
import { validateAgentDefinition } from '../shared/agent-schema.mjs';

/**
 * Discover project-specific agent definitions from .rks/agents/.
 * @param {string} projectRoot - Absolute path to the project root
 * @returns {Array<{ name: string, definition: object }>} Valid agent definitions
 */
export function discoverProjectAgents(projectRoot) {
  const agentsDir = path.join(projectRoot, '.rks', 'agents');

  if (!fs.existsSync(agentsDir)) {
    return [];
  }

  const files = fs.readdirSync(agentsDir).filter(f => f.endsWith('.json'));
  const agents = [];

  for (const file of files) {
    const filePath = path.join(agentsDir, file);
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      const validation = validateAgentDefinition(parsed);

      if (!validation.ok) {
        console.warn(`[agent-discovery] Skipping invalid agent ${file}: ${validation.errors.join(', ')}`);
        continue;
      }

      agents.push({ name: validation.data.name, definition: validation.data });
    } catch (err) {
      console.warn(`[agent-discovery] Skipping ${file}: ${err.message}`);
    }
  }

  return agents;
}

/**
 * Register discovered project agents into the agent registry.
 * Core agents take precedence — project agents with colliding names are skipped.
 *
 * @param {object} registry - The AGENTS registry object from registry.mjs
 * @param {Array<{ name: string, definition: object }>} projectAgents - From discoverProjectAgents()
 * @returns {{ registered: string[], skipped: string[] }}
 */
export function registerProjectAgents(registry, projectAgents) {
  const registered = [];
  const skipped = [];

  for (const { name, definition } of projectAgents) {
    if (registry[name]) {
      console.warn(`[agent-discovery] Skipping project agent '${name}' — collides with core agent`);
      skipped.push(name);
      continue;
    }

    registry[name] = {
      factory: createProjectAgentFactory(definition),
      inputSchema: null, // Project agents use generic input
      description: definition.description,
      toolName: `rks_agent_${name.replace(/-/g, '_')}`,
      source: 'project',
      definition,
    };
    registered.push(name);
  }

  return { registered, skipped };
}

/**
 * Create a factory function for a project-specific agent.
 * The factory returns an agent config compatible with runAgent().
 *
 * @param {object} definition - Validated agent definition
 * @returns {Function} Agent factory function
 */
function createProjectAgentFactory(definition) {
  return (input) => ({
    name: definition.name,
    description: definition.description,
    projectId: input.projectId,
    projectRoot: input.projectRoot,
    request: input.request || input.command || '',
    allowedTools: definition.allowedTools || [],
    telemetryEvents: definition.telemetryEvents || [],
    guardrails: definition.guardrails || {},
    validationHooks: definition.validationHooks || {},
    source: 'project',
  });
}
