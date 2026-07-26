/**
 * Product Owner Agent
 *
 * Validates story readiness with quality/completeness scoring,
 * RAG benchmarking against similar stories, and gap detection.
 *
 * Tools (server-side, no hooks):
 * - validate_story: runs story-validator-v2
 * - rag_query: queries RAG index for similar stories
 */

import { z } from 'zod';
import { validateStory } from '../server/story-validator-v2.mjs';
import { runRagQuery } from '../rag/index.mjs';
import { loadAgentConfig } from './config.mjs';
import { createResearchAgent } from './research.mjs';
import { createCrossDelegationTool, createDelegationCounter } from './cross-delegate.mjs';

// --- Input Contract ---
export const ProductOwnerInputSchema = z.object({
  projectId: z.string(),
  problemId: z.string(),
});

// --- Output Contract ---
export const ProductOwnerOutputSchema = z.object({
  ok: z.boolean(),
  verdict: z.enum(['ready', 'not-ready', 'needs-refinement']),
  quality: z.number().min(0).max(1),
  completeness: z.number().min(0).max(1),
  gaps: z.array(z.union([z.string(), z.object({ field: z.string(), status: z.string(), priority: z.string() }).passthrough()])),
  recommendations: z.array(z.string()),
  sources: z.array(z.string()),
});

// --- System Prompt ---
const PO_SYSTEM_PROMPT = `You are a Product Owner Agent. Your job is to validate story readiness before planning.

You have three tools:
1. validate_story — runs structured validation with quality/completeness scoring
2. rag_query — searches the knowledge base for similar implemented stories
3. research_codebase — queries the Research Agent for codebase context (architecture, file locations, patterns)

WORKFLOW:
1. Call validate_story with the given projectId and problemId
2. Review the validation results (quality score, completeness score, gaps)
3. Optionally call rag_query to find similar stories for benchmarking
4. If assessing feasibility or verifying targetFiles, call research_codebase to get architecture context
5. Return your verdict as a JSON object

VERDICT CRITERIA:
- "ready": quality >= 0.7 AND completeness >= 0.7 AND no critical gaps
- "needs-refinement": quality or completeness between 0.4-0.7, or minor gaps
- "not-ready": quality or completeness < 0.4, or critical gaps (missing Problem section, no acceptance criteria, no targetFiles)

RESPOND WITH ONLY a JSON object matching this schema:
{
  "ok": true,
  "verdict": "ready" | "not-ready" | "needs-refinement",
  "quality": 0.0-1.0,
  "completeness": 0.0-1.0,
  "gaps": ["list of identified gaps"],
  "recommendations": ["actionable suggestions to improve the story"],
  "sources": ["files or stories referenced during analysis"]
}`;

/**
 * Create the Product Owner agent configuration.
 * @param {object} params
 * @param {string} params.projectId
 * @param {string} params.problemId
 * @param {string} params.projectRoot
 */
export function createProductOwnerAgent({ projectId, problemId, projectRoot }) {
  const cfg = loadAgentConfig('product-owner', projectRoot);
  const delegationCounter = createDelegationCounter(3);

  const { tool: researchTool } = createCrossDelegationTool({
    sourceAgent: 'product-owner',
    targetAgent: 'research',
    toolName: 'research_codebase',
    description: 'Query the Research Agent for codebase context — architecture patterns, file locations, implementation details. Use when assessing story feasibility or verifying targetFiles.',
    inputSchema: z.object({
      query: z.string().describe('Research question about the codebase'),
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

  return {
    name: 'product-owner',
    model: cfg.model,
    prompt: cfg.prompt || PO_SYSTEM_PROMPT,
    userMessage: `Validate story "${problemId}" for project "${projectId}". Call validate_story first, then optionally rag_query for benchmarking. If you need codebase context for feasibility assessment, use research_codebase. Return your structured verdict.`,
    inputSchema: ProductOwnerInputSchema,
    outputSchema: ProductOwnerOutputSchema,
    rawInput: { projectId, problemId },
    maxTurns: cfg.maxTurns,
    timeoutMs: cfg.timeoutMs,
    projectId,
    projectRoot,
    tools: [
      {
        name: 'validate_story',
        description: 'Run story validation with quality/completeness scoring. Returns structured results with scores, gaps, and field-level analysis.',
        inputSchema: z.object({
          projectId: z.string().describe('Project identifier'),
          problemId: z.string().describe('Backlog item ID to validate'),
        }),
        execute: async (input) => {
          return validateStory({ projectId: input.projectId, problemId: input.problemId, projectRoot });
        },
      },
      {
        name: 'rag_query',
        description: 'Query the RAG index for similar stories or documentation. Useful for benchmarking story quality against implemented stories.',
        inputSchema: z.object({
          q: z.string().describe('Search query'),
          k: z.number().optional().describe('Number of results (default 5)'),
        }),
        execute: async (input) => {
          return runRagQuery(projectRoot, { q: input.q, k: input.k || 5 });
        },
      },
      researchTool,
    ],
  };
}
