/**
 * backlog.feat.agent-backend-selection-research: runner.mjs loads executors/backend-dispatch.mjs
 * lazily, only for an opted-in agent, and outside vitest uses the process-wide default dispatcher.
 *
 * The dispatcher module is replaced by a factory that counts its own evaluation, so the test can
 * observe whether runner.mjs ever imported it. The vitest guard is cleared per test with
 * vi.stubEnv so the default-dispatcher route runs; because the module is replaced, no probe and no
 * claude binary can be reached. ANTHROPIC_API_KEY is stubbed empty so an unexpected SDK path fails
 * at the credential guard. Tests run in file order; the first must run before the module is loaded.
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

const h = vi.hoisted(() => ({ factoryRuns: 0, execute: null }));

vi.mock('../../../packages/mcp-rks/src/agents/executors/backend-dispatch.mjs', () => {
  h.factoryRuns += 1;
  return {
    getDefaultBackendDispatcher: () => ({ execute: (config, opts) => h.execute(config, opts) }),
  };
});

import { runAgent } from '../../../packages/mcp-rks/src/agents/runner.mjs';
import { clearConfigCache } from '../../../packages/mcp-rks/src/agents/config.mjs';

const PROMPT = 'You are the lazy-load test prompt.';
const OPT_IN = ['agents:', '  research:', '    backend: claude-cli', ''].join('\n');
const NO_BACKEND = ['agents:', '  research:', '    model: claude-haiku-4-5-20251001', ''].join('\n');
const UNKNOWN_BACKEND = ['agents:', '  research:', '    backend: gpt', ''].join('\n');

const roots = [];
function projectRoot(yaml) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rks-backend-lazy-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, '.rks'), { recursive: true });
  if (yaml !== undefined) fs.writeFileSync(path.join(root, '.rks', 'agents.yaml'), yaml, 'utf8');
  return root;
}

function baseConfig(root, extra = {}) {
  return {
    name: 'research',
    prompt: PROMPT,
    userMessage: 'question',
    tools: [],
    inputSchema: z.object({ q: z.string() }),
    rawInput: { q: 'question' },
    projectId: 'proj-lazy',
    projectRoot: root,
    model: 'claude-haiku-4-5-20251001',
    ...extra,
  };
}

beforeEach(() => {
  vi.stubEnv('RKS_RESEARCH_BACKEND', '');
  vi.stubEnv('ANTHROPIC_API_KEY', '');
  vi.stubEnv('VITEST', '');
  h.execute = vi.fn(async () => ({ ok: true, answer: 'from-default-dispatcher', telemetryId: 'tid-x' }));
  clearConfigCache();
});
afterEach(() => {
  vi.unstubAllEnvs();
});
afterAll(() => {
  clearConfigCache();
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});

describe('lazy loading of executors/backend-dispatch.mjs', () => {
  it('with no opt-in, runAgent never loads the dispatcher module', async () => {
    for (const yaml of [undefined, NO_BACKEND, UNKNOWN_BACKEND]) {
      const shortCircuit = vi.fn(async () => ({ answer: 'from-api-path' }));
      const result = await runAgent(baseConfig(projectRoot(yaml), { shortCircuit }));
      expect(result.answer).toBe('from-api-path');
      expect(shortCircuit).toHaveBeenCalledTimes(1);
    }
    expect(h.factoryRuns).toBe(0);
    expect(h.execute).not.toHaveBeenCalled();
  });

  it('an opted-in agent outside vitest loads the module once and runs on the process-wide default dispatcher', async () => {
    expect(process.env.VITEST).toBe('');
    const shortCircuit = vi.fn(async () => ({ answer: 'from-api-path' }));
    const result = await runAgent(baseConfig(projectRoot(OPT_IN), { shortCircuit }));
    expect(h.factoryRuns).toBe(1);
    expect(h.execute).toHaveBeenCalledTimes(1);
    const [config, opts] = h.execute.mock.calls[0];
    expect(config.name).toBe('research');
    expect(typeof opts.executeApi).toBe('function');
    expect(opts.systemText).toBe(PROMPT);
    expect(shortCircuit).not.toHaveBeenCalled();
    expect(result.answer).toBe('from-default-dispatcher');
  });

  it('with the vitest guard restored, an opted-in agent with no injected dispatcher takes the API path', async () => {
    vi.stubEnv('VITEST', 'true');
    const shortCircuit = vi.fn(async () => ({ answer: 'from-api-path' }));
    const result = await runAgent(baseConfig(projectRoot(OPT_IN), { shortCircuit }));
    expect(h.execute).not.toHaveBeenCalled();
    expect(shortCircuit).toHaveBeenCalledTimes(1);
    expect(result.answer).toBe('from-api-path');
  });
});
