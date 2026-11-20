// backlog.feat.staging-release-governor-enforcement
// Witnesses for retiring the never-written enforce-staging-release-governor hook.
// Real-repo paths are READ only. The server-side token gate for rks_staging_merge and
// rks_release is what protects these tools; this file pins that it is still in place.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isProtectedTool, UNPROTECTED_TOOLS } from '../../packages/mcp-rks/src/shared/governor-token.mjs';
import { TOOL_TO_AGENT_MAP } from '../../packages/mcp-rks/src/server.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// Concatenated so this file is not itself a stale reference to the retired names.
const HOOK = 'enforce-staging-release-' + 'governor';
const MATCHER = 'mcp__rks__rks_staging_merge|mcp__rks__rks_release';
const TOOLS = ['rks_staging_merge', 'rks_release'];
const HOOK_DIRS = ['packages/hooks/write', '.routekit/hooks/write', 'templates/generic/.routekit/hooks/write'];

describe('retired hook artifacts', () => {
  it('the standalone witness script is deleted', () => {
    expect(fs.existsSync(path.join(REPO_ROOT, 'scripts', 'hooks', `test-${HOOK}.mjs`))).toBe(false);
  });
  it.each(HOOK_DIRS)('no %s/<hook>.mjs is created', (dir) => {
    expect(fs.existsSync(path.join(REPO_ROOT, dir, `${HOOK}.mjs`))).toBe(false);
  });
  it('.claude/settings.json parses and carries neither the matcher nor the hook command', () => {
    const raw = fs.readFileSync(path.join(REPO_ROOT, '.claude', 'settings.json'), 'utf8');
    const settings = JSON.parse(raw);
    const groups = Object.values(settings.hooks || {}).flat();
    expect(groups.map((g) => g.matcher)).not.toContain(MATCHER);
    const commands = groups.flatMap((g) => (g.hooks || []).map((h) => h.command || ''));
    expect(commands.length).toBeGreaterThan(0);
    expect(commands.filter((c) => c.includes(`${HOOK}.mjs`))).toEqual([]);
  });
  it('.routekit/hooks-manifest.json parses, has no key and no path for the hook', () => {
    const m = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, '.routekit', 'hooks-manifest.json'), 'utf8'));
    expect(m).not.toHaveProperty(HOOK);
    expect(Object.values(m).map((e) => e.path).filter((p) => p.includes(`${HOOK}.mjs`))).toEqual([]);
  });
});

describe('server-side gating of rks_staging_merge and rks_release is unchanged', () => {
  it.each(TOOLS)('%s is not in UNPROTECTED_TOOLS and isProtectedTool() returns true', (tool) => {
    expect(UNPROTECTED_TOOLS.has(tool)).toBe(false);
    expect(isProtectedTool(tool)).toBe(true);
  });
  it.each(TOOLS)('a tokenless %s call auto-routes to the ship agent', (tool) => {
    expect(TOOL_TO_AGENT_MAP[tool]).toBeDefined();
    expect(TOOL_TO_AGENT_MAP[tool].agent).toBe('ship');
  });
  it('non-vacuity: isProtectedTool() distinguishes an unprotected tool', () => {
    expect(isProtectedTool('rks_rag_query')).toBe(false);
  });
});
