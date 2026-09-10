/**
 * backlog.fix.hook-fallthrough-on-research-agent-outage
 *
 * When the Research Agent is down, the read hooks fall through to a BOUNDED direct read for
 * diagnosis instead of redirecting into the broken component — driven by a fail-closed breadcrumb
 * the agent runner writes on a genuine infra failure. Security-sensitive: writes never fall
 * through, scope still wins, and every ambiguous/stale/malformed edge redirects.
 *
 * Unit tests pin the deterministic security-critical logic (classifier, breadcrumb lifecycle,
 * fail-closed reader). Subprocess tests spawn the real hooks (execFileSync + timeout).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyAgentError, recordResearchOutage } from '../../packages/mcp-rks/src/agents/runner.mjs';
import { isResearchAgentOutage } from '../../packages/hooks/system/hook-output.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS_DIR = path.join(REPO_ROOT, 'packages', 'hooks', 'read');

let tmp;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rks-outage-')); });
afterEach(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

function writeBreadcrumb(root, { ageMs = 0, category = 'server_5xx', raw } = {}) {
  const dir = path.join(root, '.rks', 'telemetry');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'research-agent-outage.json');
  const content = raw !== undefined
    ? raw
    : JSON.stringify({ timestamp: new Date(Date.now() - ageMs).toISOString(), category });
  fs.writeFileSync(file, content, 'utf8');
}

// Spawn a real hook with stdin JSON. Hooks deny via exit 0 + JSON (permissionDecision:deny) or, for
// enforce-read-provenance in block mode, exit 2. Allow = exit 0 + no deny JSON.
function runHook(hookFile, input, root, extraEnv = {}) {
  const hookPath = path.join(HOOKS_DIR, hookFile);
  try {
    const stdout = execFileSync('node', [hookPath], {
      input: JSON.stringify(input),
      env: { ...process.env, CLAUDE_PROJECT_DIR: root, RKS_GUARDRAILS: '', ...extraEnv },
      encoding: 'utf8',
      timeout: 10_000,
    });
    return { status: 0, stdout };
  } catch (e) {
    return { status: e.status ?? 1, stdout: (e.stdout && e.stdout.toString()) || '' };
  }
}
const isDeny = (r) => r.status === 2 || (r.stdout || '').includes('"permissionDecision":"deny"');
const isAllow = (r) => !isDeny(r);

describe('classifyAgentError — infra vs capability vs unknown (AC1)', () => {
  const infra = [
    'Anthropic error: 500 Internal Server Error',
    'HTTP 503 Service Unavailable',
    'Error: Overloaded',
    'credit balance is too low',
    'billing: insufficient credits',
    'Error 429: rate limit / quota',
    '401 Unauthorized',
    '403 Forbidden: invalid x-api-key',
    'ECONNREFUSED 127.0.0.1',
    'fetch failed: ENOTFOUND api.anthropic.com',
    'connection error',
    'Request timed out after 120000ms',
    'AbortError: The operation was aborted',
  ];
  for (const msg of infra) {
    it(`infrastructure: ${msg.slice(0, 40)}`, () => {
      expect(classifyAgentError(msg).type).toBe('infrastructure');
    });
  }

  const capability = [
    'Agent output is not valid JSON',
    'Output validation failed: expected string',
    'Agent returned empty response',
    'Agent exceeded max turns',
  ];
  for (const msg of capability) {
    it(`NOT infrastructure (capability): ${msg.slice(0, 40)}`, () => {
      expect(classifyAgentError(msg).type).toBe('capability');
    });
  }

  it('unknown/ambiguous → not infrastructure (fail-closed default)', () => {
    expect(classifyAgentError('something weird happened').type).toBe('unknown');
    expect(classifyAgentError(undefined).type).toBe('unknown');
  });
});

describe('recordResearchOutage — breadcrumb lifecycle (AC2)', () => {
  const research = (extra = {}) => ({ projectRoot: '/x', name: 'research', ...extra });
  function spy() {
    const calls = { write: [], clear: [] };
    return {
      deps: {
        write: (root, cat) => calls.write.push({ root, cat }),
        clear: (root) => calls.clear.push({ root }),
      },
      calls,
    };
  }

  it('writes a breadcrumb (with category) on an infra-classified failure', () => {
    const s = spy();
    recordResearchOutage(research(), { ok: false, error: 'HTTP 503 Service Unavailable' }, s.deps);
    expect(s.calls.write).toHaveLength(1);
    expect(s.calls.write[0].cat).toBe('server_5xx');
    expect(s.calls.clear).toHaveLength(0);
  });

  it('clears on a successful (ok:true) result', () => {
    const s = spy();
    recordResearchOutage(research(), { ok: true, answer: 'hi' }, s.deps);
    expect(s.calls.clear).toHaveLength(1);
    expect(s.calls.write).toHaveLength(0);
  });

  it('clears on a legitimate not-found (ok:true, advisory) — agent is up', () => {
    const s = spy();
    recordResearchOutage(research(), { ok: true, advisory: true, answer: '' }, s.deps);
    expect(s.calls.clear).toHaveLength(1);
    expect(s.calls.write).toHaveLength(0);
  });

  it('does NOT write for a capability fault (agent up)', () => {
    const s = spy();
    recordResearchOutage(research(), { ok: false, error: 'Agent output is not valid JSON' }, s.deps);
    expect(s.calls.write).toHaveLength(0);
    expect(s.calls.clear).toHaveLength(0);
  });

  it('does NOT write for an ambiguous error (fail-closed)', () => {
    const s = spy();
    recordResearchOutage(research(), { ok: false, error: 'weird' }, s.deps);
    expect(s.calls.write).toHaveLength(0);
  });

  it('ignores non-research agents', () => {
    const s = spy();
    recordResearchOutage({ projectRoot: '/x', name: 'planner' }, { ok: false, error: '503' }, s.deps);
    expect(s.calls.write).toHaveLength(0);
    expect(s.calls.clear).toHaveLength(0);
  });
});

describe('isResearchAgentOutage — fail-closed reader (AC7)', () => {
  it('fresh breadcrumb → active with category', () => {
    writeBreadcrumb(tmp, { ageMs: 1000, category: 'billing' });
    expect(isResearchAgentOutage(tmp)).toEqual({ active: true, category: 'billing' });
  });
  it('stale (past TTL) → false', () => {
    writeBreadcrumb(tmp, { ageMs: 6 * 60 * 1000 });
    expect(isResearchAgentOutage(tmp)).toBe(false);
  });
  it('future-dated → false', () => {
    writeBreadcrumb(tmp, { ageMs: -60_000 });
    expect(isResearchAgentOutage(tmp)).toBe(false);
  });
  it('malformed JSON → false', () => {
    writeBreadcrumb(tmp, { raw: '{ not json ' });
    expect(isResearchAgentOutage(tmp)).toBe(false);
  });
  it('missing → false', () => {
    expect(isResearchAgentOutage(tmp)).toBe(false);
  });
});

describe('read hooks — fallthrough on fresh outage, redirect otherwise (subprocess)', () => {
  const readInput = (fp) => ({ tool_name: 'Read', tool_input: { file_path: fp } });

  it('AC3: no-provenance Read is ALLOWED under a fresh breadcrumb', () => {
    writeBreadcrumb(tmp);
    const r = runHook('redirect-read-to-agent.mjs', readInput('notes/some-explore.md'), tmp);
    expect(isAllow(r)).toBe(true);
  });

  it('AC6: no-provenance Read REDIRECTS with no breadcrumb (agent-up unchanged)', () => {
    const r = runHook('redirect-read-to-agent.mjs', readInput('notes/some-explore.md'), tmp);
    expect(isDeny(r)).toBe(true);
  });

  it('AC7: a STALE breadcrumb redirects (fail-closed)', () => {
    writeBreadcrumb(tmp, { ageMs: 6 * 60 * 1000 });
    const r = runHook('redirect-read-to-agent.mjs', readInput('notes/some-explore.md'), tmp);
    expect(isDeny(r)).toBe(true);
  });

  it('AC5: off-rail scope hard-deny WINS over a fresh breadcrumb', () => {
    writeBreadcrumb(tmp);
    fs.mkdirSync(path.join(tmp, '.rks'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.rks', 'active-scope.json'),
      JSON.stringify({ allowedFiles: ['src/only-this.ts'] }), 'utf8');
    const r = runHook('redirect-read-to-agent.mjs', readInput('notes/outside-scope.md'), tmp);
    expect(isDeny(r)).toBe(true);
  });

  it('AC8: a Governor can read its own prompt (.rks/prompts/*.md) under a fresh breadcrumb', () => {
    writeBreadcrumb(tmp);
    const r = runHook('redirect-read-to-agent.mjs', readInput('.rks/prompts/governor-build.md'), tmp);
    expect(isAllow(r)).toBe(true);
  });

  it('Grep and Glob fall through under a fresh breadcrumb, redirect without', () => {
    writeBreadcrumb(tmp);
    const gAllow = runHook('redirect-grep-to-agent.mjs', { tool_name: 'Grep', tool_input: { pattern: 'foo', path: 'src' } }, tmp);
    expect(isAllow(gAllow)).toBe(true);
    const glAllow = runHook('redirect-glob-to-agent.mjs', { tool_name: 'Glob', tool_input: { pattern: '**/*.ts', path: 'src' } }, tmp);
    expect(isAllow(glAllow)).toBe(true);

    const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'rks-outage-nb-'));
    try {
      const gDeny = runHook('redirect-grep-to-agent.mjs', { tool_name: 'Grep', tool_input: { pattern: 'foo', path: 'src' } }, tmp2);
      expect(isDeny(gDeny)).toBe(true);
    } finally { fs.rmSync(tmp2, { recursive: true, force: true }); }
  });
});

describe('bounded scope — writes and metachars never fall through (subprocess, AC4)', () => {
  it('read-class Bash (cat) is allowed under a fresh breadcrumb', () => {
    writeBreadcrumb(tmp);
    const r = runHook('redirect-read-bash-to-agent.mjs', { tool_name: 'Bash', tool_input: { command: 'cat notes/x.md' } }, tmp);
    expect(isAllow(r)).toBe(true);
  });

  it('metacharacter Bash stays HARD-DENIED even with a fresh breadcrumb', () => {
    writeBreadcrumb(tmp);
    const r = runHook('redirect-read-bash-to-agent.mjs', { tool_name: 'Bash', tool_input: { command: 'cat a.md; rm -rf b' } }, tmp);
    expect(isDeny(r)).toBe(true);
  });

  it('write-class Bash (echo >) stays denied even with a fresh breadcrumb', () => {
    writeBreadcrumb(tmp);
    const r = runHook('redirect-read-bash-to-agent.mjs', { tool_name: 'Bash', tool_input: { command: 'echo hi > out.txt' } }, tmp);
    expect(isDeny(r)).toBe(true);
  });

  it('enforce-read-provenance (block mode): Edit stays BLOCKED with a fresh breadcrumb; Read falls through', () => {
    writeBreadcrumb(tmp);
    // Force block mode so an unprovenance'd op actually blocks.
    fs.mkdirSync(path.join(tmp, '.routekit'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.routekit', 'read-policy.yaml'),
      'provenance_enforcement:\n  enabled: true\n  mode: block\n  strict_rag_paths:\n    - /notes/\n', 'utf8');

    const edit = runHook('enforce-read-provenance.mjs', { tool_name: 'Edit', tool_input: { file_path: 'notes/explore.md' } }, tmp);
    expect(isDeny(edit)).toBe(true); // write never falls through

    const read = runHook('enforce-read-provenance.mjs', { tool_name: 'Read', tool_input: { file_path: 'notes/explore.md' } }, tmp);
    expect(isAllow(read)).toBe(true); // read intent falls through under outage
  });
});
