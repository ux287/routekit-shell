/**
 * LLM Clients Module
 *
 * Handles LLM client creation and API calls for OpenAI and Anthropic providers.
 */
import { getTelemetryCollector } from "@routekit/telemetry";

// Default timeout for LLM calls (5 minutes)
export const DEFAULT_LLM_TIMEOUT_MS = Number.isFinite(Number(process.env.RKS_LLM_TIMEOUT_MS))
  ? Number(process.env.RKS_LLM_TIMEOUT_MS)
  : 300000;

// Default max tokens for LLM responses
export const DEFAULT_LLM_MAX_TOKENS = Number.isFinite(Number(process.env.RKS_LLM_MAX_TOKENS))
  ? Number(process.env.RKS_LLM_MAX_TOKENS)
  : 16000;

/**
 * Resolve the LLM provider from an INJECTED env object (single source of truth for the
 * inference rule). Explicit ROUTEKIT_LLM_PROVIDER wins; else infer from whichever key is
 * present — ANTHROPIC_API_KEY → "anthropic" (checked before openai), else OPENAI_API_KEY →
 * "openai"; else null. Pure: reads only its argument, never process.env, never mutates.
 * Shared by loadEnv() and the startup credential preflight so the two never diverge.
 */
export function inferProvider(env = {}) {
  const explicitProvider = env.ROUTEKIT_LLM_PROVIDER || null;
  if (explicitProvider) return explicitProvider;
  if (env.ANTHROPIC_API_KEY) return "anthropic";
  if (env.OPENAI_API_KEY) return "openai";
  return null;
}

/**
 * Load LLM environment configuration
 */
export function loadEnv() {
  const anthropicKey = process.env.ANTHROPIC_API_KEY || null;
  const openaiKey = process.env.OPENAI_API_KEY || null;

  // Provider inference is delegated to the shared inferProvider() helper (single source of
  // truth), so loadEnv and the credential preflight apply the exact same rule.
  const provider = inferProvider(process.env);

  const model = process.env.ROUTEKIT_LLM_MODEL || null;

  console.error(`[llm] loadEnv: provider=${provider}, model=${model}, hasAnthropicKey=${!!anthropicKey}, hasOpenaiKey=${!!openaiKey}`);

  return {
    provider,
    model,
    openaiKey,
    anthropicKey,
  };
}

/**
 * Create an OpenAI client configuration
 */
export function createOpenAiClient(env) {
  if (env.provider !== "openai" || !env.openaiKey) return null;
  return {
    apiKey: env.openaiKey,
    baseURL: process.env.ROUTEKIT_LLM_BASE_URL || "https://api.openai.com/v1",
  };
}

/**
 * Create an Anthropic client configuration
 */
export function createAnthropicClient(env) {
  if (env.provider !== "anthropic" || !env.anthropicKey) return null;
  return {
    apiKey: env.anthropicKey,
    baseURL: process.env.ROUTEKIT_ANTHROPIC_BASE_URL || "https://api.anthropic.com",
  };
}

/**
 * In-flight LLM request registry (backlog.fix.llm-token-usage-complete-coverage).
 *
 * Every _callAnthropicChatCore / callOpenAiChat call registers a settle promise when it
 * starts and removes it (in a finally) when the request settles, resolve or reject. A
 * caller that stops awaiting a request (planner callOnce's withTimeout race) leaves the
 * request running; awaitOutstandingLlmRequests lets a short-lived process (bin/plan-worker.mjs)
 * wait, bounded, for those requests so their llm.token_usage events are recorded before exit.
 */
const _inFlightLlmRequests = new Set();

function _registerInFlightLlmRequest() {
  let settle;
  const entry = new Promise((resolve) => { settle = resolve; });
  _inFlightLlmRequests.add(entry);
  return () => {
    _inFlightLlmRequests.delete(entry);
    settle();
  };
}

/**
 * Wait until every registered LLM request settles or `timeoutMs` elapses, whichever comes
 * first. Never rejects. Resolves with `{ drained, abandoned }`: `drained` counts requests
 * that settled during the wait, `abandoned` counts those still registered when the bound
 * elapsed. Both are read from the registry. The timer is cleared on completion and unref'd,
 * so it never holds the process open.
 */
export async function awaitOutstandingLlmRequests({ timeoutMs } = {}) {
  const pending = [..._inFlightLlmRequests];
  if (pending.length === 0) return { drained: 0, abandoned: 0 };
  let timer = null;
  try {
    const bound = new Promise((resolve) => {
      timer = setTimeout(resolve, Math.max(0, Number(timeoutMs) || 0));
      if (timer && typeof timer.unref === "function") timer.unref();
    });
    await Promise.race([Promise.allSettled(pending), bound]);
  } catch {
    /* never rejects */
  } finally {
    if (timer) clearTimeout(timer);
  }
  const abandoned = pending.filter((p) => _inFlightLlmRequests.has(p)).length;
  return { drained: pending.length - abandoned, abandoned };
}

/**
 * Best-effort llm.token_usage emit shared by the HTTP transports. `context` supplies the
 * attribution (projectId as the emit projectId argument; sessionId, problemId and caller
 * copied into the payload when present). A throwing collector never breaks the model call.
 */
function _emitTokenUsage({ clientName, model, context, tokens }) {
  try {
    const { sessionId, problemId, projectId, caller } = context || {};
    getTelemetryCollector().emit('llm.token_usage', projectId || null, {
      clientName,
      // Canonical NESTED token shape. Both readers — cost-report.mjs (filter L158/L278,
      // reads tokens.{in,out,cacheRead}) and the dashboard token-costs endpoint
      // (vite-plugin-telemetry-api.ts filter L446, reads tokens.{in,out,cacheRead}) —
      // gate on `payload.tokens != null`. This emitter previously wrote FLAT fields
      // (inputTokens/outputTokens/...), so every real event was dropped at that filter
      // and dashboard cost reports were always null. Emit the nested shape the readers
      // (and the SDK agent-runner emitter) expect.
      tokens,
      // The resolved full model id (e.g. claude-haiku-4-5-20251001), keyed exactly as
      // cost.mjs MODEL_PRICING expects. Without this every live event priced at the sonnet
      // `default` — see backlog.fix.llm-token-usage-emit-model (pairs with the pricing fix).
      ...(model ? { model } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(problemId ? { problemId } : {}),
      ...(typeof caller === "string" && caller ? { caller } : {}),
    });
  } catch (e) { /* telemetry is best-effort */ }
}

/**
 * Call OpenAI chat API
 */
export async function callOpenAiChat({ client, model, prompt, signal, systemPrompt = null, context = {} }) {
  // Clear, value-free error instead of a null-deref when createOpenAiClient returned null
  // (OPENAI_API_KEY not set for the openai provider) on a key-free boot.
  if (!client || !client.apiKey) {
    throw new Error(
      "Missing OpenAI credential: no client available (set OPENAI_API_KEY for the openai provider)."
    );
  }
  const settleInFlight = _registerInFlightLlmRequest();
  try {
    return await _callOpenAiChatRequest({ client, model, prompt, signal, systemPrompt, context });
  } finally {
    settleInFlight();
  }
}

async function _callOpenAiChatRequest({ client, model, prompt, signal, systemPrompt, context }) {
  const endpoint = `${client.baseURL.replace(/\/$/, "")}/chat/completions`;
  const resp = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${client.apiKey}`,
    },
    signal,
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "system",
          content: systemPrompt ||
            "You are the RouteKit planner. Respond ONLY with a single JSON object that matches the schema described in the user's message. Do not include markdown code fences or any text outside the JSON. IMPORTANT: When generating any search_replace edits, you MUST use only verbatim code from the RAG code snippets included in the prompt. Do NOT guess or invent code patterns. If the required code is not present in the provided snippets, respond with a plan step that requests more code context (e.g. \"needs_code_context\").",
        },
        {
          role: "user",
          content: prompt,
        },
      ],
      temperature: 1,
      max_completion_tokens: DEFAULT_LLM_MAX_TOKENS,
    }),
  });

  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`OpenAI error: ${resp.status} ${txt}`);
  }

  const data = await resp.json();
  // Record a billed 200 BEFORE validating it: the throws below still reach the caller
  // unchanged, but the provider has already billed the response.
  if (data?.usage) {
    _emitTokenUsage({
      clientName: 'openai-http',
      model,
      context,
      tokens: {
        in: data.usage.prompt_tokens ?? 0,
        out: data.usage.completion_tokens ?? 0,
        cacheRead: data.usage.prompt_tokens_details?.cached_tokens ?? 0,
        cacheCreate: 0,
      },
    });
  }
  if (!data || !Array.isArray(data.choices) || data.choices.length === 0) {
    const snippet = JSON.stringify(data || {}).slice(0, 2000);
    throw new Error(
      `OpenAI chat payload had no choices. Payload snippet: ${snippet}`,
    );
  }

  const firstChoice = data.choices[0];
  const message = firstChoice && firstChoice.message;
  const content =
    message && typeof message.content === "string"
      ? message.content.trim()
      : "";

  if (!content) {
    if (firstChoice && firstChoice.finish_reason === "length") {
      throw new Error(
        "LLM output truncated (finish_reason=length): prompt too large or completion budget too small."
      );
    }
    const snippet = JSON.stringify(firstChoice || {}).slice(0, 2000);
    throw new Error(
      `OpenAI chat choice had no usable message.content. Choice snippet: ${snippet}`,
    );
  }

  return content;
}

/**
 * Core Anthropic HTTP call — returns { content, usage }.
 * Single source of truth; callAnthropicChat wraps this for backward compat.
 */
async function _callAnthropicChatCore({ client, model, prompt, signal, systemPrompt = null, context = {} }) {
  // Clear, value-free error instead of a null-deref when createAnthropicClient returned null
  // (ANTHROPIC_API_KEY not set for the anthropic provider) on a key-free boot.
  if (!client || !client.apiKey) {
    throw new Error(
      "Missing Anthropic credential: no client available (set ANTHROPIC_API_KEY for the anthropic provider)."
    );
  }
  const settleInFlight = _registerInFlightLlmRequest();
  try {
    return await _callAnthropicChatRequest({ client, model, prompt, signal, systemPrompt, context });
  } finally {
    settleInFlight();
  }
}

async function _callAnthropicChatRequest({ client, model, prompt, signal, systemPrompt, context }) {
  const endpoint = `${client.baseURL.replace(/\/$/, "")}/v1/messages`;
  const resp = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": client.apiKey,
      "anthropic-version": "2023-06-01",
    },
    signal,
    body: JSON.stringify({
      model,
      max_tokens: DEFAULT_LLM_MAX_TOKENS,
      messages: [
        {
          role: "user",
          content: prompt,
        },
      ],
      // Stable system prefix as a cache_control-marked block (Anthropic prompt caching →
      // ~90% input savings on repeat calls, 5-min TTL). Billing-only; output is unchanged.
      // See backlog.feat.llm-prompt-caching.
      system: [
        {
          type: "text",
          text: systemPrompt || "You are the RouteKit planner. Respond ONLY with a single JSON object that matches the schema described in the user's message. Do not include markdown code fences or any text outside the JSON. IMPORTANT: When generating any search_replace edits, you MUST use only verbatim code from the RAG code snippets included in the prompt. Do NOT guess or invent code patterns. If the required code is not present in the provided snippets, respond with a plan step that requests more code context (e.g. 'needs_code_context').",
          cache_control: { type: "ephemeral" },
        },
      ],
    }),
  });

  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`Anthropic error: ${resp.status} ${txt}`);
  }

  const data = await resp.json();
  // Record a billed 200 BEFORE validating it (data may be null): the no-content and
  // no-usable-text throws below still reach the caller unchanged.
  if (data?.usage) {
    _emitTokenUsage({
      clientName: 'anthropic-http',
      model,
      context,
      tokens: {
        in: data.usage.input_tokens,
        out: data.usage.output_tokens,
        cacheRead: data.usage.cache_read_input_tokens ?? 0,
        cacheCreate: data.usage.cache_creation_input_tokens ?? 0,
      },
    });
  }
  if (!data || !Array.isArray(data.content) || data.content.length === 0) {
    const snippet = JSON.stringify(data || {}).slice(0, 2000);
    throw new Error(`Anthropic response had no content. Snippet: ${snippet}`);
  }

  const textBlock = data.content.find(b => b.type === "text");
  const content = textBlock?.text?.trim() || "";

  if (!content) {
    if (data.stop_reason === "max_tokens") {
      throw new Error("LLM output truncated (stop_reason=max_tokens)");
    }
    throw new Error(`Anthropic response had no usable text content`);
  }

  return { content, usage: data.usage ?? null };
}

/**
 * Call Anthropic chat API — returns content string (backward compat).
 */
export async function callAnthropicChat(args) {
  const { content } = await _callAnthropicChatCore(args);
  return content;
}

/**
 * Call Anthropic chat API — returns { content, usage } for token-aware callers.
 */
export async function callAnthropicChatWithUsage(args) {
  return _callAnthropicChatCore(args);
}

export default {
  DEFAULT_LLM_TIMEOUT_MS,
  DEFAULT_LLM_MAX_TOKENS,
  loadEnv,
  createOpenAiClient,
  createAnthropicClient,
  callOpenAiChat,
  callAnthropicChat,
  callAnthropicChatWithUsage,
  awaitOutstandingLlmRequests,
};
