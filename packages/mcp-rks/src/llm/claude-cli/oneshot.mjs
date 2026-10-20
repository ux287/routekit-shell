/**
 * Text-only claude -p LLMBackend (Seam A one-shot): no tools, no MCP servers, user's own binary
 * and subscription login. rks keeps the prompt (--system-prompt-file + stdin), the model
 * (--model), the output (result text, parsed by the caller as today) and the cost record
 * (one llm.token_usage tagged billing:'subscription'). Falls back to the API backend on any
 * transport failure (D1); the fallback is volunteered in the return value (backendFallback), in one
 * llm.backend_fallback event and in one console.error line (evidence-bound reporting R9), each
 * emitted only once apiBackend.complete has been entered, with `to` = apiBackend.id.
 * With no key for apiBackend's provider there is no fallback: every claude -p failure path returns
 * a structured refusal (reason 'subscription_unavailable', fallback 'none') and emits
 * llm.backend_refused; a not-ready probe opens no cool-down (the probe cache is invalidated) and
 * only rate_limit keeps its cool-down (backlog.feat.keyless-backend-aware-credential-presence, AC9).
 * Imports BackendCapabilityError from ../backend.mjs, which imports this module: the cycle is safe
 * because neither module touches the other's bindings while it evaluates (only inside functions).
 */
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getTelemetryCollector } from '@routekit/telemetry';
import { DEFAULT_LLM_TIMEOUT_MS } from '../clients.mjs';
import { BackendCapabilityError } from '../backend.mjs';
import { buildSubscriptionEnv, SUBSCRIPTION_AUTH_METHODS } from './probe.mjs';
import { runChild, parseStreamJson, mapUsage, isRateLimited, AUTH_RETRY_ERRORS, OVERLOAD_RETRY_ERRORS } from './transport.mjs';
import { getDefaultClaudeCliGate, cooldownMsFor, opensCooldown } from './gate.mjs';
import { hasProviderApiKey, PROVIDER_API_KEYS, buildSubscriptionRefusal, retryAfterFor } from './subscription-status.mjs';

export const ONESHOT_BACKEND_ID = 'claude-cli';
export const ONESHOT_MAX_TURNS = 2;
export const MAX_STDIN_BYTES = 10 * 1024 * 1024; // headless.md: piped stdin is capped at 10MB
// The Anthropic HTTP transport's default system text (clients.mjs, the system block's `systemPrompt ||`
// fallback). Copied, not imported: clients.mjs keeps it inline. tests/unit/claude-cli-oneshot-backend.test.mjs
// pins this copy equal to the text the real HTTP transport sends, so a drift reddens CI.
export const HTTP_DEFAULT_SYSTEM_PROMPT = "You are the RouteKit planner. Respond ONLY with a single JSON object that matches the schema described in the user's message. Do not include markdown code fences or any text outside the JSON. IMPORTANT: When generating any search_replace edits, you MUST use only verbatim code from the RAG code snippets included in the prompt. Do NOT guess or invent code patterns. If the required code is not present in the provided snippets, respond with a plan step that requests more code context (e.g. 'needs_code_context').";
export const ONESHOT_SELECTION_KEYS = Object.freeze({
  planner: 'llm-planner',
  reviewer: 'reviewer',
  'external-research': 'external-research',
  'qa-agent': 'qa-agent',
});

export function buildOneShotArgs({ model, systemPromptFile, mcpConfigFile, sessionId, maxTurns = ONESHOT_MAX_TURNS }) {
  return [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--model', model,
    '--max-turns', String(maxTurns),
    '--system-prompt-file', systemPromptFile,
    '--tools', '',
    '--strict-mcp-config',
    '--mcp-config', mcpConfigFile,
    '--permission-mode', 'dontAsk',
    '--permission-prompts', 'none',
    '--disable-slash-commands',
    '--no-session-persistence',
    '--session-id', sessionId,
  ];
}

/** null = transport success. Never requires an MCP server; refuses if any is loaded. */
export function classifyOneShotFailure({ spawnError, timedOut, exitCode, stream, timeoutMs }) {
  if (spawnError) return { reason: 'spawn_failed', error: `claude-cli spawn failed: ${spawnError.message || spawnError}` };
  if (timedOut) return { reason: 'timeout', error: `claude-cli one-shot timed out after ${timeoutMs}ms` };
  const servers = Array.isArray(stream?.init?.mcp_servers) ? stream.init.mcp_servers : [];
  if (servers.length > 0) return { reason: 'unexpected_mcp_servers', error: `claude-cli: unexpected MCP servers loaded: ${servers.map((s) => s?.name).join(', ')}` };
  const result = stream?.result;
  if (!result || result.is_error === true || exitCode !== 0) {
    const detail = String(result?.result ?? '').slice(0, 300);
    const retryErrors = (stream?.retries || []).map((r) => r?.error).filter(Boolean);
    // Identical trigger to the research executor's classifier: only a "rejected" rate_limit_event is
    // limited, and its resetsAt sizes the cool-down through cooldownMsFor.
    const limitedInfo = isRateLimited(stream?.rateLimit) ? stream.rateLimit : null;
    if (limitedInfo || retryErrors.includes('rate_limit') || /usage limit|rate limit|limit reached/i.test(detail)) {
      const resetsAt = limitedInfo && Number.isFinite(limitedInfo.resetsAt) ? limitedInfo.resetsAt : null;
      return { reason: 'rate_limit', error: `claude-cli rate_limit: ${detail || 'rate limited'}`, ...(resetsAt !== null ? { resetsAt } : {}) };
    }
    if (retryErrors.some((e) => AUTH_RETRY_ERRORS.has(e))) return { reason: 'auth', error: `claude-cli authentication failed: ${detail}` };
    if (retryErrors.some((e) => OVERLOAD_RETRY_ERRORS.has(e))) return { reason: 'overloaded', error: `claude-cli overloaded: ${detail}` };
    if (retryErrors.includes('model_not_found')) return { reason: 'model_unavailable', error: `claude-cli model unavailable: ${detail}` };
    return { reason: 'cli_error', error: `claude-cli exited ${exitCode}${detail ? `: ${detail}` : ''}` };
  }
  return null;
}

function abortError() {
  const err = new Error('claude-cli one-shot aborted');
  err.name = 'AbortError';
  return err;
}

/**
 * Options: apiBackend (the fallback, required), caller (telemetry attribution), gate (default: the
 * process-wide getDefaultClaudeCliGate()), env (parent env for the probe, binary and env strip),
 * spawnImpl (test seam), timeoutMs (default DEFAULT_LLM_TIMEOUT_MS), collector (test seam; default
 * getTelemetryCollector()), now (default: the gate's clock).
 */
export function createClaudeCliOneShotBackend({
  apiBackend, caller = null, gate = getDefaultClaudeCliGate(), env = process.env,
  spawnImpl, timeoutMs = DEFAULT_LLM_TIMEOUT_MS, collector = null, now = null,
} = {}) {
  const clock = now || gate.now;
  const emit = (event, projectId, payload) => {
    try { (collector || getTelemetryCollector()).emit(event, projectId || null, payload); } catch { /* best-effort */ }
  };
  // Key-only predicate on apiBackend's provider key, never hasLlmCredential.
  const apiFallback = hasProviderApiKey(apiBackend?.id, env);
  const fallback = async (request, reason, { probeReason = null } = {}) => {
    const projectId = request?.context?.projectId;
    if (!apiFallback) {
      const keyName = PROVIDER_API_KEYS[apiBackend?.id] || 'ANTHROPIC_API_KEY';
      const refusal = buildSubscriptionRefusal({
        subject: `claude-cli one-shot (${caller})`, cause: reason, probeReason, retryAfter: retryAfterFor(gate), keyName,
      });
      emit('llm.backend_refused', projectId, {
        caller, from: ONESHOT_BACKEND_ID, reason, ...(probeReason ? { probeReason } : {}), fallback: 'none', model: request?.model,
      });
      console.error(`[llm] claude-cli one-shot (${caller}) refused, no API fallback: ${reason}${probeReason ? ` (${probeReason})` : ''}`);
      // content '' keeps the backend contract's string type for callers that destructure content.
      return { content: '', usage: null, usageEmitted: true, ...refusal };
    }
    const to = apiBackend.id;
    let pending;
    try {
      pending = apiBackend.complete(request);
    } catch (err) {
      pending = Promise.reject(err);
    }
    // Observation-sourced (R9): reported only once the API call has been entered.
    emit('llm.backend_fallback', projectId, { caller, from: ONESHOT_BACKEND_ID, to, reason, model: request?.model });
    console.error(`[llm] claude-cli one-shot (${caller}) fell back to ${to}: ${reason}`);
    const result = await pending;
    return { ...result, backendFallback: { from: ONESHOT_BACKEND_ID, to, reason } };
  };
  const openCooldownFor = (failure) => {
    gate.openCooldown(failure.reason, cooldownMsFor(failure, clock(), gate.cooldownMs));
  };

  async function runOneShot(request) {
    const signal = request?.signal || null;
    if (signal?.aborted) throw abortError();
    if (Buffer.byteLength(String(request.prompt ?? ''), 'utf8') > MAX_STDIN_BYTES) return fallback(request, 'input_too_large');
    if (gate.inCooldown()) return fallback(request, 'cooldown');
    const probe = await gate.probeCache.get({ parentEnv: env });
    if (!probe || probe.ready !== true || !SUBSCRIPTION_AUTH_METHODS.includes(probe.authMethod)) {
      if (apiFallback) openCooldownFor({ reason: 'unavailable' });
      else gate.probeCache.invalidate();
      const probeReason = probe?.reason || (probe?.ready === true ? 'not_subscription_auth' : 'probe_failed');
      return fallback(request, 'unavailable', { probeReason });
    }
    if (!gate.tryAcquire()) return fallback(request, 'busy');
    let scratch = null;
    let failure = null;
    let tokens = null;
    let text = '';
    try {
      scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rks-claude-oneshot-'));
      const systemPromptFile = path.join(scratch, 'system-prompt.txt');
      const mcpConfigFile = path.join(scratch, 'mcp-config.json');
      // No systemPrompt: an HTTP-transport request gets the system text the HTTP transport would
      // have sent; an SDK-transport request (qa-agent) sent none, so it gets an empty file.
      const systemText = request.systemPrompt || (request.transport === 'sdk' ? '' : HTTP_DEFAULT_SYSTEM_PROMPT);
      fs.writeFileSync(systemPromptFile, systemText, 'utf8');
      fs.writeFileSync(mcpConfigFile, JSON.stringify({ mcpServers: {} }), 'utf8');
      const args = buildOneShotArgs({ model: request.model, systemPromptFile, mcpConfigFile, sessionId: crypto.randomUUID() });
      const run = await runChild({
        ...(spawnImpl ? { spawnImpl } : {}),
        binary: env.RKS_CLAUDE_BIN || 'claude', args, cwd: scratch,
        env: buildSubscriptionEnv(env).env, input: request.prompt, timeoutMs, signal,
      });
      if (run.aborted) throw abortError();
      const stream = parseStreamJson(run.stdout);
      failure = classifyOneShotFailure({ ...run, stream, timeoutMs });
      if (!failure) {
        tokens = mapUsage(stream.result);
        const ctx = request.context || {};
        // Billed on the subscription: recorded BEFORE the empty-text check, as clients.mjs records a
        // billed 200 before validating it.
        emit('llm.token_usage', ctx.projectId, {
          clientName: 'claude-cli', model: request.model, tokens,
          ...(caller ? { caller } : {}),
          backend: ONESHOT_BACKEND_ID, billing: 'subscription',
          ...(Number.isFinite(stream.result.total_cost_usd) ? { costUsdEstimate: stream.result.total_cost_usd } : {}),
          ...(probe.version ? { claudeVersion: probe.version } : {}),
          authMethod: probe.authMethod,
          ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
          ...(ctx.problemId ? { problemId: ctx.problemId } : {}),
        });
        text = String(stream.result.result ?? '').trim();
      }
    } finally {
      gate.release();
      if (scratch) {
        try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* best-effort */ }
      }
    }
    if (failure) {
      if (opensCooldown(failure.reason, { apiFallback })) openCooldownFor(failure);
      if (failure.reason === 'auth' || (!apiFallback && failure.reason === 'unavailable')) gate.probeCache.invalidate();
      return fallback(request, failure.reason);
    }
    // Capability outcome, not a transport failure: no fallback, no cool-down; the caller's retry handles it.
    if (!text) throw new Error('claude-cli one-shot returned no usable text content');
    return { content: text, usage: tokens, usageEmitted: true };
  }

  return {
    id: ONESHOT_BACKEND_ID,
    fallbackBackend: apiBackend,
    capabilities: Object.freeze({ toolUse: false, vision: false, promptCacheControl: false, perTurnUsage: false }),
    async createMessage() {
      throw new BackendCapabilityError(ONESHOT_BACKEND_ID, 'createMessage (tool-use and image turns)');
    },
    async complete(request) {
      return runOneShot(request);
    },
  };
}
