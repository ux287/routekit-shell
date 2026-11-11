/**
 * LLM backend seam (Seam A: one model turn). research.2026.10.05.llm-backend-layer sec. 3.1.
 * Canonical content format is the Anthropic Messages block shape. Backends emit NO telemetry
 * here; callers keep their existing emitters, and complete() reports usageEmitted so each
 * billed call is recorded exactly once.
 */
import { callAnthropicChat, callAnthropicChatWithUsage, callOpenAiChat, createAnthropicClient, createOpenAiClient, loadEnv } from './clients.mjs';
import { assertAnthropicCredential } from './credential-preflight.mjs';
import { resolveAgentBackend } from '../agents/config.mjs';
import { createClaudeCliOneShotBackend, ONESHOT_SELECTION_KEYS } from './claude-cli/oneshot.mjs';

export class BackendCapabilityError extends Error {
  constructor(backendId, capability) {
    super(`LLM backend '${backendId}' does not support ${capability}`);
    this.name = 'BackendCapabilityError';
    this.backendId = backendId;
    this.capability = capability;
  }
}

export function normalizeUsage(u) {
  if (!u) return null;
  return {
    in: u.input_tokens ?? 0,
    out: u.output_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
    cacheCreate: u.cache_creation_input_tokens ?? 0,
  };
}

function hasImageBlock(messages) {
  return (messages || []).some((m) => Array.isArray(m?.content) && m.content.some((b) => b?.type === 'image'));
}

export function createAnthropicBackend({ sdkClient = null, env: boundEnv = null } = {}) {
  let client = sdkClient;
  const getSdkClient = async () => {
    if (client) return client;
    assertAnthropicCredential();
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    client = new Anthropic();
    return client;
  };
  return {
    id: 'anthropic',
    capabilities: Object.freeze({ toolUse: true, vision: true, promptCacheControl: true, perTurnUsage: true }),
    async createMessage({ model, system, messages, tools, maxTokens, signal } = {}) {
      const c = await getSdkClient();
      const request = { model, max_tokens: maxTokens, messages };
      if (system !== undefined) request.system = system;
      if (tools !== undefined) request.tools = tools;
      const raw = await c.messages.create(request, signal ? { signal } : undefined);
      return { content: raw?.content ?? [], stopReason: raw?.stop_reason ?? null, usage: normalizeUsage(raw?.usage), model, raw };
    },
    async complete({ model, prompt, systemPrompt = null, maxTokens, signal, context = {}, transport = 'http', withUsage = true, env = null } = {}) {
      if (transport === 'sdk') {
        const { raw } = await this.createMessage({ model, maxTokens, signal, messages: [{ role: 'user', content: prompt }], ...(systemPrompt ? { system: systemPrompt } : {}) });
        return { content: raw?.content?.[0]?.text ?? '', usage: raw?.usage ?? null, usageEmitted: false, raw };
      }
      const e = env || boundEnv || loadEnv();
      const httpClient = createAnthropicClient({ ...e, provider: 'anthropic' });
      // Same text planner.mjs threw before migration (:449, :1557) when no key is configured.
      if (!httpClient) throw new Error('Anthropic client not configured');
      // Call the SAME clients.mjs export the caller used before migration: review.mjs and
      // external-research.mjs call callAnthropicChat, the planner calls callAnthropicChatWithUsage,
      // and several tests replace clients.mjs with a full vi.mock factory exposing only those names.
      if (!withUsage) {
        const content = await callAnthropicChat({ client: httpClient, model, prompt, signal, systemPrompt, context });
        return { content, usage: null, usageEmitted: true };
      }
      const { content, usage } = await callAnthropicChatWithUsage({ client: httpClient, model, prompt, signal, systemPrompt, context });
      return { content, usage, usageEmitted: true };
    },
  };
}

export function createOpenAiBackend({ env: boundEnv = null } = {}) {
  return {
    id: 'openai',
    capabilities: Object.freeze({ toolUse: false, vision: false, promptCacheControl: false, perTurnUsage: false }),
    async createMessage() {
      throw new BackendCapabilityError('openai', 'createMessage (tool-use turns)');
    },
    async complete({ model, prompt, systemPrompt = null, signal, context = {}, env = null } = {}) {
      const e = env || boundEnv || loadEnv();
      const httpClient = createOpenAiClient({ ...e, provider: 'openai' });
      // Same text planner.mjs threw before migration (:438, :1541) when no key is configured.
      if (!httpClient) throw new Error('OpenAI client not configured');
      const content = await callOpenAiChat({ client: httpClient, model, prompt, signal, systemPrompt, context });
      return { content, usage: null, usageEmitted: true };
    },
  };
}

export function assertCapabilities(backend, { tools, messages } = {}) {
  if (tools && tools.length > 0 && !backend.capabilities.toolUse) throw new BackendCapabilityError(backend.id, 'tool use');
  if (hasImageBlock(messages) && !backend.capabilities.vision) throw new BackendCapabilityError(backend.id, 'image input');
}

/**
 * Opt-in per caller, default anthropic, fail closed: the claude -p one-shot is chosen only when
 * .rks/agents.yaml sets backend: claude-cli under the caller's ONESHOT_SELECTION_KEYS key. projectRoot
 * is the argument, else ROUTEKIT_PROJECT_ROOT. Under vitest the ROUTEKIT_PROJECT_ROOT fallback is
 * ignored (the runner.mjs underTest rule), so an opted-in repo can never make a unit test spawn the
 * real binary; tests opt in by passing projectRoot.
 */
function oneShotSelected(caller, projectRoot) {
  if (!caller || !Object.prototype.hasOwnProperty.call(ONESHOT_SELECTION_KEYS, caller)) return false;
  const root = projectRoot || (process.env.VITEST ? null : process.env.ROUTEKIT_PROJECT_ROOT) || null;
  if (!root) return false;
  return resolveAgentBackend(ONESHOT_SELECTION_KEYS[caller], root) === 'claude-cli';
}

export function resolveBackend({ env = null, caller = null, pinProvider = null, sdkClient = null, projectRoot = null } = {}) {
  let provider = pinProvider || (env || loadEnv()).provider;
  // backlog.feat.oneshot-callers-keyless-reachable (AC3): no key and no pin leaves the provider
  // null. A caller opted in to the claude-cli one-shot resolves as anthropic (a one-shot over an
  // API fallback that cannot run, which refuses rather than falls back) instead of throwing. Only
  // a null provider takes this branch; an explicit unsupported provider still throws below.
  if (provider == null && oneShotSelected(caller, projectRoot)) provider = 'anthropic';
  // The env is bound into the backend, so complete() without a per-call env never re-loads it.
  if (provider === 'anthropic') {
    const api = createAnthropicBackend({ sdkClient, env });
    return oneShotSelected(caller, projectRoot) ? createClaudeCliOneShotBackend({ apiBackend: api, caller }) : api;
  }
  if (provider === 'openai') return createOpenAiBackend({ env });
  throw new Error(`Unsupported provider: ${provider}`);
}
