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
import { loadEnv, DEFAULT_LLM_TIMEOUT_MS } from '../llm/clients.mjs';
import { resolveBackend } from '../llm/backend.mjs';
import { SUBSCRIPTION_REFUSAL_REASON } from '../llm/claude-cli/subscription-status.mjs';
import { ensureTelemetryStorage } from '@routekit/telemetry';
import { loadContext } from '../server/project.mjs';
import { loadAgentConfig } from './config.mjs';
import { loadFetchMode, loadAllowedHosts, hostAllowed } from './fetch-raw.mjs';
import { normalizeFetchUrl } from '../shared/fetch-provenance.mjs';

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
    // Denied SOURCES, counted separately from distinct denied HOSTS so the banner's
    // "D of M" shares one unit. Optional: additive to an existing contract.
    deniedSourceCount: z.number().optional(),
    // How the fetchable sources would be admitted by rks_fetch_raw: the static allowlist or
    // session provenance (backlog.feat.fetch-raw-url-provenance-allow). Present only when the
    // run observed a non-empty persisted provenance set. Optional: additive.
    fetchableBy: z.object({
      allowlist: z.number(),
      provenance: z.number(),
    }).optional(),
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
 * human what rks_fetch_raw would refuse, not to retrieve the documents. Nothing here is
 * refused and nothing is filtered: runExternalResearch fetches no pages and synthesis
 * receives every source, so the banner states only what was observed.
 *
 * @param {object} args
 * @param {string} args.answer   The synthesized answer, returned unchanged when nothing is refused.
 * @param {Array<{url: string}>} args.sources
 * @param {string} args.mode     Egress posture: 'open' bypasses the host allowlist.
 * @param {string[]} args.allowedHosts
 * @param {Iterable<string>} [args.provenanceUrls] The normalized URLs the run OBSERVED persisted to
 *   this session's provenance file (the recorder's read-back, never its intent). In allowlist mode
 *   a non-allowlisted source whose normalized URL is in this set is provenance-fetchable, so it is
 *   not reported as refused. Absent or empty: output identical to the allowlist-only preflight,
 *   with no fetchableBy split.
 * @returns {{ answer: string, egress: { mode: string, fetchableCount: number, deniedHosts: string[], deniedSourceCount: number, fetchableBy?: { allowlist: number, provenance: number } } }}
 */
export function applyEgressWarning({ answer, sources, mode, allowedHosts, provenanceUrls }) {
  const original = typeof answer === 'string' ? answer : '';
  const list = Array.isArray(sources) ? sources : [];
  const posture = mode === 'open' ? 'open' : 'allowlist';
  let provenance = null;
  try {
    if (provenanceUrls && typeof provenanceUrls !== 'string' && typeof provenanceUrls[Symbol.iterator] === 'function') {
      const set = new Set([...provenanceUrls].filter((u) => typeof u === 'string'));
      if (set.size > 0) provenance = set;
    }
  } catch {
    provenance = null; // never throws on degenerate input
  }

  // 'open' bypasses the host allowlist exactly as validateTarget does in fetch-raw.mjs.
  // A non-array allowedHosts means there is no policy to evaluate — never invent a denial
  // out of missing data. Production always passes an array: loadAllowedHosts() returns []
  // on a read failure, not undefined, and an empty list in allowlist mode genuinely does
  // deny everything, so that case still warns.
  const enforcing = posture === 'allowlist' && Array.isArray(allowedHosts);

  let fetchableCount = 0;
  let provenanceCount = 0;
  let deniedSourceCount = 0;
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
    // Provenance: only a URL the recorder observed persisted, matched exactly after normalization.
    if (provenance) {
      const norm = normalizeFetchUrl(source?.url);
      if (norm && provenance.has(norm)) {
        fetchableCount += 1;
        provenanceCount += 1;
        continue;
      }
    }
    deniedSourceCount += 1;
    if (!seen.has(host)) {
      seen.add(host);
      deniedHosts.push(host);
    }
  }

  const egress = { mode: posture, fetchableCount, deniedHosts, deniedSourceCount };
  if (provenance) egress.fetchableBy = { allowlist: fetchableCount - provenanceCount, provenance: provenanceCount };
  if (deniedHosts.length === 0) return { answer: original, egress };

  // Every clause below is something this code observed: which hosts the policy would
  // refuse to rks_fetch_raw, that no fetch ran, and that synthesis saw all sources.
  const named = deniedHosts.join(', ');
  const total = list.length;
  const policy =
    `this project's egress policy (\`fetchRaw.allowedHosts\` in \`.rks/project.json\`)`;
  const noFetch =
    `> External research fetches no pages: this answer was synthesized from the ` +
    `search titles and snippets of all ${total} sources`;
  const banner = fetchableCount === 0
    ? `> ⚠️ **Egress notice** — \`rks_fetch_raw\` would refuse every source host under ` +
      `${policy}: ${named}.\n` +
      `${noFetch}. Add a host to the allowlist only if you need \`rks_fetch_raw\` to ` +
      `read its full document.`
    : `> ⚠️ **Egress notice** — ${deniedSourceCount} of ${total} sources ` +
      `(${deniedHosts.length} distinct host(s): ${named}) would be refused by ` +
      `\`rks_fetch_raw\` under ${policy}.\n` +
      `${noFetch}, including those.`;

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
async function defaultSynthesizeFn({ query, sources, projectRoot, projectId }) {
  const env = loadEnv();
  // backlog.feat.oneshot-callers-keyless-reachable (AC1, AC2): with no key the backend is resolved
  // first, and the guard throws only when it is not the claude-cli one-shot. A throw from
  // resolution counts as "not claude-cli". The keyed path is unchanged.
  let noKeyBackend = null;
  if (!env.anthropicKey) {
    try {
      noKeyBackend = resolveBackend({ env, caller: 'external-research', pinProvider: 'anthropic' });
    } catch {
      noKeyBackend = null;
    }
  }
  if (!env.anthropicKey && noKeyBackend?.id !== 'claude-cli') {
    throw new Error('No ANTHROPIC_API_KEY configured for synthesis.');
  }

  const backend = noKeyBackend || resolveBackend({ env, caller: 'external-research', pinProvider: 'anthropic' });
  // Centralized model selection (Finding 5): env (RKS_RESEARCH_MODEL) > agents.yaml
  // > DEFAULTS, via loadAgentConfig('research') — no hardcoded/decommissioned fallback.
  const model = loadAgentConfig('research', projectRoot).model;
  const prompt = buildSynthesisPrompt({ query, sources });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_LLM_TIMEOUT_MS);

  let completion;
  try {
    // Attribution for llm.token_usage (backlog.fix.llm-token-usage-complete-coverage). The input
    // schema carries no problemId, so none is passed.
    completion = await backend.complete({
      withUsage: false,
      model,
      prompt,
      signal: controller.signal,
      context: { projectId, caller: 'external-research' },
    });
    clearTimeout(timeout);
  } catch (err) {
    clearTimeout(timeout);
    throw new Error(`Synthesis LLM call failed: ${err.message}`);
  }
  // AC4: a one-shot refusal is detected from its reason field (never its error text) and is
  // terminal. It is thrown as a structured error so the entry point never reports an empty
  // answer as ok.
  if (completion?.reason === SUBSCRIPTION_REFUSAL_REASON) throw synthesisRefusalError(completion);
  return completion?.content;
}

/** An Error carrying the one-shot refusal's fields, read by runExternalResearch's catch. */
function synthesisRefusalError(refusal) {
  const message = refusal.message || refusal.error || SUBSCRIPTION_REFUSAL_REASON;
  const err = new Error(`Synthesis refused: ${message}`);
  err.reason = SUBSCRIPTION_REFUSAL_REASON;
  err.fallback = 'none';
  if (refusal.probeReason) err.probeReason = refusal.probeReason;
  return err;
}

// --- Main Entry Point ---

/**
 * @param {object} rawInput
 * @param {object} [deps] Overridable seams, each defaulting to production behaviour.
 *   `collector` replaces the telemetry collector, `searchFn` the web search, and
 *   `synthesizeFn` the LLM call. Widening this signature is non-breaking — every caller
 *   passes exactly one argument, except the rks_agent_external_research handler, which adds
 *   `recordSurfaced` for a live governor session. `recordSurfaced(urls)` persists the
 *   sources' URLs to the session's fetch provenance and returns { recorded, urls } from its
 *   read-back; it runs once, after synthesis resolves and before the egress preflight, and
 *   the observed `urls` reach applyEgressWarning as provenanceUrls.
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
    const synthesized = await synthesizeFn({ query: input.query, sources, projectRoot, projectId: input.projectId });

    // 2b. Record the surfaced URLs (live governor session only). After synthesis, so a failed
    // search or synthesis records nothing; the banner uses only what was observed persisted.
    let provenanceUrls;
    if (typeof deps.recordSurfaced === 'function') {
      try {
        const recorded = await deps.recordSurfaced(sources.map((s) => s?.url));
        provenanceUrls = Array.isArray(recorded?.urls) ? recorded.urls : [];
      } catch {
        provenanceUrls = [];
      }
    }

    // 3. Egress preflight — tell the reader if this project's policy refused the sources.
    const { answer, egress } = applyEgressWarning({
      answer: synthesized,
      sources,
      mode: loadFetchMode(projectRoot),
      allowedHosts: loadAllowedHosts(projectRoot),
      provenanceUrls,
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
        sourceCount: sources.length,
        fetchableCount: egress.fetchableCount,
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
      // CONDITIONAL: only a claude-cli one-shot refusal adds these (AC4).
      ...(err?.reason === SUBSCRIPTION_REFUSAL_REASON
        ? { reason: SUBSCRIPTION_REFUSAL_REASON, fallback: 'none', ...(err.probeReason ? { probeReason: err.probeReason } : {}) }
        : {}),
    };
  }
}
