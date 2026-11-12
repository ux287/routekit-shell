/**
 * backlog.feat.claude-cli-oneshot-backend: resolveBackend per-caller claude-cli selection.
 * Opt-in only, via .rks/agents.yaml keys llm-planner, reviewer, external-research and qa-agent; the
 * default and every unrecognised case is anthropic (fail closed). No backend method is invoked, so
 * nothing is spawned and no request is sent.
 * Requires packages/mcp-rks/src/llm/backend.mjs from backlog.feat.llm-backend-interface-anthropic.
 * Tier: npm run test:unit
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveBackend } from '../../packages/mcp-rks/src/llm/backend.mjs';
import { ONESHOT_SELECTION_KEYS } from '../../packages/mcp-rks/src/llm/claude-cli/oneshot.mjs';

const ENV = { provider: 'anthropic', model: null, anthropicKey: 'sk-ant-test', openaiKey: 'sk-openai-test' };
const CALLERS = ['planner', 'reviewer', 'external-research', 'qa-agent'];
const SAVED = { ROUTEKIT_PROJECT_ROOT: process.env.ROUTEKIT_PROJECT_ROOT, RKS_PLANNER_BACKEND: process.env.RKS_PLANNER_BACKEND };
const roots = [];

function rootWith(yaml) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rks-oneshot-select-'));
  roots.push(root);
  if (yaml != null) {
    fs.mkdirSync(path.join(root, '.rks'), { recursive: true });
    fs.writeFileSync(path.join(root, '.rks', 'agents.yaml'), yaml);
  }
  return root;
}
const yamlFor = (key, backend = 'claude-cli') => `agents:\n  ${key}:\n    backend: ${backend}\n`;

afterEach(() => {
  vi.unstubAllEnvs();
  while (roots.length) fs.rmSync(roots.pop(), { recursive: true, force: true });
  for (const [k, v] of Object.entries(SAVED)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('resolveBackend one-shot selection', () => {
  it('maps each caller to its selection key; the planner uses llm-planner, not the registry planner agent', () => {
    expect(ONESHOT_SELECTION_KEYS).toStrictEqual({
      planner: 'llm-planner', reviewer: 'reviewer', 'external-research': 'external-research', 'qa-agent': 'qa-agent',
    });
  });

  it.each(CALLERS.map((c) => [c, ONESHOT_SELECTION_KEYS[c]]))('caller %s selects claude-cli only when %s is backend: claude-cli', (caller, key) => {
    const projectRoot = rootWith(yamlFor(key));
    const backend = resolveBackend({ env: ENV, caller, pinProvider: 'anthropic', projectRoot });
    expect(backend.id).toBe('claude-cli');
    expect(backend.fallbackBackend.id).toBe('anthropic');
    for (const other of CALLERS.filter((c) => c !== caller)) {
      expect(resolveBackend({ env: ENV, caller: other, pinProvider: 'anthropic', projectRoot }).id, other).toBe('anthropic');
    }
  });

  it('reads projectRoot from ROUTEKIT_PROJECT_ROOT when none is passed (outside vitest)', () => {
    process.env.ROUTEKIT_PROJECT_ROOT = rootWith(yamlFor('llm-planner'));
    vi.stubEnv('VITEST', '');
    expect(resolveBackend({ env: ENV, caller: 'planner' }).id).toBe('claude-cli');
  });

  it('under vitest the ROUTEKIT_PROJECT_ROOT fallback is ignored, so an opted-in repo never spawns from a unit test', () => {
    process.env.ROUTEKIT_PROJECT_ROOT = rootWith(yamlFor('llm-planner'));
    expect(process.env.VITEST).toBeTruthy();
    expect(resolveBackend({ env: ENV, caller: 'planner' }).id).toBe('anthropic');
  });

  it('with no projectRoot and no ROUTEKIT_PROJECT_ROOT the result is anthropic', () => {
    delete process.env.ROUTEKIT_PROJECT_ROOT;
    expect(resolveBackend({ env: ENV, caller: 'planner' }).id).toBe('anthropic');
  });

  it.each([
    ['no agents.yaml', () => rootWith(null), 'planner'],
    ['the key is absent', () => rootWith(yamlFor('research')), 'planner'],
    ['an unknown backend value', () => rootWith(yamlFor('llm-planner', 'bogus')), 'planner'],
    ['the registry planner key instead of llm-planner', () => rootWith(yamlFor('planner')), 'planner'],
    ['an unknown caller', () => rootWith(yamlFor('visual')), 'visual'],
    ['a null caller', () => rootWith(yamlFor('llm-planner')), null],
  ])('fails closed to anthropic when %s', (_label, makeRoot, caller) => {
    expect(resolveBackend({ env: ENV, caller, projectRoot: makeRoot() }).id).toBe('anthropic');
  });

  it('RKS_PLANNER_BACKEND does not select the one-shot (it belongs to the registry planner agent)', () => {
    process.env.RKS_PLANNER_BACKEND = 'claude-cli';
    expect(resolveBackend({ env: ENV, caller: 'planner', projectRoot: rootWith(null) }).id).toBe('anthropic');
  });

  it('provider openai is never claude-cli', () => {
    const projectRoot = rootWith(yamlFor('llm-planner'));
    expect(resolveBackend({ env: { ...ENV, provider: 'openai' }, caller: 'planner', projectRoot }).id).toBe('openai');
  });
});
