/**
 * Subscription credential status and Governor capability admission
 * (backlog.feat.keyless-backend-aware-credential-presence, AC1, AC6, AC7-AC9).
 *
 * Lives here, not in server/handlers/governance.mjs (GV-TR15 allows that file one named
 * function) and not in tools/governor-init.mjs (governor-init-session-isolation.test.mjs pins its
 * single Date.now()). governance.mjs makes one awaited call to resolveInitCredential.
 *
 *   1. API-key-only predicates: pure env checks, no file read, never hasLlmCredential (which now
 *      also answers true for an opted-in, ready subscription and so cannot say "a key exists").
 *   2. Init-time probe and status-file writer: <projectRoot>/.rks/state/llm-backend.json, read by
 *      the hooks (packages/hooks/system/credential-presence.mjs). probedAt is the probe cache's
 *      OBSERVED probe time, never the write time. The file never holds a credential value.
 *   3. Per-flow capability admission. Fails closed to REFUSE: admitting a flow whose planner
 *      cannot run produces a wedged Build, not safety.
 *   4. The structured no-API-key refusal the claude -p paths return instead of a false fallback.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import {
  RECOGNIZED_CREDENTIAL_KEYS,
  SUBSCRIPTION_STATUS_FILE_SEGMENTS,
  isSubscriptionOptInOn,
} from '../../../../hooks/system/credential-presence.mjs';
import { resolveAgentBackend } from '../../agents/config.mjs';
import { DEFAULT_PROBE_TTL_MS, MIN_CLAUDE_VERSION } from './probe.mjs';
import { getDefaultClaudeCliGate } from './gate.mjs';

export const STATUS_FILE_REL = path.join(...SUBSCRIPTION_STATUS_FILE_SEGMENTS);
export const STATUS_FILE_KEYS = Object.freeze(['ready', 'authMethod', 'version', 'reason', 'probedAt', 'ttlMs', 'agentsYamlDigest']);
export const SUBSCRIPTION_REFUSAL_REASON = 'subscription_unavailable';

const nonEmpty = (v) => typeof v === 'string' && v.trim() !== '';

// ---------------------------------------------------------------------------------------------
// 1. API-key-only predicates (no file read)
// ---------------------------------------------------------------------------------------------

/** Init credential 'api': any recognized key non-empty in env. */
export function hasAnyApiKey(env = process.env) {
  if (!env || typeof env !== 'object') return false;
  return RECOGNIZED_CREDENTIAL_KEYS.some((k) => nonEmpty(env[k]));
}

/**
 * Research-dispatcher refusal predicate: the API fallback (runner's executeApi) asserts exactly
 * ANTHROPIC_API_KEY (credential-preflight.mjs assertAnthropicCredential), so an OPENAI-only
 * machine has no fallback either.
 */
export function hasAnthropicApiKey(env = process.env) {
  return Boolean(env && typeof env === 'object' && nonEmpty(env.ANTHROPIC_API_KEY));
}

// The provider-to-key map of credential-preflight.mjs (PROVIDER_REQUIRED_KEY), keyed by backend id.
export const PROVIDER_API_KEYS = Object.freeze({ anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY' });

/** One-shot refusal predicate: the key of apiBackend's provider. Unknown provider → no key (refuse). */
export function hasProviderApiKey(providerId, env = process.env) {
  const key = Object.prototype.hasOwnProperty.call(PROVIDER_API_KEYS, providerId) ? PROVIDER_API_KEYS[providerId] : null;
  return Boolean(key && env && typeof env === 'object' && nonEmpty(env[key]));
}

// ---------------------------------------------------------------------------------------------
// 2. Status file
// ---------------------------------------------------------------------------------------------

/** Exactly the seven documented keys; no credential value (or any other probe field) can reach the file. */
export function buildStatusRecord(probe, { probedAt = null, ttlMs = DEFAULT_PROBE_TTL_MS, agentsYamlDigest = null } = {}) {
  return {
    ready: probe?.ready === true,
    authMethod: typeof probe?.authMethod === 'string' ? probe.authMethod : null,
    version: typeof probe?.version === 'string' ? probe.version : null,
    reason: typeof probe?.reason === 'string' ? probe.reason : null,
    probedAt: Number.isFinite(probedAt) ? probedAt : null,
    ttlMs,
    agentsYamlDigest: typeof agentsYamlDigest === 'string' ? agentsYamlDigest : null,
  };
}

/** Informational only in this story: no consumer reads it. */
export function agentsYamlDigestFor(projectRoot) {
  try {
    const raw = fs.readFileSync(path.join(projectRoot, '.rks', 'agents.yaml'));
    return crypto.createHash('sha256').update(raw).digest('hex');
  } catch {
    return null;
  }
}

/** Write via temp file + rename, so a hook never reads a half-written file. Never throws. */
export function writeStatusFile(projectRoot, record) {
  const file = path.join(String(projectRoot ?? ''), STATUS_FILE_REL);
  let tmp = null;
  try {
    if (!projectRoot) throw new Error('projectRoot is required');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(record), 'utf8');
    fs.renameSync(tmp, file);
    return { ok: true, path: file };
  } catch (err) {
    if (tmp) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* best-effort */ }
    }
    return { ok: false, path: file, error: err?.message || String(err) };
  }
}

/**
 * Record a probe result the cache holds. Writes only when projectRoot is known and the cache
 * exposes an observed probe time (probedAt()); otherwise nothing is written, because a
 * write-time stamp would claim a freshness nobody observed. Never throws.
 */
export function recordProbeStatus({ projectRoot, probe, probeCache } = {}) {
  try {
    if (!projectRoot) return { ok: false, skipped: 'no_project_root' };
    const probedAt = typeof probeCache?.probedAt === 'function' ? probeCache.probedAt() : null;
    if (!Number.isFinite(probedAt)) return { ok: false, skipped: 'no_observed_probe_time' };
    const record = buildStatusRecord(probe, {
      probedAt,
      ttlMs: DEFAULT_PROBE_TTL_MS,
      agentsYamlDigest: agentsYamlDigestFor(projectRoot),
    });
    return writeStatusFile(projectRoot, record);
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

// ---------------------------------------------------------------------------------------------
// 3. Capability admission
// ---------------------------------------------------------------------------------------------

export const FLOWS = Object.freeze(['research', 'po', 'qa', 'arch', 'build-offrail', 'build-onrail', 'ship', 'release', 'external-research']);

/**
 * mcp__rks__ tool -> the LLM-backed agents it runs ([] = no LLM call). Kept current with
 * .rks/prompts/governor-*.md by tests/unit/governor-init-credential-capabilities.test.mjs, which
 * fails on any prompt tool this map does not classify. rks_agent_run is classified per call by
 * agentsForToolCall, not here.
 */
export const TOOL_AGENTS = Object.freeze({
  rks_governor_init: [],
  rks_agent_research: ['research'],
  rks_agent_external_research: ['external-research'],
  rks_exhaustive_search: [],
  rks_rag_embed: [],
  rks_arch_verdict: [],
  dendron_create_note: [],
  dendron_edit_note: [],
  dendron_read_note: [],
  dendron_update_field: [],
  rks_analyze: ['llm-planner'],
  rks_plan: ['llm-planner'],
  rks_refine: ['llm-planner'],
  rks_refine_apply: [],
  rks_plan_ready: [],
  rks_plan_review: ['reviewer'],
  rks_exec: ['reviewer', 'qa-agent'],
  rks_story_ship: ['reviewer'],
});

/**
 * The LLM-backed agents one prompt tool call runs, or null when the call is unclassified (which
 * the admission test treats as a failure, and admission would treat as refuse).
 *
 * rks_agent_run is classified per call. governor-qa.md calls it with `command` and no `agent`:
 * the handler (server/handlers/agent-bootstrap.mjs) looks up getAgent(undefined) and returns an
 * "Unknown agent" payload before any runAgent call, so that call runs NO LLM agent and does not
 * block QA. A call naming an agent runs that agent.
 */
export function agentsForToolCall(tool, callText = '') {
  const name = String(tool || '').replace(/^mcp__rks__/, '');
  if (name === 'rks_agent_run') {
    const text = String(callText || '');
    const agent = /\bagent\s*:\s*['"]([\w.-]+)['"]/.exec(text);
    if (agent) return [agent[1]];
    if (/\bcommand\s*:/.test(text)) return [];
    return null;
  }
  return Object.prototype.hasOwnProperty.call(TOOL_AGENTS, name) ? [...TOOL_AGENTS[name]] : null;
}

/**
 * Flow -> the LLM-backed agents it REQUIRES, in call order (the first unadmitted one is reported
 * as the blocker). External research is optional in Research and PO and is reported on its own
 * 'external-research' flow. Off-rail Build is Dispatcher-driven: research only, and its ship
 * review is advisory (D-2). A flow missing from this map is refused.
 */
export const FLOW_AGENTS = Object.freeze({
  research: Object.freeze(['research']),
  po: Object.freeze(['research']),
  qa: Object.freeze(['research']),
  arch: Object.freeze(['research']),
  'build-offrail': Object.freeze(['research']),
  'build-onrail': Object.freeze(['research', 'llm-planner', 'reviewer', 'qa-agent']),
  ship: Object.freeze([]),
  release: Object.freeze([]),
  'external-research': Object.freeze(['external-research']),
});

/**
 * Agents that can run on the subscription: research (the research dispatcher) and the four
 * claude -p one-shot callers (oneshot.mjs ONESHOT_SELECTION_KEYS values). A different list from the
 * research dispatcher's CLAUDE_CLI_SUPPORTED_AGENTS.
 */
export const SUBSCRIPTION_CAPABLE_AGENTS = Object.freeze(['research', 'llm-planner', 'reviewer', 'qa-agent', 'external-research']);

/** The one-shot agents resolveInitCredential resolves into agentBackends (agents.yaml keys). */
export const ONESHOT_AGENT_KEYS = Object.freeze(['llm-planner', 'reviewer', 'qa-agent', 'external-research']);

/**
 * { <flow>: 'admitted' | { blocked: <agent or reason> } }. Fails closed to refuse: an unknown
 * credential, an unmapped flow or any thrown error blocks.
 *
 * Under credential 'subscription' an agent is admitted only when the probe is ready, the agent is
 * in SUBSCRIPTION_CAPABLE_AGENTS, and its resolved backend is claude-cli: research reads
 * researchBackend (an agentBackends.research entry is ignored); every other agent reads
 * agentBackends[agent]. An omitted agentBackends gives no one-shot agent a backend.
 */
export function admitFlows({ credential, researchBackend = null, agentBackends = {}, probe = null, flows = FLOWS, flowAgents = FLOW_AGENTS } = {}) {
  const backends = agentBackends && typeof agentBackends === 'object' ? agentBackends : {};
  const backendOf = (agent) => (agent === 'research'
    ? researchBackend
    : (Object.prototype.hasOwnProperty.call(backends, agent) ? backends[agent] : null));
  const capabilities = {};
  for (const flow of flows) {
    try {
      const agents = Object.prototype.hasOwnProperty.call(flowAgents, flow) ? flowAgents[flow] : null;
      if (!Array.isArray(agents)) { capabilities[flow] = { blocked: 'unmapped_flow' }; continue; }
      if (credential === 'api') { capabilities[flow] = 'admitted'; continue; }
      if (credential !== 'subscription') { capabilities[flow] = { blocked: 'no_credential' }; continue; }
      const probeReady = probe?.ready === true;
      const blocker = agents.find((a) => !(probeReady && SUBSCRIPTION_CAPABLE_AGENTS.includes(a) && backendOf(a) === 'claude-cli'));
      capabilities[flow] = blocker ? { blocked: blocker } : 'admitted';
    } catch {
      capabilities[flow] = { blocked: 'admission_error' };
    }
  }
  return capabilities;
}

/**
 * Called once from rks_governor_init. With no API key and the opt-in on, probes through the
 * gate's shared probe cache (a fresh hit spawns nothing) and writes the status file, so hooks see
 * a fresh file before the first Governor's research call. Opt-in off: no probe, no file. Never
 * throws; any failure yields credential 'none' with every flow blocked.
 */
export async function resolveInitCredential({ projectRoot, env = process.env, gate = null } = {}) {
  try {
    if (hasAnyApiKey(env)) return { credential: 'api', capabilities: admitFlows({ credential: 'api' }) };
    const optInEnv = { ...(env && typeof env === 'object' ? env : {}) };
    if (projectRoot) optInEnv.CLAUDE_PROJECT_DIR = projectRoot;
    else delete optInEnv.CLAUDE_PROJECT_DIR;
    if (!projectRoot || !isSubscriptionOptInOn(optInEnv)) {
      return { credential: 'none', capabilities: admitFlows({ credential: 'none' }) };
    }
    const g = gate || getDefaultClaudeCliGate();
    const probe = await g.probeCache.get({ parentEnv: env });
    const record = buildStatusRecord(probe, {
      probedAt: typeof g.probeCache.probedAt === 'function' ? g.probeCache.probedAt() : null,
      ttlMs: DEFAULT_PROBE_TTL_MS,
      agentsYamlDigest: agentsYamlDigestFor(projectRoot),
    });
    const statusFile = writeStatusFile(projectRoot, record);
    const researchBackend = resolveAgentBackend('research', projectRoot);
    const agentBackends = Object.fromEntries(ONESHOT_AGENT_KEYS.map((k) => [k, resolveAgentBackend(k, projectRoot)]));
    return {
      credential: 'subscription',
      capabilities: admitFlows({ credential: 'subscription', researchBackend, agentBackends, probe }),
      subscription: { ready: record.ready, reason: record.reason, researchBackend },
      statusFile,
    };
  } catch (err) {
    return { credential: 'none', capabilities: admitFlows({ credential: null }), error: err?.message || String(err) };
  }
}

// ---------------------------------------------------------------------------------------------
// 4. Structured no-API-key refusal (D-3)
// ---------------------------------------------------------------------------------------------

const VERSION_REASONS = new Set(['version_failed', 'version_unparseable', 'version_too_old']);

/** The fix, named for the probe reason (or the transport cause when no probe failed). */
export function subscriptionFixHint({ cause, probeReason } = {}) {
  if (probeReason === 'binary_not_found') {
    return `install Claude Code CLI ${MIN_CLAUDE_VERSION} or later, then run \`claude /login\` with a claude.ai account`;
  }
  if (VERSION_REASONS.has(probeReason)) return `upgrade Claude Code CLI to ${MIN_CLAUDE_VERSION} or later`;
  if (probeReason) return `run \`claude /login\` with a claude.ai subscription account (Claude Code CLI ${MIN_CLAUDE_VERSION} or later)`;
  if (cause === 'rate_limit' || cause === 'cooldown') return 'wait for the subscription rate limit to reset, then retry';
  if (cause === 'busy') return 'retry when the running claude -p calls finish';
  if (cause === 'auth') return 'run `claude /login` with a claude.ai subscription account';
  return 'retry, or check `claude auth status`';
}

/**
 * The structured refusal a claude -p path returns when it cannot run and there is no API key to
 * fall back to. fallback is always 'none': nothing was sent to an API.
 */
export function buildSubscriptionRefusal({ subject, cause, probeReason = null, detail = null, retryAfter = null, keyName = 'ANTHROPIC_API_KEY' } = {}) {
  const what = subject || 'claude-cli';
  const probePart = probeReason ? ` (probe: ${probeReason})` : '';
  const message = `${what} could not run on the Claude subscription: ${cause}${probePart}. No ${keyName} is set, so there is no API fallback and nothing was sent to an API. Fix: ${subscriptionFixHint({ cause, probeReason })}, or set ${keyName}.`;
  return {
    ok: false,
    reason: SUBSCRIPTION_REFUSAL_REASON,
    cause,
    ...(probeReason ? { probeReason } : {}),
    ...(detail && detail !== probeReason ? { detail } : {}),
    fallback: 'none',
    ...(retryAfter ? { retryAfter } : {}),
    error: message,
    message,
    backendRefused: { from: 'claude-cli', reason: cause, ...(probeReason ? { probeReason } : {}) },
  };
}

/** ISO time the gate's cool-down ends, or null when not cooling down. */
export function retryAfterFor(gate) {
  try {
    if (!gate?.inCooldown?.()) return null;
    const until = gate.state?.().cooldownUntil;
    return Number.isFinite(until) ? new Date(until).toISOString() : null;
  } catch {
    return null;
  }
}
