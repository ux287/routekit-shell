/**
 * Agent/bootstrap handler family (S9a of research.2026.10.05.server-mjs-safe-decomposition).
 *
 * Bodies moved verbatim from server.mjs. Handler contract: see ./registry.mjs. No body reads ctx.
 * The per-agent tools (getAgentByToolName) are resolved lazily by ./agent-tools.mjs (S10), which
 * reaches the IIFE's entry-transition revert only through the ctx.revertEntryTransition closure.
 */
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { runProjectInit } from "../../project-init.mjs";
import { hasGitRepo, getCurrentBranch, assertCleanWorkingTree } from "../exec.mjs";
import { loadContext } from "../project.mjs";
import { runOnboarder } from "../onboarder.mjs";
import { runAgent } from "../../agents/runner.mjs";
import { getAgent, listAgents, parseAgentInput } from "../../agents/registry.mjs";

export function registerAgentBootstrapHandlers({ registerHandler }, {
  rksInitSchema,
  projectInitSchema,
  onboarderSchema,
  interviewSchema,
}) {
  registerHandler("rks_init", async (cleanArgs, ctx) => {
    const input = rksInitSchema.parse(cleanArgs);
    const projectName = input.projectName;
    const parentDir = input.parentDir || "..";
    const dev = input.dev || false;
    const branchModel = input.branchModel || "3-branch";
    // dynamically import the init implementation to avoid circular deps / startup cost
    const { runInitTool } = await import('../init.mjs');
    const res = await runInitTool({ projectName, parentDir, dev, branchModel });
    // Auto-trigger the onboarder ONLY on a verified-successful init, using the authoritative
    // path runInitTool returned (res.path) — never a recomputed path.resolve(parentDir,
    // projectName), which reintroduced the wrong-root split-brain and echoed the wrong
    // project. On a failed init (res.success === false) we skip the onboarder entirely.
    if (res.success && res.path) {
      try {
        const onboardResult = await runOnboarder({ projectId: projectName, projectRoot: res.path, stage: "welcome" });
        res.onboarder = onboardResult;
      } catch {
        res.nextStep = { command: "/rks-onboard", reason: "first-run" };
      }
    }
    return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
  });

  registerHandler("rks_project_init", async (cleanArgs, ctx) => {
    const input = projectInitSchema.parse(cleanArgs);
    const context = await loadContext(input.projectId);
    const projectRoot = context.record.root;
    const baseBranch = context.projectJson?.baseBranch || "staging";
    if (hasGitRepo(projectRoot)) {
      assertCleanWorkingTree(projectRoot, { toolName: 'rks_project_init' });
      const currentBranch = getCurrentBranch(projectRoot);
      if (currentBranch !== baseBranch) {
        throw new McpError(
          ErrorCode.InvalidRequest,
          `rks.project_init: expected to run from base branch "${baseBranch}" but you're on "${currentBranch}".`
        );
      }
    }
    if (input.register && !input.apply) {
      throw new McpError(
        ErrorCode.InvalidParams,
        "rks.project_init: apply must be true when register is requested."
      );
    }

    const initResult = await runProjectInit({
      shellRoot: projectRoot,
      id: input.id,
      stackId: input.stack,
      targetPath: input.path,
      apply: Boolean(input.apply),
      register: Boolean(input.register),
    });

    const payload = {
      ok: true,
      applied: initResult.applied,
      project: initResult.project,
      registryRecord: initResult.registryRecord,
      message: initResult.message,
      instructions: [
        "Use rks_templates_list to discover stack ids before init.",
        `Run npm install inside ${initResult.project.root} once scaffolding completes.`,
      ],
    };

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(payload, null, 2),
        },
      ],
    };
  });

  registerHandler("rks_agent_external_research", async (cleanArgs, ctx) => {
    const { runExternalResearch } = await import('../../agents/external-research.mjs');
    const result = await runExternalResearch({ ...cleanArgs });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });

  registerHandler("rks_onboarder", async (cleanArgs, ctx) => {
    const input = onboarderSchema.parse(cleanArgs);
    const context = await loadContext(input.projectId);
    const projectRoot = context.record.root;
    const result = await runOnboarder({
      projectId: input.projectId,
      projectRoot,
      stage: input.stage,
      responses: input.responses || {},
      skipTour: input.skipTour || false,
      skipStage: input.skipStage || false,
      bounce: input.bounce || false,
      resume: input.resume || false,
      reset: input.reset || false,
    });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });

  registerHandler("rks_interview", async (cleanArgs, ctx) => {
    const input = interviewSchema.parse(cleanArgs);
    const context = await loadContext(input.projectId);
    const projectRoot = context.record.root;
    const DEPRECATION_WARNING =
      "⚠️ `rks_interview` is deprecated and will be removed in v0.21.0. Use `/rks-onboard` instead. Forwarding you to the new onboarding experience now.\n\n";
    const onboardResult = await runOnboarder({
      projectId: input.projectId,
      projectRoot,
      stage: "welcome",
    });
    const result = {
      ...onboardResult,
      display: DEPRECATION_WARNING + (onboardResult.display || ""),
    };
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });

  registerHandler("rks_agent_run", async (cleanArgs, ctx) => {
    const { agent: agentName, input: agentInput } = cleanArgs;
    const agentFactory = getAgent(agentName);
    if (!agentFactory) {
      return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: `Unknown agent: ${agentName}. Available: ${listAgents().join(", ")}` }, null, 2) }] };
    }
    // Reject unknown input keys BEFORE the factory runs — a silently-dropped key
    // turns a malformed call into a different, destructive one.
    const parsedInput = parseAgentInput(agentName, agentInput);
    if (!parsedInput.ok) {
      return { content: [{ type: "text", text: JSON.stringify(parsedInput.error, null, 2) }] };
    }
    const context = await loadContext(parsedInput.data.projectId);
    const config = agentFactory({ ...parsedInput.data, projectRoot: context.record.root });
    const result = await runAgent(config);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });
}
