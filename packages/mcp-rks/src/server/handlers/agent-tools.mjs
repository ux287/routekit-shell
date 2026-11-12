/**
 * Per-agent tool handler family (S10 of research.2026.10.05.server-mjs-safe-decomposition).
 *
 * The rks_agent_* convenience tools are resolved LAZILY per call through the registry resolver,
 * because initProjectAgents() adds project agents after createServer() has built the registry.
 * Body moved verbatim from the server.mjs per-agent fallthrough. Handler contract: see ./registry.mjs.
 * Reads ctx.tool and ctx.revertEntryTransition (the entry-transition revert itself stays in server.mjs).
 */
import { getTelemetryCollector } from "@routekit/telemetry/collector";
import { loadContext } from "../project.mjs";
import { runAgent } from "../../agents/runner.mjs";
import { shouldEmitResearchFailureEvent } from "../../agents/research.mjs";
import { getAgentByToolName, parseAgentInput } from "../../agents/registry.mjs";

export function registerAgentToolHandlers(registry) {
  registry.registerResolver((toolName) => {
    const agentEntry = getAgentByToolName(toolName);
    if (!agentEntry) return null;
    return async (cleanArgs, ctx) => {
      const tool = ctx.tool;
      // Same gate as the generic path above — strictness must not be enforceable on
      // only one of the two dispatch routes.
      const parsedConv = parseAgentInput(agentEntry.name, cleanArgs);
      if (!parsedConv.ok) {
        return { content: [{ type: "text", text: JSON.stringify(parsedConv.error, null, 2) }] };
      }
      const context = await loadContext(parsedConv.data.projectId);
      const config = agentEntry.factory({ ...parsedConv.data, projectRoot: context.record.root });
      const result = await runAgent(config);
      // backlog.fix.governor-phase-state-desync-and-recovery
      //
      // An agent that fails returns a PAYLOAD rather than throwing — "Agent exceeded max
      // turns (7)" arrives here as data, so the outer catch never sees it. This is the exact
      // path that produced the observed wedge: the entry transition had already demoted
      // `planned` -> `refining`, and nothing gave it back. Reverting here makes the two
      // failure shapes — thrown and returned — behave identically for the chain.
      // `failureCategory` is deliberately NOT a rollback trigger. It is declared on an
      // `ok: true` result in agents/research.mjs and carries diagnostic values such as
      // `partial_answer`, so treating its presence as failure reverts the chain on a call
      // that succeeded. `ok === false` and `status === 'failed'` are the failure signals.
      if (result?.ok === false || result?.status === 'failed') {
        try {
          ctx.revertEntryTransition();
        } catch { /* rollback is best-effort */ }
      }
      // backlog.fix.research-agent-output-contract — failures only: no_results / thin_results
      // are returned to the caller but not emitted (routine no-hit runs must not flood telemetry).
      if (tool === 'rks_agent_research' && shouldEmitResearchFailureEvent(result?.failureCategory)) {
        try {
          getTelemetryCollector().emit(`agent.research.${result.failureCategory}`, cleanArgs.projectId || 'unknown', {
            failureCategory: result.failureCategory,
            confidence: result.confidence,
            telemetryId: result.telemetryId,
          });
        } catch { /* best-effort */ }
      }
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    };
  });
}
