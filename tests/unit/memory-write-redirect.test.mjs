/**
 * Tests for the agent-memory redirect branch in redirect-edit-to-governor.mjs.
 *
 * The hook intercepts Write/Edit calls targeting the harness agent-memory
 * directory (~/.claude/projects/<slug>/memory/) and denies them with a
 * REDIRECT ORDER routing the agent to write a project-local Dendron note
 * (notes/memories.<slug>.md) instead. Non-memory writes still redirect to the
 * Governor unchanged.
 *
 * Behavioral tests spawn the canonical hook with a tool-call payload on stdin.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

const SPAWN_TIMEOUT = 15000;
const CANONICAL = 'packages/hooks/write/redirect-edit-to-governor.mjs';
const DEPLOYED = '.routekit/hooks/write/redirect-edit-to-governor.mjs';
const TEMPLATE = 'templates/generic/.routekit/hooks/write/redirect-edit-to-governor.mjs';
const HOOK = path.resolve(CANONICAL);

// Spawn the hook with a tool-call payload on stdin, guardrails ON (RKS_GUARDRAILS
// removed from the child env so the hook's isGuardrailsOff() returns false).
function runHook(toolName, filePath) {
  const payload = JSON.stringify({ tool_name: toolName, tool_input: { file_path: filePath } });
  const env = { ...process.env };
  delete env.RKS_GUARDRAILS;
  const res = spawnSync('node', [HOOK], {
    input: payload, encoding: 'utf8', timeout: SPAWN_TIMEOUT, env,
  });
  const stdout = (res.stdout || '').trim();
  let json = null;
  if (stdout) { try { json = JSON.parse(stdout); } catch { /* non-JSON output */ } }
  return { status: res.status, stdout, json };
}

const ctxOf = (r) => r.json?.hookSpecificOutput?.additionalContext || '';
const decisionOf = (r) => r.json?.hookSpecificOutput?.permissionDecision;

const MEMORY_ABS = path.join(
  os.homedir(), '.claude', 'projects', '-Users-x-routekit-shell-core', 'memory', 'mcp-server-restart.md',
);

describe('redirect-edit-to-governor — agent-memory redirect', () => {
  it('denies a Write to an absolute ~/.claude memory path with a REDIRECT ORDER (no GOVERNOR ROUTING)', () => {
    const r = runHook('Write', MEMORY_ABS);
    expect(r.status).toBe(0);
    expect(r.json).not.toBeNull();
    expect(decisionOf(r)).toBe('deny');
    expect(ctxOf(r)).toContain('REDIRECT ORDER');
    expect(ctxOf(r)).not.toContain('GOVERNOR ROUTING');
    expect(ctxOf(r)).not.toContain('notes/memories.');
    expect(ctxOf(r)).toContain('/memory');
    expect(ctxOf(r)).toContain('slug: mcp-server-restart');
  });

  it('denies a Write to a tilde-relative memory path (~ expanded to homedir)', () => {
    const r = runHook('Write', '~/.claude/projects/-Users-x-proj/memory/foo.md');
    expect(decisionOf(r)).toBe('deny');
    expect(ctxOf(r)).toContain('/memory');
    expect(ctxOf(r)).toContain('slug: foo');
    expect(ctxOf(r)).not.toContain('notes/memories.');
    expect(ctxOf(r)).not.toContain('GOVERNOR ROUTING');
  });

  it('denies a PROJECT_DIR-relative path that resolves into the memory dir', () => {
    const rel = path.relative(process.cwd(), MEMORY_ABS);
    const r = runHook('Write', rel);
    expect(decisionOf(r)).toBe('deny');
    expect(ctxOf(r)).toContain('REDIRECT ORDER');
    expect(ctxOf(r)).not.toContain('GOVERNOR ROUTING');
  });

  it('denies an Edit to a memory path identically to Write', () => {
    const r = runHook('Edit', MEMORY_ABS);
    expect(decisionOf(r)).toBe('deny');
    expect(ctxOf(r)).toContain('/memory');
    expect(ctxOf(r)).toContain('slug: mcp-server-restart');
    expect(ctxOf(r)).not.toContain('notes/memories.');
    expect(ctxOf(r)).not.toContain('GOVERNOR ROUTING');
  });

  it('the REDIRECT ORDER directs the Dispatcher to the /memory skill with the derived slug', () => {
    const r = runHook('Write', MEMORY_ABS);
    const ctx = ctxOf(r);
    expect(ctx).toContain('/memory');
    expect(ctx).toContain('slug: mcp-server-restart');
    // The old "write a notes/memories.<slug>.md + Dendron frontmatter" instructions are gone.
    expect(ctx).not.toContain('notes/memories.');
    expect(ctx).not.toContain('GOVERNOR ROUTING');
  });
});

describe('redirect-edit-to-governor — non-memory writes still route to the Governor', () => {
  it('redirects an in-repo source-file Write to the Governor unchanged', () => {
    const r = runHook('Write', 'src/foo.ts');
    expect(decisionOf(r)).toBe('deny');
    expect(ctxOf(r)).toContain('GOVERNOR ROUTING');
    expect(ctxOf(r)).not.toContain('notes/memories.');
    expect(r.stdout).toContain('Write must go through the Governor');
  });

  it('does not treat a substring-"memory" in-repo path as a memory write', () => {
    const r = runHook('Write', 'src/memory-store.ts');
    expect(decisionOf(r)).toBe('deny');
    expect(ctxOf(r)).toContain('GOVERNOR ROUTING');
    expect(ctxOf(r)).not.toContain('notes/memories.');
  });

  it('does not treat a .claude/projects path outside /memory/ as a memory write', () => {
    const p = path.join(os.homedir(), '.claude', 'projects', '-Users-x-proj', 'notes', 'x.md');
    const r = runHook('Write', p);
    expect(decisionOf(r)).toBe('deny');
    expect(ctxOf(r)).toContain('GOVERNOR ROUTING');
    expect(ctxOf(r)).not.toContain('notes/memories.');
  });

  it('fails closed on a non-string file_path — never a memory match, no hard crash', () => {
    const payload = JSON.stringify({ tool_name: 'Write', tool_input: { file_path: 12345 } });
    const env = { ...process.env };
    delete env.RKS_GUARDRAILS;
    const res = spawnSync('node', [HOOK], {
      input: payload, encoding: 'utf8', timeout: SPAWN_TIMEOUT, env,
    });
    expect(res.status).toBe(0);
    expect(res.stdout || '').not.toContain('notes/memories.');
  });
});

describe('redirect-edit-to-governor — source structure', () => {
  const canonical = fs.readFileSync(CANONICAL, 'utf8');
  const deployed = fs.readFileSync(DEPLOYED, 'utf8');
  const template = fs.readFileSync(TEMPLATE, 'utf8');

  it('adds the os import', () => {
    expect(canonical).toContain('import os from "os"');
  });

  it('defines isMemoryDirPath after isFileInActiveScope and before main()', () => {
    const iScope = canonical.indexOf('function isFileInActiveScope');
    const iMem = canonical.indexOf('function isMemoryDirPath');
    const iMain = canonical.indexOf('async function main');
    expect(iScope).toBeGreaterThan(-1);
    expect(iMem).toBeGreaterThan(iScope);
    expect(iMain).toBeGreaterThan(iMem);
  });

  it('isMemoryDirPath guards non-string input and fails closed via try/catch', () => {
    const fn = canonical.slice(
      canonical.indexOf('function isMemoryDirPath'),
      canonical.indexOf('async function main'),
    );
    expect(fn).toMatch(/typeof\s+\w+\s*!==\s*"string"/);
    expect(fn).toContain('catch');
  });

  it('the memory branch sits after the active-scope early-exit and before the Governor block', () => {
    const iScopeExit = canonical.indexOf('isFileInActiveScope(filePath)) process.exit(0)');
    const iMemBranch = canonical.lastIndexOf('isMemoryDirPath(filePath)');
    const iGovernor = canonical.indexOf('buildRedirectOutput(');
    expect(iScopeExit).toBeGreaterThan(-1);
    expect(iMemBranch).toBeGreaterThan(iScopeExit);
    expect(iGovernor).toBeGreaterThan(iMemBranch);
  });

  it('the isFileInActiveScope helper and its early-exit are intact (passthrough not regressed)', () => {
    expect(canonical).toContain('function isFileInActiveScope');
    expect(canonical).toContain('if (filePath && isFileInActiveScope(filePath)) process.exit(0);');
  });

  it('all three hook copies are byte-identical', () => {
    expect(deployed).toBe(canonical);
    expect(template).toBe(canonical);
  });

  it('hooks-manifest.json still registers redirect-edit-to-governor (no new hook)', () => {
    const manifest = fs.readFileSync('.routekit/hooks-manifest.json', 'utf8');
    expect(manifest).toContain('write/redirect-edit-to-governor.mjs');
  });

  it('hook-output.mjs does not carry the memory-redirect logic (built inline in the hook)', () => {
    const ho = fs.readFileSync('packages/hooks/system/hook-output.mjs', 'utf8');
    expect(ho).not.toContain('isMemoryDirPath');
    expect(ho).not.toContain('notes/memories.');
  });
});
