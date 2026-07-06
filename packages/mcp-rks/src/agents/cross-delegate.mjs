/**
 * Cross-Delegation Infrastructure
 *
 * Creates typed cross-delegation tools that let one agent call another
 * with built-in cost guardrails, telemetry, and error isolation.
 *
 * DAG enforcement is by construction — only specific tools exist,
 * no generic "delegate to any agent" capability.
 *
 * @see backlog.agents.agent-cross-delegation
 */

import { z } from 'zod';
import { runAgent } from './runner.mjs';
import { ensureTelemetryStorage } from '../server/telemetry/index.mjs';

const DEFAULT_MAX_CROSS_DELEGATIONS = 3;

/**
 * Create a cross-delegation tool for an agent.
 *
 * @param {object} opts
 * @param {string} opts.sourceAgent - Name of the calling agent (e.g., "product-owner")
 * @param {string} opts.targetAgent - Name of the target agent (e.g., "research")
 * @param {string} opts.toolName - Tool name exposed to the parent agent
 * @param {string} opts.description - Tool description
 * @param {import('zod').ZodType} opts.inputSchema - Input schema for the tool
 * @param {Function} opts.createTarget - Factory: (input) => agent config for runAgent()
 * @param {string} opts.projectId - Project identifier
 * @param {string} opts.projectRoot - Project root path
 * @param {object} [opts.counter] - Shared call counter (created if not provided)
 * @param {number} [opts.maxCalls] - Max cross-delegation calls per parent run
 * @returns {{ tool: object, counter: object }} Tool definition and shared counter
 */
export function createCrossDelegationTool(opts) {
  const {
    sourceAgent,
    targetAgent,
    toolName,
    description,
    inputSchema,
    createTarget,
    projectId,
    projectRoot,
    maxCalls = DEFAULT_MAX_CROSS_DELEGATIONS,
  } = opts;

  // Shared counter across all cross-delegation tools in one agent run
  const counter = opts.counter || { count: 0, max: maxCalls };

  const tool = {
    name: toolName,
    description,
    inputSchema,
    execute: async (input) => {
      // Check call limit
      if (counter.count >= counter.max) {
        return {
          ok: false,
          error: `Cross-delegation limit reached (${counter.count}/${counter.max}). Cannot call ${targetAgent}.`,
          hint: 'Reduce cross-delegation calls or increase maxCrossDelegations limit.',
        };
      }

      counter.count++;
      const startTime = Date.now();

      // Emit telemetry
      let collector;
      try {
        collector = projectRoot ? ensureTelemetryStorage(projectRoot) : { emit: () => {} };
      } catch { collector = { emit: () => {} }; }

      const emitTelemetry = (event, data) => {
        try {
          collector.emit(`agent.${sourceAgent}.cross_delegation.${event}`, projectId, {
            source: sourceAgent,
            target: targetAgent,
            callNumber: counter.count,
            ...data,
          });
        } catch { /* best-effort */ }
      };

      emitTelemetry('started', { toolName, input });

      try {
        // Create and run the target agent
        const targetConfig = createTarget(input);
        const result = await runAgent(targetConfig);
        const durationMs = Date.now() - startTime;

        emitTelemetry('complete', {
          durationMs,
          ok: result.ok,
          telemetryId: result.telemetryId,
        });

        return result;
      } catch (err) {
        const durationMs = Date.now() - startTime;

        emitTelemetry('failed', {
          durationMs,
          error: err.message,
        });

        return {
          ok: false,
          error: `Cross-delegation to ${targetAgent} failed: ${err.message}`,
        };
      }
    },
  };

  return { tool, counter };
}

/**
 * Create a shared counter for cross-delegation calls within one agent run.
 * Pass this to multiple createCrossDelegationTool calls to share a single limit.
 *
 * @param {number} [maxCalls] - Maximum total cross-delegation calls
 * @returns {{ count: number, max: number }}
 */
export function createDelegationCounter(maxCalls = DEFAULT_MAX_CROSS_DELEGATIONS) {
  return { count: 0, max: maxCalls };
}
