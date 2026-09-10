import { z } from 'zod';

/**
 * Schema for project-specific agent definitions (.rks/agents/<name>.json).
 *
 * Projects register custom agents by placing JSON files in .rks/agents/.
 * Each file declares an agent's identity, capabilities, telemetry events,
 * guardrails, and validation hooks. The MCP server discovers and validates
 * these at startup.
 */

const telemetryEventSchema = z.object({
  name: z.string().describe('Event name, e.g. trade.entry, balance.check'),
  fields: z.array(z.string()).describe('Required fields in the event payload'),
});

const validationHooksSchema = z.object({
  pre: z.string().optional().describe('Validation to run before agent execution'),
  post: z.string().optional().describe('Validation to run after agent execution'),
});

export const agentDefinitionSchema = z.object({
  name: z.string().describe('Unique agent name, e.g. trading-ops'),
  description: z.string().describe('What this agent does — shown in discovery and skill routing'),
  allowedTools: z.array(z.string()).optional().describe('MCP tools this agent may call'),
  telemetryEvents: z.array(telemetryEventSchema).optional().describe('Structured telemetry events this agent emits'),
  guardrails: z.record(z.unknown()).optional().describe('Project-specific guardrail config (arbitrary key/value)'),
  validationHooks: validationHooksSchema.optional().describe('Pre/post execution validation'),
});

/**
 * Validate an agent definition object against the schema.
 * @param {unknown} data - Raw parsed JSON from .rks/agents/<name>.json
 * @returns {{ ok: true, data: import('zod').infer<typeof agentDefinitionSchema> } | { ok: false, errors: string[] }}
 */
export function validateAgentDefinition(data) {
  const result = agentDefinitionSchema.safeParse(data);
  if (result.success) {
    return { ok: true, data: result.data };
  }
  return {
    ok: false,
    errors: result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`),
  };
}
