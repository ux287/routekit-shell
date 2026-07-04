/**
 * LLM Clients Module
 *
 * Handles LLM client creation and API calls for OpenAI and Anthropic providers.
 */
import { getTelemetryCollector } from "../server/telemetry/index.mjs";

// Default timeout for LLM calls (5 minutes)
export const DEFAULT_LLM_TIMEOUT_MS = Number.isFinite(Number(process.env.RKS_LLM_TIMEOUT_MS))
  ? Number(process.env.RKS_LLM_TIMEOUT_MS)
  : 300000;

// Default max tokens for LLM responses
export const DEFAULT_LLM_MAX_TOKENS = Number.isFinite(Number(process.env.RKS_LLM_MAX_TOKENS))
  ? Number(process.env.RKS_LLM_MAX_TOKENS)
  : 16000;

/**
 * Load LLM environment configuration
 */
export function loadEnv() {
  const explicitProvider = process.env.ROUTEKIT_LLM_PROVIDER || null;
  const anthropicKey = process.env.ANTHROPIC_API_KEY || null;
  const openaiKey = process.env.OPENAI_API_KEY || null;

  // Infer provider from config: explicit setting takes precedence, otherwise infer from API key
  let provider;
  if (explicitProvider) {
    provider = explicitProvider;
  } else if (anthropicKey) {
    provider = "anthropic";
  } else if (openaiKey) {
    provider = "openai";
  } else {
    provider = null;
  }

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
 * Call OpenAI chat API
 */
export async function callOpenAiChat({ client, model, prompt, signal, systemPrompt = null }) {
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
      system: systemPrompt || "You are the RouteKit planner. Respond ONLY with a single JSON object that matches the schema described in the user's message. Do not include markdown code fences or any text outside the JSON. IMPORTANT: When generating any search_replace edits, you MUST use only verbatim code from the RAG code snippets included in the prompt. Do NOT guess or invent code patterns. If the required code is not present in the provided snippets, respond with a plan step that requests more code context (e.g. 'needs_code_context').",
    }),
  });

  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`Anthropic error: ${resp.status} ${txt}`);
  }

  const data = await resp.json();
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

  if (data.usage) {
    try {
      const { sessionId, problemId, projectId } = context;
      getTelemetryCollector().emit('llm.token_usage', projectId || null, {
        clientName: 'anthropic-http',
        inputTokens: data.usage.input_tokens,
        outputTokens: data.usage.output_tokens,
        cacheReadTokens: data.usage.cache_read_input_tokens ?? 0,
        cacheCreationTokens: data.usage.cache_creation_input_tokens ?? 0,
        ...(sessionId ? { sessionId } : {}),
        ...(problemId ? { problemId } : {}),
      });
    } catch (e) { /* telemetry is best-effort */ }
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
};
