/**
 * External Research Agent
 *
 * Web search + LLM synthesis for competitive analysis, market research,
 * and documentation lookups. First agent in the agents-are-coming epic.
 *
 * Architecture: AD #2 (MCP tool wrapping agent logic),
 *               AD #3 (contract enforcement via Zod),
 *               AD #5 (structured failure + telemetry)
 */

import crypto from 'crypto';
import { z } from 'zod';
import { loadEnv, createAnthropicClient, callAnthropicChat, DEFAULT_LLM_TIMEOUT_MS } from '../llm/clients.mjs';
import { ensureTelemetryStorage } from '../server/telemetry/index.mjs';
import { loadContext } from '../server/project.mjs';
import { loadAgentConfig } from './config.mjs';

// --- Input Contract ---
export const ExternalResearchInputSchema = z.object({
  projectId: z.string(),
  query: z.string().min(5, 'Query must be at least 5 characters'),
  maxSources: z.number().int().min(1).max(20).default(10),
  provider: z.enum(['brave']).default('brave'),
});

// --- Output Contract ---
export const ExternalResearchOutputSchema = z.object({
  ok: z.boolean(),
  answer: z.string(),
  sources: z.array(z.object({
    title: z.string(),
    url: z.string().url(),
    snippet: z.string(),
  })),
  telemetryId: z.string(),
  error: z.string().optional(),
});

// --- Search Providers ---

async function searchBrave({ query, maxSources, apiKey }) {
  const url = new URL('https://api.search.brave.com/res/v1/web/search');
  url.searchParams.set('q', query);
  url.searchParams.set('count', String(maxSources));

  const response = await fetch(url.toString(), {
    headers: {
      'Accept': 'application/json',
      'Accept-Encoding': 'gzip',
      'X-Subscription-Token': apiKey,
    },
  });

  if (!response.ok) {
    throw new Error(`Brave Search API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  return (data.web?.results || []).map(r => ({
    title: r.title || '',
    url: r.url || '',
    snippet: r.description || '',
  }));
}

/** Provider registry — add new providers here (Context7, Tavily, etc.) */
const SEARCH_PROVIDERS = {
  brave: searchBrave,
};

// --- Synthesis ---

function buildSynthesisPrompt({ query, sources }) {
  return `You are a research analyst. Synthesize the following web search results into a structured analysis.

## Query
${query}

## Search Results
${sources.map((s, i) => `### ${i + 1}. ${s.title}\nURL: ${s.url}\n${s.snippet}`).join('\n\n')}

## Instructions
- Provide a comprehensive answer based on these search results
- Use bullet points for clarity
- Include specific data points, pricing, and names when available
- Cite sources by referencing their titles
- If the results don't adequately answer the query, say what's missing
- Keep the answer focused and under 2000 words

Respond with your analysis only. No preamble.`;
}

// --- Main Entry Point ---

export async function runExternalResearch(rawInput) {
  const input = ExternalResearchInputSchema.parse(rawInput);
  const telemetryId = crypto.randomUUID();

  let collector;
  let projectRoot = process.cwd();
  try {
    const context = await loadContext(input.projectId);
    projectRoot = context.record.root;
    collector = ensureTelemetryStorage(context.record.root);
  } catch {
    collector = { emit: () => {} };
  }

  collector.emit('agent.external-research.started', input.projectId, {
    telemetryId,
    query: input.query,
    provider: input.provider,
    maxSources: input.maxSources,
  });

  try {
    // 1. Search
    const apiKey = process.env.BRAVE_SEARCH_API_KEY;
    if (!apiKey) {
      throw new Error('No BRAVE_SEARCH_API_KEY configured. Set in environment or .env file.');
    }

    const searchFn = SEARCH_PROVIDERS[input.provider];
    const sources = await searchFn({
      query: input.query,
      maxSources: input.maxSources,
      apiKey,
    });

    if (sources.length === 0) {
      const result = { ok: true, answer: 'No results found for the query.', sources: [], telemetryId };
      collector.emit('agent.external-research.complete', input.projectId, { telemetryId, sourceCount: 0 });
      return ExternalResearchOutputSchema.parse(result);
    }

    // 2. Synthesize via LLM
    const env = loadEnv();
    if (!env.anthropicKey) {
      throw new Error('No ANTHROPIC_API_KEY configured for synthesis.');
    }

    const client = createAnthropicClient({ ...env, provider: 'anthropic' });
    // Centralized model selection (Finding 5): env (RKS_RESEARCH_MODEL) > agents.yaml
    // > DEFAULTS, via loadAgentConfig('research') — no hardcoded/decommissioned fallback.
    const model = loadAgentConfig('research', projectRoot).model;
    const prompt = buildSynthesisPrompt({ query: input.query, sources });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DEFAULT_LLM_TIMEOUT_MS);

    let answer;
    try {
      answer = await callAnthropicChat({ client, model, prompt, signal: controller.signal });
      clearTimeout(timeout);
    } catch (err) {
      clearTimeout(timeout);
      throw new Error(`Synthesis LLM call failed: ${err.message}`);
    }

    // 3. Validate and return
    const result = ExternalResearchOutputSchema.parse({
      ok: true,
      answer,
      sources,
      telemetryId,
    });

    collector.emit('agent.external-research.complete', input.projectId, {
      telemetryId,
      sourceCount: sources.length,
      answerLength: answer.length,
    });

    return result;

  } catch (err) {
    collector.emit('agent.external-research.failed', input.projectId, {
      telemetryId,
      error: err.message,
    });

    // Structured failure per AD #5 — never throw
    return {
      ok: false,
      answer: '',
      sources: [],
      telemetryId,
      error: err.message,
    };
  }
}
