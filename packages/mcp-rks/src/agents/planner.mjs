/**
 * Planner Agent
 *
 * Tier 2 Utility agent — designs implementation plans for stories.
 * Uses cross-delegation to call Research Agent for architecture context
 * and PO Agent for story readiness checks.
 *
 * Tools (direct + cross-delegation):
 * - read_file: read a specific file for implementation context
 * - rag_query: search the knowledge base for patterns and prior art
 * - research_architecture: cross-delegates to Research Agent for deep codebase questions
 * - check_story_readiness: cross-delegates to PO Agent for story validation
 *
 * @see backlog.agents.agent-cross-delegation
 */

import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { runRagQuery } from '../rag/index.mjs';
import { loadAgentConfig } from './config.mjs';
import { createResearchAgent } from './research.mjs';
import { createProductOwnerAgent } from './product-owner.mjs';
import { createCrossDelegationTool, createDelegationCounter } from './cross-delegate.mjs';

// --- Input Contract ---
export const PlannerInputSchema = z.object({
  projectId: z.string(),
  storyId: z.string().optional().describe('Backlog story ID to plan'),
  problemId: z.string().optional().describe('Alias for storyId (used by MCP tool routing)'),
  task: z.string().optional().describe('Ad-hoc task description (alternative to storyId)'),
  constraints: z.string().optional().describe('Additional constraints or preferences for the plan'),
}).refine(d => d.storyId || d.problemId || d.task, {
  message: 'One of storyId, problemId, or task is required',
});

// --- Output Contract ---
export const PlannerOutputSchema = z.object({
  ok: z.boolean(),
  plan: z.object({
    storyId: z.string().nullable().optional(),
    phases: z.array(z.object({
      name: z.string(),
      description: z.string(),
      files: z.array(z.string()).optional(),
      dependencies: z.array(z.string()).optional(),
    })),
    targetFiles: z.array(z.string()),
    estimatedComplexity: z.enum(['low', 'medium', 'high']),
    risks: z.array(z.string()).optional(),
    recommendations: z.array(z.string()).optional(),
  }),
  storyReadiness: z.object({
    verdict: z.string().optional(),
    quality: z.number().optional(),
  }).optional(),
});

// --- System Prompt ---
const PLANNER_SYSTEM_PROMPT = `You are a Planner Agent. Your job is to design implementation plans for backlog stories.

You have five tools:
1. rag_query — search the knowledge base for relevant code, patterns, and prior art
2. read_file — read a specific file to understand current implementation
3. write_plan — persist the implementation plan to disk so it can be executed by rks_exec
4. research_architecture — ask the Research Agent deep questions about codebase architecture, patterns, and design decisions
5. check_story_readiness — ask the Product Owner Agent to validate story quality and readiness

WORKFLOW:
1. Call rag_query to find the story note and understand requirements
2. Call rag_query or research_architecture to understand existing patterns and architecture
3. Optionally call check_story_readiness if you're unsure the story is well-defined
4. Read key files identified by RAG or Research to understand current implementation
5. Design a phased implementation plan with clear deliverables
6. Call write_plan to persist the plan to .rks/runs/
7. Return a structured plan as JSON

GUIDELINES:
- Start with RAG for fast discovery, escalate to research_architecture for deeper questions
- Use check_story_readiness sparingly — only when gaps or ambiguity in requirements
- Break plans into 2-5 phases with clear boundaries
- Identify target files that will be created or modified
- Note risks and dependencies between phases
- Prefer incremental changes over large rewrites

HARD LIMITS:
- Maximum 2 research_architecture calls
- Maximum 1 check_story_readiness call
- Maximum 2 rag_query calls
- Maximum 3 read_file calls
- Maximum 1 write_plan call (call once after designing the plan)
- After hitting limits, work with what you have

RESPOND WITH ONLY a JSON object matching this schema:
{
  "ok": true,
  "plan": {
    "storyId": "backlog.example",
    "phases": [
      { "name": "Phase name", "description": "What to do", "files": ["path/to/file.mjs"], "dependencies": [] }
    ],
    "targetFiles": ["list of all files to create or modify"],
    "estimatedComplexity": "low" | "medium" | "high",
    "risks": ["potential issues"],
    "recommendations": ["suggestions for implementation"]
  },
  "storyReadiness": { "verdict": "ready", "quality": 0.85 }
}`;

/**
 * Create a Planner Agent configuration.
 *
 * @param {{ projectId: string, storyId?: string, problemId?: string, task?: string, constraints?: string, projectRoot: string }} params
 * @returns {object} Agent config for runAgent()
 */
export function createPlannerAgent({ projectId, storyId, problemId, task, constraints, projectRoot }) {
  // Resolve storyId from either field
  storyId = storyId || problemId;
  const cfg = loadAgentConfig('planner', projectRoot);
  const delegationCounter = createDelegationCounter(3);

  // Cross-delegation: Research Agent for architecture questions
  const { tool: researchTool } = createCrossDelegationTool({
    sourceAgent: 'planner',
    targetAgent: 'research',
    toolName: 'research_architecture',
    description: 'Ask the Research Agent a deep question about codebase architecture, design patterns, or implementation details. Use for questions that need file reading and analysis beyond RAG.',
    inputSchema: z.object({
      query: z.string().describe('Architecture or implementation question'),
    }),
    createTarget: (input) => createResearchAgent({
      projectId,
      query: input.query,
      scope: 'code',
      projectRoot,
    }),
    projectId,
    projectRoot,
    counter: delegationCounter,
  });

  // Cross-delegation: PO Agent for story readiness check
  const { tool: poTool } = createCrossDelegationTool({
    sourceAgent: 'planner',
    targetAgent: 'product-owner',
    toolName: 'check_story_readiness',
    description: 'Ask the Product Owner Agent to validate story quality and readiness. Use when you suspect the story has gaps or unclear requirements.',
    inputSchema: z.object({
      problemId: z.string().describe('Story ID to validate'),
    }),
    createTarget: (input) => createProductOwnerAgent({
      projectId,
      problemId: input.problemId,
      projectRoot,
    }),
    projectId,
    projectRoot,
    counter: delegationCounter,
  });

  const constraintHint = constraints ? `\nAdditional constraints: ${constraints}` : '';

  return {
    name: 'planner',
    model: cfg.model,
    fallbackModel: cfg.fallbackModel,
    prompt: cfg.prompt || PLANNER_SYSTEM_PROMPT,
    userMessage: storyId
      ? `Design an implementation plan for story "${storyId}" in project "${projectId}".${constraintHint}\n\nStart by querying RAG for the story note and relevant architecture, then design a phased plan.`
      : `Design an implementation plan for this task in project "${projectId}": ${task}${constraintHint}\n\nStart by querying RAG for relevant architecture, then design a phased plan.`,
    inputSchema: PlannerInputSchema,
    outputSchema: PlannerOutputSchema,
    rawInput: { projectId, storyId, problemId, task, constraints },
    maxTurns: cfg.maxTurns,
    timeoutMs: cfg.timeoutMs,
    projectId,
    projectRoot,
    tools: [
      // Direct tools (fast, no sub-agent overhead)
      {
        name: 'rag_query',
        description: 'Search the RAG index for code, documentation, stories, or patterns. Fast discovery tool — start here.',
        inputSchema: z.object({
          q: z.string().describe('Search query'),
          k: z.number().optional().describe('Number of results (default 5)'),
        }),
        execute: async (input) => {
          return runRagQuery(projectRoot, { q: input.q, k: input.k || 5 });
        },
      },
      {
        name: 'read_file',
        description: 'Read a specific file to understand current implementation. Use after RAG identifies relevant files.',
        inputSchema: z.object({
          path: z.string().describe('Relative file path from project root'),
          offset: z.number().optional().describe('Start line (0-indexed, default 0)'),
          limit: z.number().optional().describe('Max lines to read (default 200)'),
        }),
        execute: async (input) => {
          const filePath = path.resolve(projectRoot, input.path);
          if (!filePath.startsWith(projectRoot)) {
            return { error: 'Path traversal blocked — must be within project root' };
          }
          if (!fs.existsSync(filePath)) {
            return { error: `File not found: ${input.path}` };
          }
          const content = fs.readFileSync(filePath, 'utf8');
          const lines = content.split('\n');
          const offset = input.offset || 0;
          const limit = input.limit || 200;
          const slice = lines.slice(offset, offset + limit);
          return {
            path: input.path,
            totalLines: lines.length,
            offset,
            limit,
            content: slice.join('\n'),
          };
        },
      },


      // Persist plan to disk (bridges to MCP planner)
      {
        name: 'write_plan',
        description: 'Create and persist an implementation plan to .rks/runs/. Call once after research is complete and you have designed the plan.',
        inputSchema: z.object({}),
        execute: async () => {
          try {
            const { runPlanTool } = await import('../server/planner.mjs');
            return await runPlanTool({ projectId, problemId: storyId });
          } catch (err) {
            return { ok: false, error: err.message };
          }
        },
      },

      // Cross-delegation tools (invoke sub-agents)
      researchTool,
      poTool,
    ],
  };
}
