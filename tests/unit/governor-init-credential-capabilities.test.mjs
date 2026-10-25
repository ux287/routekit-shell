/**
 * backlog.feat.keyless-backend-aware-credential-presence - AC1 (init-time probe), AC6.
 * Capability admission fails closed to REFUSE. The probe cache and env are injected; no claude
 * binary, no subprocess, no network. Status files land under per-case os.tmpdir() roots.
 * The rks_governor_init handler wiring (one call, payload fields) is covered in
 * tests/unit/server-handler-governance.test.mjs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FLOWS, FLOW_AGENTS, TOOL_AGENTS, STATUS_FILE_REL, SUBSCRIPTION_CAPABLE_AGENTS,
  hasAnyApiKey, hasAnthropicApiKey, admitFlows, agentsForToolCall, resolveInitCredential,
  classifyBootDotenvCopied, recordBootDotenvCopied, resetBootDotenvCopied, isBootDotenvCopied,
  serverOptInOn, serverEnvOptInValue, BOOT_PROVENANCE_KEYS,
} from '../../packages/mcp-rks/src/llm/claude-cli/subscription-status.mjs';
import { readSubscriptionStatusState, hasLlmCredential, isSubscriptionOptInOn } from '../../packages/hooks/system/credential-presence.mjs';
import { getDefaultClaudeCliGate, resetDefaultClaudeCliGate } from '../../packages/mcp-rks/src/llm/claude-cli/gate.mjs';
import { generateAgentToolDefinitions, getAgentByToolName } from '../../packages/mcp-rks/src/agents/registry.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PROMPTS_DIR = path.join(REPO_ROOT, '.rks', 'prompts');
const READY = Object.freeze({ ready: true, authMethod: 'claude.ai', version: '2.1.302', reason: null });
const NOT_READY = Object.freeze({ ready: false, authMethod: null, version: null, reason: 'binary_not_found' });
const SUBSCRIPTION_ADMITTED = ['research', 'po', 'qa', 'arch', 'build-offrail', 'ship', 'release'];
const RESEARCH_FLOWS = ['research', 'po', 'qa', 'arch', 'build-offrail', 'build-onrail'];

const roots = [];
function tmpRoot({ researchBackend = 'claude-cli', dotenv = null, oneShotAgents = [] } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rks-init-cred-')));
  roots.push(root);
  fs.mkdirSync(path.join(root, '.rks'), { recursive: true });
  const oneShot = oneShotAgents.map((a) => `  ${a}:\n    backend: claude-cli\n`).join('');
  if (researchBackend || oneShot) {
    const research = researchBackend ? `  research:\n    backend: ${researchBackend}\n` : '';
    fs.writeFileSync(path.join(root, '.rks', 'agents.yaml'), `agents:\n${research}${oneShot}`);
  }
  if (dotenv !== null) fs.writeFileSync(path.join(root, '.env'), dotenv);
  return root;
}
/** A fake gate: probeCache.get resolves (or rejects) and probedAt() reports a fixed observed time. */
function fakeGate({ result = READY, rejects = false, observedAt = Date.now() - 1_000 } = {}) {
  const probeCache = {
    get: vi.fn(async () => { if (rejects) throw new Error('probe exploded'); return result; }),
    probedAt: vi.fn(() => observedAt),
    invalidate: vi.fn(),
  };
  return { probeCache, observedAt };
}

beforeEach(() => {
  vi.stubEnv('RKS_RESEARCH_BACKEND', ''); // resolveAgentBackend reads it before agents.yaml
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  while (roots.length) fs.rmSync(roots.pop(), { recursive: true, force: true });
});

describe('API-key-only predicates (AC6)', () => {
  it('hasAnyApiKey: either recognized key alone is true; {}, empty strings, null and a non-object are false', () => {
    expect(hasAnyApiKey({ ANTHROPIC_API_KEY: 'sk-a' })).toBe(true);
    expect(hasAnyApiKey({ OPENAI_API_KEY: 'sk-o' })).toBe(true);
    for (const bad of [{}, { ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '' }, { ANTHROPIC_API_KEY: '   ' }, null, 'sk-a', 42]) {
      expect(hasAnyApiKey(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it('hasAnthropicApiKey: false for an OPENAI-only env, true for a non-empty ANTHROPIC_API_KEY', () => {
    expect(hasAnthropicApiKey({ OPENAI_API_KEY: 'sk-o' })).toBe(false);
    expect(hasAnthropicApiKey({ ANTHROPIC_API_KEY: 'sk-a' })).toBe(true);
    expect(hasAnthropicApiKey({})).toBe(false);
    expect(hasAnthropicApiKey(null)).toBe(false);
  });

  it('neither predicate reads any file, even with an opted-in fresh status file named by CLAUDE_PROJECT_DIR', () => {
    const root = tmpRoot();
    fs.mkdirSync(path.join(root, '.rks', 'state'), { recursive: true });
    fs.writeFileSync(path.join(root, STATUS_FILE_REL), JSON.stringify({ ...READY, probedAt: Date.now(), ttlMs: 600_000, agentsYamlDigest: null }));
    fs.writeFileSync(path.join(root, '.env'), 'ANTHROPIC_API_KEY=sk-from-dotenv\n');
    const spy = vi.spyOn(fs, 'readFileSync');
    const env = { CLAUDE_PROJECT_DIR: root, RKS_SUBSCRIPTION_CREDENTIAL: '1' };
    expect(hasAnyApiKey(env)).toBe(false);
    expect(hasAnthropicApiKey(env)).toBe(false);
    expect(spy).not.toHaveBeenCalled();
    // Positive control: the posture predicate does read and says credentialed.
    expect(hasLlmCredential(env)).toBe(true);
    expect(spy).toHaveBeenCalled();
  });
});

describe('capability admission (AC6)', () => {
  it('subscription + claude-cli research + ready probe: listed flows admitted, on-rail Build blocked llm-planner, external research blocked', () => {
    const caps = admitFlows({ credential: 'subscription', researchBackend: 'claude-cli', probe: READY });
    for (const flow of SUBSCRIPTION_ADMITTED) expect(caps[flow], flow).toBe('admitted');
    expect(caps['build-onrail']).toEqual({ blocked: 'llm-planner' });
    expect(caps['external-research']).toEqual({ blocked: expect.any(String) });
    expect(Object.keys(caps).sort()).toEqual([...FLOWS].sort());
  });

  it('credential api admits every flow in FLOWS', () => {
    const caps = admitFlows({ credential: 'api' });
    for (const flow of FLOWS) expect(caps[flow], flow).toBe('admitted');
  });

  it('credential none, null or an unknown string blocks every flow', () => {
    for (const credential of ['none', null, undefined, 'bogus']) {
      const caps = admitFlows({ credential, researchBackend: 'claude-cli', probe: READY });
      for (const flow of FLOWS) expect(caps[flow], `${credential}/${flow}`).toEqual({ blocked: expect.any(String) });
    }
  });

  it('subscription with a non-claude-cli research backend, a not-ready probe or no probe blocks every flow that calls research', () => {
    for (const [label, args] of [
      ['anthropic backend', { researchBackend: 'anthropic', probe: READY }],
      ['null backend', { researchBackend: null, probe: READY }],
      ['not-ready probe', { researchBackend: 'claude-cli', probe: NOT_READY }],
      ['missing probe', { researchBackend: 'claude-cli', probe: null }],
    ]) {
      const caps = admitFlows({ credential: 'subscription', ...args });
      for (const flow of RESEARCH_FLOWS) expect(caps[flow], `${label}/${flow}`).toEqual({ blocked: 'research' });
      // Ship is admitted because governor-ship.md calls only []-classified deterministic tools
      // (rks_git_state, rks_git_commit, rks_git_push, rks_staging_pr, rks_git_merge,
      // rks_cycle_complete, rks_project_get), so FLOW_AGENTS.ship is [] and no probe is needed.
      expect(caps.ship, label).toBe('admitted');
    }
  });

  it('a flow absent from FLOW_AGENTS is blocked, even with an API key (fail closed to refuse)', () => {
    const caps = admitFlows({ credential: 'api', flows: [...FLOWS, 'mystery-flow'] });
    expect(caps['mystery-flow']).toEqual({ blocked: expect.any(String) });
    const throwing = admitFlows({ credential: 'subscription', researchBackend: 'claude-cli', probe: READY, flows: ['qa'], flowAgents: { get qa() { throw new Error('boom'); } } });
    expect(throwing.qa).toEqual({ blocked: expect.any(String) });
  });

  it('every flow in FLOWS has a FLOW_AGENTS entry', () => {
    for (const flow of FLOWS) expect(Array.isArray(FLOW_AGENTS[flow]), flow).toBe(true);
  });
});

// backlog.feat.oneshot-callers-keyless-reachable (AC6, AC7): per-agent backend admission.
describe('build-onrail admission with per-agent backends (AC6)', () => {
  const ALL_CLI = Object.freeze({ 'llm-planner': 'claude-cli', reviewer: 'claude-cli', 'qa-agent': 'claude-cli' });
  const sub = (extra) => admitFlows({ credential: 'subscription', researchBackend: 'claude-cli', probe: READY, ...extra });

  it('the build-onrail agents, TOOL_AGENTS entries and SUBSCRIPTION_CAPABLE_AGENTS are listed as specified', () => {
    expect(FLOW_AGENTS['build-onrail']).toEqual(['research', 'llm-planner', 'reviewer', 'qa-agent']);
    expect(TOOL_AGENTS.rks_exec).toEqual(['reviewer', 'qa-agent']);
    expect(TOOL_AGENTS.rks_story_ship).toEqual(['reviewer']);
    expect([...SUBSCRIPTION_CAPABLE_AGENTS].sort()).toEqual(['external-research', 'llm-planner', 'qa-agent', 'research', 'reviewer']);
    expect(FLOW_AGENTS.ship).toEqual([]);
    expect(FLOW_AGENTS.release).toEqual([]);
    // Every agent build-onrail requires is classified on a tool the Build prompt calls.
    const classified = new Set(Object.values(TOOL_AGENTS).flat());
    for (const agent of FLOW_AGENTS['build-onrail']) expect(classified.has(agent), agent).toBe(true);
  });

  it('subscription + ready probe + claude-cli research + llm-planner, reviewer and qa-agent on claude-cli admits build-onrail', () => {
    const caps = sub({ agentBackends: { ...ALL_CLI } });
    expect(caps['build-onrail']).toBe('admitted');
    for (const flow of SUBSCRIPTION_ADMITTED) expect(caps[flow], flow).toBe('admitted');
    expect(caps['external-research']).toEqual({ blocked: 'external-research' });
  });

  it('one build-onrail agent not on claude-cli (or absent) blocks it naming that agent; several name the first in FLOW_AGENTS order', () => {
    for (const agent of ['llm-planner', 'reviewer', 'qa-agent']) {
      expect(sub({ agentBackends: { ...ALL_CLI, [agent]: 'anthropic' } })['build-onrail'], `${agent} anthropic`).toEqual({ blocked: agent });
      const absent = { ...ALL_CLI };
      delete absent[agent];
      expect(sub({ agentBackends: absent })['build-onrail'], `${agent} absent`).toEqual({ blocked: agent });
    }
    expect(sub({ agentBackends: { 'llm-planner': 'claude-cli', reviewer: 'anthropic', 'qa-agent': 'anthropic' } })['build-onrail'])
      .toEqual({ blocked: 'reviewer' });
    expect(sub({ agentBackends: { 'llm-planner': 'anthropic', reviewer: 'anthropic', 'qa-agent': 'claude-cli' } })['build-onrail'])
      .toEqual({ blocked: 'llm-planner' });
  });

  it('a not-ready or missing probe blocks build-onrail on research; an agentBackends.research entry is ignored', () => {
    for (const probe of [NOT_READY, null]) {
      const caps = admitFlows({ credential: 'subscription', researchBackend: 'claude-cli', probe, agentBackends: { ...ALL_CLI, 'external-research': 'claude-cli' } });
      expect(caps['build-onrail']).toEqual({ blocked: 'research' });
      expect(caps['external-research']).toEqual({ blocked: 'external-research' });
    }
    const ignored = admitFlows({ credential: 'subscription', researchBackend: 'anthropic', probe: READY, agentBackends: { ...ALL_CLI, research: 'claude-cli' } });
    expect(ignored['build-onrail']).toEqual({ blocked: 'research' });
  });

  it('external-research is admitted only when agentBackends sets it to claude-cli on a ready probe', () => {
    expect(sub({ agentBackends: { 'external-research': 'claude-cli' } })['external-research']).toBe('admitted');
    expect(sub({ agentBackends: { 'external-research': 'anthropic' } })['external-research']).toEqual({ blocked: 'external-research' });
    expect(sub({})['external-research']).toEqual({ blocked: 'external-research' });
  });

  it('AC7: the existing call shape still blocks build-onrail on llm-planner, and credential api admits every flow', () => {
    const caps = admitFlows({ credential: 'subscription', researchBackend: 'claude-cli', probe: READY });
    expect(caps['build-onrail']).toEqual({ blocked: 'llm-planner' });
    for (const flow of SUBSCRIPTION_ADMITTED) expect(caps[flow], flow).toBe('admitted');
    const api = admitFlows({ credential: 'api', agentBackends: {} });
    for (const flow of FLOWS) expect(api[flow], flow).toBe('admitted');
  });
});

describe('the flow-to-tool map is kept current with .rks/prompts/governor-*.md (AC6)', () => {
  // Prompt file -> admission flow. governor-agent.md is the ops agent prompt (no admission flow);
  // it must call no LLM-backed rks tool.
  const PROMPT_FLOWS = {
    'governor-research.md': 'research',
    'governor-po.md': 'po',
    'governor-qa.md': 'qa',
    'governor-arch.md': 'arch',
    'governor-build.md': 'build-onrail',
    'governor-ship.md': 'ship',
    'governor-agent.md': null,
  };
  const promptFiles = () => fs.readdirSync(PROMPTS_DIR).filter((f) => /^governor-.*\.md$/.test(f)).sort();
  // backlog.fix.ship-flow-deterministic-no-llm (AC5): besides mcp__rks__ tokens, extract unprefixed
  // call tokens `rks_x(` / `dendron_x(`. The open paren must follow the token DIRECTLY, so list
  // mentions (`- rks_agent_git`, `  - rks_agent_run (Path 1 only)`) and prohibitions
  // (`Do NOT call rks_agent_run, ...`) are not calls. The word boundary keeps the tail of a
  // mcp__rks__rks_x token from being extracted twice.
  const extractCalls = (text) => {
    const calls = [];
    for (const line of String(text).split('\n')) {
      for (const m of line.matchAll(/mcp__rks__([a-z_]+)/g)) calls.push({ tool: m[1], line });
      for (const m of line.matchAll(/\b(rks_[a-z_]+|dendron_[a-z_]+)\(/g)) calls.push({ tool: m[1], line });
    }
    return calls;
  };
  const toolCalls = (file) => extractCalls(fs.readFileSync(path.join(PROMPTS_DIR, file), 'utf8'));
  // Pure scan: (prompt text, flow) -> violations. A violation is an unclassified tool, or an agent
  // the flow's FLOW_AGENTS does not account for.
  const scanPrompt = (text, flow, flowAgents = FLOW_AGENTS) => {
    const violations = [];
    for (const { tool, line } of extractCalls(text)) {
      const agents = agentsForToolCall(tool, line);
      if (agents === null) { violations.push({ flow, tool, agent: null, line }); continue; }
      for (const agent of agents) {
        const owner = agent === 'external-research' ? 'external-research' : flow;
        if (flow === null || !(flowAgents[owner] || []).includes(agent)) violations.push({ flow, tool, agent, line });
      }
    }
    return violations;
  };

  it('every governor prompt is mapped, and every mcp__rks__ tool it names is classified and accounted for by its flow', () => {
    const files = promptFiles();
    expect(files.length).toBeGreaterThan(0);
    let classified = 0;
    for (const file of files) {
      expect(Object.prototype.hasOwnProperty.call(PROMPT_FLOWS, file), `${file} has no flow mapping`).toBe(true);
      const flow = PROMPT_FLOWS[file];
      for (const { tool, line } of toolCalls(file)) {
        const agents = agentsForToolCall(tool, line);
        expect(agents, `${file}: unclassified LLM-backed tool ${tool}`).not.toBeNull();
        classified++;
        for (const agent of agents) {
          if (flow === null) throw new Error(`${file} (no admission flow) calls LLM-backed ${tool} -> ${agent}`);
          if (agent === 'external-research') {
            expect(FLOW_AGENTS['external-research'], `${file}: ${tool}`).toContain(agent);
          } else {
            expect(FLOW_AGENTS[flow], `${file} (${flow}) calls ${tool} -> ${agent}`).toContain(agent);
          }
        }
      }
    }
    expect(classified).toBeGreaterThan(10); // positive control: real prompt calls were parsed
  });

  it('governor-qa.md rks_agent_run (command, no agent) is classified explicitly as running no agent, and QA stays admitted', () => {
    const calls = toolCalls('governor-qa.md').filter((c) => c.tool === 'rks_agent_run');
    expect(calls).toHaveLength(1);
    expect(calls[0].line).toMatch(/command:/);
    expect(calls[0].line).not.toMatch(/\bagent\s*:/);
    expect(agentsForToolCall('rks_agent_run', calls[0].line)).toEqual([]);
    // The map has no blanket rks_agent_run entry: an agent-naming call runs that agent, a bare one is unclassified.
    expect(Object.prototype.hasOwnProperty.call(TOOL_AGENTS, 'rks_agent_run')).toBe(false);
    expect(agentsForToolCall('rks_agent_run', "({ agent: 'product-owner', input: {} })")).toEqual(['product-owner']);
    expect(agentsForToolCall('rks_agent_run', '({ projectId })')).toBeNull();
    expect(admitFlows({ credential: 'subscription', researchBackend: 'claude-cli', probe: READY }).qa).toBe('admitted');
  });

  it('AC5: the extractor ignores list mentions and prohibitions', () => {
    for (const line of [
      '  - rks_agent_git',
      '  - rks_agent_run (Path 1 only)',
      '- rks_agent_git — git operations, branch management, commit, push, PR creation',
      'Do NOT call rks_agent_run, rks_plan, rks_exec',
    ]) {
      expect(extractCalls(line), line).toEqual([]);
    }
    // The governor-qa.md list line is verbatim in the real prompt, and is still not a call.
    expect(fs.readFileSync(path.join(PROMPTS_DIR, 'governor-qa.md'), 'utf8').split('\n')).toContain('  - rks_agent_run (Path 1 only)');
  });

  it('AC5 negative control: a synthetic rks_agent_git( call under ship is reported as a violation naming git', () => {
    const violations = scanPrompt('Call rks_agent_git( projectId )', 'ship');
    expect(violations.length).toBeGreaterThan(0);
    expect(violations).toContainEqual(expect.objectContaining({ flow: 'ship', tool: 'rks_agent_git', agent: 'git' }));
  });

  it('AC5 original-bug witness: the pre-fix governor-ship.md lines (anchor a7a255fd2) need git; the old mcp__rks__ scan was blind', () => {
    // Verbatim governor-ship.md:45 and :75 at a7a255fd2.
    const PRE_FIX = [
      "0.5. **git state** — Call rks_agent_git({ projectId, request: 'Show current git status', _governorToken })",
      "   - Call rks_agent_git({ projectId, request: 'merge current feature branch into <working branch> and delete the feature branch', _governorToken })",
    ].join('\n');
    const tools = extractCalls(PRE_FIX).map((c) => c.tool);
    expect(tools).toEqual(['rks_agent_git', 'rks_agent_git']);
    expect(agentsForToolCall('rks_agent_git')).toEqual(['git']);
    const needs = scanPrompt(PRE_FIX, 'ship');
    expect(needs.map((v) => v.agent)).toEqual(['git', 'git']);
    expect(needs.every((v) => v.flow === 'ship')).toBe(true);
    expect([...PRE_FIX.matchAll(/mcp__rks__([a-z_]+)/g)]).toHaveLength(0);
  });

  it('AC5 post-fix: governor-ship.md extracts only []-classified tools and ship is admitted subscription-only', () => {
    const calls = toolCalls('governor-ship.md');
    const tools = new Set(calls.map((c) => c.tool));
    expect(tools.has('rks_git_commit')).toBe(true);
    expect(tools.has('rks_project_get')).toBe(true);
    for (const { tool, line } of calls) expect(agentsForToolCall(tool, line), tool).toEqual([]);
    expect(scanPrompt(fs.readFileSync(path.join(PROMPTS_DIR, 'governor-ship.md'), 'utf8'), 'ship')).toEqual([]);
    expect(admitFlows({ credential: 'subscription', researchBackend: 'claude-cli', probe: READY }).ship).toBe('admitted');
  });
});

describe('TOOL_AGENTS classification (backlog.fix.ship-flow-deterministic-no-llm AC4)', () => {
  it('classifies every registry agent tool by the registry agent it runs', () => {
    const registryTools = generateAgentToolDefinitions().map((t) => t.name).filter((n) => n !== 'rks_agent_run');
    expect(registryTools.length).toBeGreaterThan(0);
    let classified = 0;
    for (const toolName of registryTools) {
      const entry = getAgentByToolName(toolName);
      expect(entry, toolName).not.toBeNull();
      expect(TOOL_AGENTS[toolName], toolName).toEqual([entry.name]);
      classified++;
    }
    expect(classified).toBe(registryTools.length);
    expect(TOOL_AGENTS.rks_agent_git).toEqual(['git']);
  });

  it('maps the deterministic git / ship / project tools to []', () => {
    for (const tool of ['rks_git_state', 'rks_git_commit', 'rks_git_push', 'rks_git_merge', 'rks_staging_pr', 'rks_staging_merge', 'rks_cycle_complete', 'rks_project_get', 'rks_release']) {
      expect(TOOL_AGENTS[tool], tool).toEqual([]);
    }
    expect(Object.prototype.hasOwnProperty.call(TOOL_AGENTS, 'rks_agent_run')).toBe(false);
  });
});

describe('resolveInitCredential (AC1, AC6)', () => {
  it('with an API key: credential api, every flow admitted, no probe', async () => {
    const gate = fakeGate();
    const res = await resolveInitCredential({ projectRoot: tmpRoot(), env: { OPENAI_API_KEY: 'sk-o', RKS_SUBSCRIPTION_CREDENTIAL: '1' }, gate });
    expect(res.credential).toBe('api');
    for (const flow of FLOWS) expect(res.capabilities[flow]).toBe('admitted');
    expect(gate.probeCache.get).not.toHaveBeenCalled();
  });

  it('no key, opt-in on from env: probes once and writes a status file stamped with the cache probedAt(), fresh on return', async () => {
    const root = tmpRoot();
    const gate = fakeGate();
    const env = { RKS_SUBSCRIPTION_CREDENTIAL: '1' };
    const res = await resolveInitCredential({ projectRoot: root, env, gate });
    expect(gate.probeCache.get).toHaveBeenCalledTimes(1);
    expect(gate.probeCache.get).toHaveBeenCalledWith({ parentEnv: env });
    expect(res.credential).toBe('subscription');
    for (const flow of SUBSCRIPTION_ADMITTED) expect(res.capabilities[flow], flow).toBe('admitted');
    expect(res.capabilities['build-onrail']).toEqual({ blocked: 'llm-planner' });
    const rec = JSON.parse(fs.readFileSync(path.join(root, STATUS_FILE_REL), 'utf8'));
    expect(rec.probedAt).toBe(gate.observedAt); // observed, not the write time
    expect(readSubscriptionStatusState(root)).toBe('ready');
    expect(hasLlmCredential({ CLAUDE_PROJECT_DIR: root, RKS_SUBSCRIPTION_CREDENTIAL: '1' })).toBe(true);
  });

  it('no key, opt-in only in projectRoot/.env: probes once and writes the file', async () => {
    const root = tmpRoot({ dotenv: 'RKS_SUBSCRIPTION_CREDENTIAL=1\n' });
    const gate = fakeGate();
    const res = await resolveInitCredential({ projectRoot: root, env: {}, gate });
    expect(gate.probeCache.get).toHaveBeenCalledTimes(1);
    expect(res.credential).toBe('subscription');
    expect(fs.existsSync(path.join(root, STATUS_FILE_REL))).toBe(true);
  });

  it('no key, opt-in off (absent or malformed): no probe, no file, credential none with every flow blocked', async () => {
    for (const env of [{}, { RKS_SUBSCRIPTION_CREDENTIAL: 'true' }, { RKS_SUBSCRIPTION_CREDENTIAL: '0' }]) {
      const root = tmpRoot();
      const gate = fakeGate();
      const res = await resolveInitCredential({ projectRoot: root, env, gate });
      expect(gate.probeCache.get).not.toHaveBeenCalled();
      expect(fs.existsSync(path.join(root, '.rks', 'state'))).toBe(false);
      expect(res.credential).toBe('none');
      for (const flow of FLOWS) expect(res.capabilities[flow]).toEqual({ blocked: expect.any(String) });
    }
  });

  it('a rejecting probeCache.get yields credential none with every flow blocked, and does not throw', async () => {
    const gate = fakeGate({ rejects: true });
    const res = await resolveInitCredential({ projectRoot: tmpRoot(), env: { RKS_SUBSCRIPTION_CREDENTIAL: '1' }, gate });
    expect(res.credential).toBe('none');
    for (const flow of FLOWS) expect(res.capabilities[flow]).toEqual({ blocked: expect.any(String) });
  });

  it('a fresh ready subscription status file with no API key never yields credential api', async () => {
    const root = tmpRoot();
    fs.mkdirSync(path.join(root, '.rks', 'state'), { recursive: true });
    fs.writeFileSync(path.join(root, STATUS_FILE_REL), JSON.stringify({ ...READY, probedAt: Date.now(), ttlMs: 600_000, agentsYamlDigest: null }));
    const off = await resolveInitCredential({ projectRoot: root, env: { CLAUDE_PROJECT_DIR: root }, gate: fakeGate() });
    expect(off.credential).toBe('none');
    const on = await resolveInitCredential({ projectRoot: root, env: { RKS_SUBSCRIPTION_CREDENTIAL: '1' }, gate: fakeGate() });
    expect(on.credential).toBe('subscription');
  });

  it('no key, opt-in on, ready gate, agents.yaml with research, llm-planner, reviewer and qa-agent on claude-cli: build-onrail admitted (AC6)', async () => {
    const root = tmpRoot({ oneShotAgents: ['llm-planner', 'reviewer', 'qa-agent'] });
    const res = await resolveInitCredential({ projectRoot: root, env: { RKS_SUBSCRIPTION_CREDENTIAL: '1' }, gate: fakeGate() });
    expect(res.credential).toBe('subscription');
    expect(res.capabilities['build-onrail']).toBe('admitted');
    expect(res.capabilities['external-research']).toEqual({ blocked: 'external-research' });
    const withEr = tmpRoot({ oneShotAgents: ['llm-planner', 'reviewer', 'qa-agent', 'external-research'] });
    const er = await resolveInitCredential({ projectRoot: withEr, env: { RKS_SUBSCRIPTION_CREDENTIAL: '1' }, gate: fakeGate() });
    expect(er.capabilities['external-research']).toBe('admitted');
  });

  it('no key, opt-in on, ready gate, only research on claude-cli: build-onrail stays blocked llm-planner (AC6)', async () => {
    const res = await resolveInitCredential({ projectRoot: tmpRoot(), env: { RKS_SUBSCRIPTION_CREDENTIAL: '1' }, gate: fakeGate() });
    expect(res.credential).toBe('subscription');
    expect(res.capabilities['build-onrail']).toEqual({ blocked: 'llm-planner' });
  });

  it('a not-ready probe with the opt-in on reports subscription with research flows blocked and a not-ready file', async () => {
    const root = tmpRoot();
    const res = await resolveInitCredential({ projectRoot: root, env: { RKS_SUBSCRIPTION_CREDENTIAL: '1' }, gate: fakeGate({ result: NOT_READY }) });
    expect(res.credential).toBe('subscription');
    for (const flow of RESEARCH_FLOWS) expect(res.capabilities[flow]).toEqual({ blocked: 'research' });
    expect(readSubscriptionStatusState(root)).toBe('not_ready');
  });
});

// ---------------------------------------------------------------------------------------------
// backlog.fix.subscription-opt-in-read-consistency: the server reads the opt-in as the hooks do.
// "Boot dotenv copy" is simulated in-process: process.env holds the value AND the boot seam
// (recordBootDotenvCopied) records it, exactly what bin/mcp-rks.mjs does after its dotenv loads.
// No subprocess is spawned: the default gate's probe cache is replaced with a fake.
// ---------------------------------------------------------------------------------------------
describe('subscription opt-in read consistency (backlog.fix.subscription-opt-in-read-consistency)', () => {
  const KEY = 'RKS_SUBSCRIPTION_CREDENTIAL';
  let savedOptIn;
  let hadOptIn;

  /** Set (or with undefined, delete) the opt-in in process.env; restored in afterEach. */
  const setProcessOptIn = (value) => {
    if (value === undefined) delete process.env[KEY];
    else process.env[KEY] = value;
  };
  /** The boot dotenv load copied `value` into process.env. */
  const bootCopied = (value) => { setProcessOptIn(value); recordBootDotenvCopied({ [KEY]: value }); };
  /** Replace the default gate's probe with a fake so a { projectRoot }-only call spawns nothing. */
  const stubDefaultGate = (result = READY) => {
    resetDefaultClaudeCliGate();
    const g = getDefaultClaudeCliGate();
    g.probeCache.get = vi.fn(async () => result);
    g.probeCache.probedAt = vi.fn(() => Date.now() - 1_000);
    return g;
  };
  /** The hook's verdict for the project dir, given the env the hook process sees. */
  const hookVerdict = (root, hookEnv) => isSubscriptionOptInOn({ ...hookEnv, CLAUDE_PROJECT_DIR: root });
  const writeDotenv = (root, cell) => {
    if (cell === 'absent') return;
    if (cell === 'unparseable') { fs.mkdirSync(path.join(root, '.env')); return; } // a directory: ambiguous
    fs.writeFileSync(path.join(root, '.env'), `${KEY}=${cell}\n`);
  };

  beforeEach(() => {
    hadOptIn = Object.prototype.hasOwnProperty.call(process.env, KEY);
    savedOptIn = process.env[KEY];
    delete process.env[KEY];
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('OPENAI_API_KEY', '');
    resetBootDotenvCopied();
    stubDefaultGate();
  });
  afterEach(() => {
    vi.unstubAllEnvs(); // first, so the original opt-in restore below is the last word
    resetBootDotenvCopied();
    resetDefaultClaudeCliGate();
    if (hadOptIn) process.env[KEY] = savedOptIn;
    else delete process.env[KEY];
  });

  describe('boot provenance seam', () => {
    it('classification: absent before both dotenv loads and present after is dotenv-copied; present before is not', () => {
      expect(BOOT_PROVENANCE_KEYS).toEqual([KEY]);
      expect(classifyBootDotenvCopied([], { [KEY]: '1' })).toEqual({ [KEY]: '1' });
      expect(classifyBootDotenvCopied([], { [KEY]: '0' })).toEqual({ [KEY]: '0' });
      expect(classifyBootDotenvCopied([KEY], { [KEY]: '1' })).toEqual({});
      expect(classifyBootDotenvCopied(new Set([KEY]), { [KEY]: '1' })).toEqual({});
      expect(classifyBootDotenvCopied([], {})).toEqual({});
      // Only the opt-in key is classified; credential keys keep their own provenance path.
      expect(classifyBootDotenvCopied([], { ANTHROPIC_API_KEY: 'sk-a', [KEY]: '1' })).toEqual({ [KEY]: '1' });
    });

    it('record and reset: a recorded copy is discounted only while process.env still holds it', () => {
      expect(isBootDotenvCopied(KEY)).toBe(false);
      bootCopied('1');
      expect(isBootDotenvCopied(KEY)).toBe(true);
      expect(serverEnvOptInValue(process.env)).toBeUndefined();
      expect(serverEnvOptInValue({ [KEY]: '1' })).toBe('1'); // any other env object is as-is
      process.env[KEY] = '0'; // changed after boot: no longer the copy
      expect(isBootDotenvCopied(KEY)).toBe(false);
      process.env[KEY] = '1';
      resetBootDotenvCopied();
      expect(isBootDotenvCopied(KEY)).toBe(false);
      expect(serverEnvOptInValue(process.env)).toBe('1');
    });
  });

  it('AC1: a boot-copied =1 from the project .env stops counting once that .env drops the key or sets 0, with no reload', async () => {
    for (const edited of [null, `${KEY}=0\n`]) {
      const root = tmpRoot({ dotenv: `${KEY}=1\n` });
      bootCopied('1');
      const before = await resolveInitCredential({ projectRoot: root, gate: fakeGate() });
      expect(before.credential).toBe('subscription');
      expect(before.subscription.ready).toBe(true);
      fs.writeFileSync(path.join(root, '.env'), edited === null ? 'OTHER=x\n' : edited);
      const after = await resolveInitCredential({ projectRoot: root, gate: fakeGate() });
      expect(after.credential, String(edited)).toBe('none');
      // projectRoot-only parity (the governance.mjs / onboarder / rks_preflight shape)
      expect((await resolveInitCredential({ projectRoot: root })).credential).toBe(after.credential);
      resetBootDotenvCopied();
    }
  });

  it('AC1 reverse: boot copy absent or 0, project .env later edited to 1: the next call is subscription', async () => {
    for (const bootValue of [undefined, '0']) {
      const root = tmpRoot({ dotenv: bootValue === undefined ? null : `${KEY}=0\n` });
      if (bootValue === undefined) setProcessOptIn(undefined);
      else bootCopied(bootValue);
      const before = await resolveInitCredential({ projectRoot: root, gate: fakeGate() });
      expect(before.credential).toBe('none');
      fs.writeFileSync(path.join(root, '.env'), `${KEY}=1\n`);
      const after = await resolveInitCredential({ projectRoot: root, gate: fakeGate() });
      expect(after.credential, String(bootValue)).toBe('subscription');
      expect((await resolveInitCredential({ projectRoot: root })).credential).toBe('subscription');
      resetBootDotenvCopied();
    }
  });

  it('AC2: a shell-set value (not recorded as copied) is honored; a non-1 shell value wins over a project .env 1', async () => {
    const onRoot = tmpRoot();
    setProcessOptIn('1');
    const on = await resolveInitCredential({ projectRoot: onRoot, gate: fakeGate() });
    expect(on.credential).toBe('subscription');
    expect((await resolveInitCredential({ projectRoot: onRoot })).credential).toBe('subscription');
    expect(hookVerdict(onRoot, { [KEY]: '1' })).toBe(true);

    const offRoot = tmpRoot({ dotenv: `${KEY}=1\n` });
    setProcessOptIn('0');
    const off = await resolveInitCredential({ projectRoot: offRoot, gate: fakeGate() });
    expect(off.credential).toBe('none');
    expect((await resolveInitCredential({ projectRoot: offRoot })).credential).toBe('none');
    expect(hookVerdict(offRoot, { [KEY]: '0' })).toBe(false);
  });

  it('AC4: a =1 copied only from the rks repo-root .env is ignored; the server matches the hook with the key unset', async () => {
    const root = tmpRoot(); // no project .env
    bootCopied('1');
    const res = await resolveInitCredential({ projectRoot: root });
    expect(res.credential).toBe('none');
    expect(hookVerdict(root, {})).toBe(false);
    expect((await resolveInitCredential({ projectRoot: root, gate: fakeGate() })).credential).toBe('none');
  });

  it('AC3 parity: for every project .env x shell env cell the server decision equals isSubscriptionOptInOn', async () => {
    const dotenvCells = ['absent', '1', '0', 'unparseable'];
    const shellCells = [undefined, '1', '0'];
    let cells = 0;
    for (const dotenv of dotenvCells) {
      for (const shell of shellCells) {
        // Two server-side views of the same machine state: the shell value as-is, and, when the
        // shell is unset, the boot dotenv load having copied the project .env value in.
        const views = [{ boot: false }];
        if (shell === undefined && (dotenv === '1' || dotenv === '0')) views.push({ boot: true });
        for (const { boot } of views) {
          resetBootDotenvCopied();
          const root = tmpRoot({ researchBackend: 'claude-cli' });
          writeDotenv(root, dotenv);
          if (boot) bootCopied(dotenv);
          else setProcessOptIn(shell);
          const label = `.env=${dotenv} shell=${String(shell)} bootCopy=${boot}`;
          // The hook process never sees the server's dotenv copy: only the shell value.
          const hook = hookVerdict(root, shell === undefined ? {} : { [KEY]: shell });
          const server = serverOptInOn({ projectRoot: root, discountBootCopy: true });
          expect(server, label).toBe(hook);
          const res = await resolveInitCredential({ projectRoot: root });
          expect(res.credential, label).toBe(hook ? 'subscription' : 'none');
          cells++;
        }
      }
    }
    expect(cells).toBe(dotenvCells.length * shellCells.length + 2);
  });

  it('explicit env: no boot-provenance discount; the decision is isSubscriptionOptInOn on that env', async () => {
    const root = tmpRoot(); // no project .env
    bootCopied('1');
    const env = { [KEY]: '1' };
    const res = await resolveInitCredential({ projectRoot: root, env, gate: fakeGate() });
    expect(res.credential).toBe('subscription');
    expect(isSubscriptionOptInOn({ ...env, CLAUDE_PROJECT_DIR: root })).toBe(true);
    // Passing process.env explicitly is also honored as-is.
    const explicit = await resolveInitCredential({ projectRoot: root, env: process.env, gate: fakeGate() });
    expect(explicit.credential).toBe('subscription');
    // The default path on the same state discounts the copy.
    expect((await resolveInitCredential({ projectRoot: root })).credential).toBe('none');
  });

  it('a vi.stubEnv opt-in never recorded as copied (no boot ran) is env-set and honored', async () => {
    const root = tmpRoot();
    vi.stubEnv(KEY, '1');
    expect(isBootDotenvCopied(KEY)).toBe(false);
    expect((await resolveInitCredential({ projectRoot: root })).credential).toBe('subscription');
  });
});
