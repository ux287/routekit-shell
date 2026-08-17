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
import { ensureTelemetryStorage } from '@routekit/telemetry';
import { loadContext } from '../server/project.mjs';
import { loadAgentConfig } from './config.mjs';
import { loadFetchMode, loadAllowedHosts, hostAllowed } from './fetch-raw.mjs';

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
  // OPTIONAL is structurally required, not merely backward-compatible: the zero-sources
  // early return below builds a result with no egress and parses it through this same
  // schema on a live production path. A required field would throw there.
  egress: z.object({
    mode: z.string(),
    fetchableCount: z.number(),
    deniedHosts: z.array(z.string()),
  }).optional(),
});

// --- Egress preflight ---

/**
 * Decide what this project's egress policy would do to the hosts a search returned, and
 * prepend a warning banner to the answer when any of them would be refused.
 *
 * PURE ON PURPOSE. No collector, no projectId, no telemetryId, no I/O, and it never
 * emits — telemetryId is minted inside runExternalResearch, so only the entry point can
 * own the emit. Purity is what makes every branch below assertable with no credential
 * and no network.
 *
 * This runs its OWN host check rather than fetching anything: the point is to tell a
 * human that the research was degraded, not to retrieve the documents.
 *
 * @param {object} args
 * @param {string} args.answer   The synthesized answer, returned unchanged when nothing is refused.
 * @param {Array<{url: string}>} args.sources
 * @param {string} args.mode     Egress posture: 'open' bypasses the host allowlist.
 * @param {string[]} args.allowedHosts
 * @returns {{ answer: string, egress: { mode: string, fetchableCount: number, deniedHosts: string[] } }}
 */
export function applyEgressWarning({ answer, sources, mode, allowedHosts }) {
  const original = typeof answer === 'string' ? answer : '';
  const list = Array.isArray(sources) ? sources : [];
  const posture = mode === 'open' ? 'open' : 'allowlist';

  // 'open' bypasses the host allowlist exactly as validateTarget does in fetch-raw.mjs.
  // A non-array allowedHosts means there is no policy to evaluate — never invent a denial
  // out of missing data. Production always passes an array: loadAllowedHosts() returns []
  // on a read failure, not undefined, and an empty list in allowlist mode genuinely does
  // deny everything, so that case still warns.
  const enforcing = posture === 'allowlist' && Array.isArray(allowedHosts);

  let fetchableCount = 0;
  const deniedHosts = [];
  const seen = new Set();

  for (const source of list) {
    let host;
    try {
      host = new URL(source?.url).hostname;
    } catch {
      continue; // unparseable — neither fetchable nor deniable; never throws
    }
    if (!enforcing || hostAllowed(host, allowedHosts)) {
      fetchableCount += 1;
      continue;
    }
    if (!seen.has(host)) {
      seen.add(host);
      deniedHosts.push(host);
    }
  }

  const egress = { mode: posture, fetchableCount, deniedHosts };
  if (deniedHosts.length === 0) return { answer: original, egress };

  const named = deniedHosts.join(', ');
  const banner = fetchableCount === 0
    ? `> ⚠️ **Egress notice** — every source host was refused by this project's egress ` +
      `policy (\`fetchRaw.allowedHosts\` in \`.rks/project.json\`): ${named}.\n` +
      `> This answer is built from search snippets only, because raw document fetching ` +
      `was refused. Add those hosts to the allowlist if you want their full content used.`
    : `> ⚠️ **Egress notice** — ${deniedHosts.length} of ${list.length} source host(s) ` +
      `were refused by this project's egress policy (\`fetchRaw.allowedHosts\` in ` +
      `\`.rks/project.json\`): ${named}.\n` +
      `> The analysis below draws only on the sources that were permitted.`;

  // PREPENDED, not appended — a warning below a 2000-word answer is a warning nobody reads.
  return { answer: `${banner}\n\n${original}`, egress };
}

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

// --- Default dependencies ---
//
// Each credential guard lives INSIDE the dep it guards, never on the outer path ahead of
// the injection point. That placement is the whole point of the seam: a guard left
// outside would throw before an injected dep could ever run, and the degraded-egress
// behaviour below would be untestable without a real API key.

/** Default search: reads the Brave key and dispatches to the provider registry. */
async function defaultSearchFn({ query, maxSources, provider }) {
  const apiKey = process.env.BRAVE_SEARCH_API_KEY;
  if (!apiKey) {
    throw new Error('No BRAVE_SEARCH_API_KEY configured. Set in environment or .env file.');
  }
  const search = SEARCH_PROVIDERS[provider];
  return search({ query, maxSources, apiKey });
}

/** Default synthesis: reads the Anthropic key and calls the model. */
async function defaultSynthesizeFn({ query, sources, projectRoot }) {
  const env = loadEnv();
  if (!env.anthropicKey) {
    throw new Error('No ANTHROPIC_API_KEY configured for synthesis.');
  }

  const client = createAnthropicClient({ ...env, provider: 'anthropic' });
  // Centralized model selection (Finding 5): env (RKS_RESEARCH_MODEL) > agents.yaml
  // > DEFAULTS, via loadAgentConfig('research') — no hardcoded/decommissioned fallback.
  const model = loadAgentConfig('research', projectRoot).model;
  const prompt = buildSynthesisPrompt({ query, sources });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_LLM_TIMEOUT_MS);

  try {
    const answer = await callAnthropicChat({ client, model, prompt, signal: controller.signal });
    clearTimeout(timeout);
    return answer;
  } catch (err) {
    clearTimeout(timeout);
    throw new Error(`Synthesis LLM call failed: ${err.message}`);
  }
}

// --- Main Entry Point ---

/**
 * @param {object} rawInput
 * @param {object} [deps] Overridable seams, each defaulting to production behaviour.
 *   `collector` replaces the telemetry collector, `searchFn` the web search, and
 *   `synthesizeFn` the LLM call. Widening this signature is non-breaking — every caller
 *   passes exactly one argument.
 */
export async function runExternalResearch(rawInput, deps = {}) {
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
  if (deps.collector) collector = deps.collector;

  const searchFn = deps.searchFn || defaultSearchFn;
  const synthesizeFn = deps.synthesizeFn || defaultSynthesizeFn;

  collector.emit('agent.external-research.started', input.projectId, {
    telemetryId,
    query: input.query,
    provider: input.provider,
    maxSources: input.maxSources,
  });

  try {
    // 1. Search
    const sources = await searchFn({
      query: input.query,
      maxSources: input.maxSources,
      provider: input.provider,
    });

    if (sources.length === 0) {
      const result = { ok: true, answer: 'No results found for the query.', sources: [], telemetryId };
      collector.emit('agent.external-research.complete', input.projectId, { telemetryId, sourceCount: 0 });
      return ExternalResearchOutputSchema.parse(result);
    }

    // 2. Synthesize via LLM
    const synthesized = await synthesizeFn({ query: input.query, sources, projectRoot });

    // 3. Egress preflight — tell the reader if this project's policy refused the sources.
    const { answer, egress } = applyEgressWarning({
      answer: synthesized,
      sources,
      mode: loadFetchMode(projectRoot),
      allowedHosts: loadAllowedHosts(projectRoot),
    });

    // 4. Validate and return
    const result = ExternalResearchOutputSchema.parse({
      ok: true,
      answer,
      sources,
      telemetryId,
      egress,
    });

    // The entry point owns the emit — the helper is pure and has no telemetryId.
    if (egress.deniedHosts.length > 0) {
      collector.emit('agent.external-research.degraded', input.projectId, {
        telemetryId,
        mode: egress.mode,
        deniedHostCount: egress.deniedHosts.length,
        deniedHosts: egress.deniedHosts,
      });
    }

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
