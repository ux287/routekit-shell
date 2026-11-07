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
 * The keys this schema declares. Derived from the schema itself, never restated — a second
 * hand-written list would be free to drift from the object above, which is the class of defect
 * this file's own fix is about.
 */
export const AGENT_DEFINITION_KEYS = Object.freeze(Object.keys(agentDefinitionSchema.shape));

/**
 * Validate an agent definition object against the schema.
 *
 * backlog.fix.agent-definition-unknown-keys-silently-dropped. A `z.object` STRIPS keys it does not
 * declare, and this schema carries no `.strict()`, so an author who wrote `"prompt": "..."` got
 * `ok: true` back and their key was gone. A success report on a definition that lost its payload —
 * a status not sourced from an observation of what actually survived.
 *
 * REPORTED, NOT REFUSED, and the distinction is deliberate. `registry.mjs` faces the same problem at
 * per-call dispatch and DOES refuse, because there a dropped key changes what work runs. Here the
 * definition is a startup registration: refusing would turn "registers minus a key" into "the agent
 * vanishes", for a mechanism that today has no working example anywhere to calibrate against. The
 * set-difference derivation is copied from that precedent; the verdict is not.
 *
 * `unknownKeys` is TOP-LEVEL ONLY. `guardrails` is `z.record(z.unknown())`, so arbitrary keys inside
 * it are the declared contract and reporting them would be noise, not a finding.
 *
 * @param {unknown} data - Raw parsed JSON from .rks/agents/<name>.json
 * @returns {{ ok: true, data: import('zod').infer<typeof agentDefinitionSchema>, unknownKeys: string[] } | { ok: false, errors: string[] }}
 */
export function validateAgentDefinition(data) {
  const result = agentDefinitionSchema.safeParse(data);
  if (!result.success) {
    return {
      ok: false,
      errors: result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`),
    };
  }
  const isPlainObject = data !== null && typeof data === 'object' && !Array.isArray(data);
  const unknownKeys = isPlainObject
    ? Object.keys(data).filter(k => !AGENT_DEFINITION_KEYS.includes(k)).sort()
    : [];
  // Always present, even when empty. A conditionally-attached field forces every caller to test for
  // presence before length, and an absent field reads the same as "nothing was dropped" whether or
  // not the check ran — the ambiguity this fix exists to remove.
  return { ok: true, data: result.data, unknownKeys };
}
