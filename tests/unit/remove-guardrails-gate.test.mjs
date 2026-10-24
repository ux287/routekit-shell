// backlog.fix.guardrails-gate-hook-error-concurrent-offrail
// Witnesses for removing the dead guardrails gate, its auto-enable sibling and the inert
// guardrails flag file. Real-repo paths are READ only; every write goes to an os.tmpdir()
// root removed in afterEach. Never touches the real .claude/settings.json.
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  AGENT_PROVENANCE_TOOLS,
  buildHookRegistration,
  ensureHookRegistration,
  loadHookManifest,
} from '../../packages/cli/src/project/bootstrap.mjs';
import { inspectHookRegistration } from '../../packages/cli/src/project/doctor.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// Concatenated so this file is not itself a stale reference to the removed names.
const GATE = 'guardrails-' + 'gate';
const AUTO = 'guardrails-' + 'auto-enable';
const REMOVED = [GATE + '.mjs', AUTO + '.mjs'];
const FLAG = '.routekit/' + 'guardrails' + '.yaml';
const HOOK_DIRS = ['packages/hooks/system', '.routekit/hooks/system', 'templates/generic/.routekit/hooks/system'];
const HOOK_COPIES = HOOK_DIRS.flatMap((d) => REMOVED.map((n) => `${d}/${n}`));

const PRE_MATCHERS = [
  'EnterPlanMode', 'Read', 'Grep', 'Glob', 'Task', 'Read|Grep|Glob', 'Edit|Write', 'Edit|Write',
  'mcp__rks__rks_validate_story',
  'mcp__rks__rks_git_commit|mcp__rks__rks_git_branch|mcp__rks__rks_checkout|mcp__rks__rks_git_merge|mcp__rks__rks_git_state|mcp__rks__rks_stash|mcp__rks__rks_restore|mcp__rks__rks_cherry_pick|mcp__rks__rks_tag',
  'mcp__rks__dendron_create_note|mcp__rks__dendron_edit_note|mcp__rks__dendron_read_note|mcp__rks__dendron_update_field|mcp__rks__dendron_fix_frontmatter|mcp__rks__dendron_validate_schema|mcp__rks__dendron_mark_implemented',
  'mcp__rks__rks_rag_query|mcp__rks__rks_kg_query',
  'WebSearch', 'Bash',
];
const POST_MATCHERS = [...AGENT_PROVENANCE_TOOLS, 'Read|Grep|Glob|Bash|WebFetch|WebSearch', 'Edit|Write'];

const tmp = [];
function mk(prefix) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tmp.push(d);
  return d;
}
afterEach(() => {
  while (tmp.length) fs.rmSync(tmp.pop(), { recursive: true, force: true });
});

const commandsOf = (hooks) =>
  Object.values(hooks).flatMap((groups) => groups.flatMap((g) => g.hooks.map((h) => h.command)));
const tieredCmd = (rel) => `node "$CLAUDE_PROJECT_DIR"/.routekit/hooks/${rel}`;
const manifest = loadHookManifest(REPO_ROOT);

describe('removed files', () => {
  it.each(HOOK_COPIES)('%s does not exist', (rel) => {
    expect(fs.existsSync(path.join(REPO_ROOT, rel))).toBe(false);
  });
  it('the guardrails flag file does not exist', () => {
    expect(fs.existsSync(path.join(REPO_ROOT, FLAG))).toBe(false);
  });
});

describe('hooks manifest', () => {
  const raw = fs.readFileSync(path.join(REPO_ROOT, '.routekit', 'hooks-manifest.json'), 'utf8');
  it('parses and carries neither removed key', () => {
    const m = JSON.parse(raw);
    expect(Object.keys(m)).not.toContain(GATE);
    expect(Object.keys(m)).not.toContain(AUTO);
  });
  // Pre-existing dangling manifest entries, absent from packages/hooks at HEAD before this
  // story (git ls-tree HEAD has no such files). Out of scope here; excluded so this witness
  // covers every other entry. Remove from this list when a story fixes them.
  const PREEXISTING_DANGLING = new Set([
    'write/enforce-staging-release-governor.mjs',
  ]);
  it('the dangling redirect-raw-mcp-to-governor and enforce-code-context entries are gone', () => {
    const m = JSON.parse(raw);
    expect(m).not.toHaveProperty('redirect-raw-mcp-to-governor');
    expect(m).not.toHaveProperty('enforce-code-context');
    expect(PREEXISTING_DANGLING.has('write/enforce-staging-release-governor.mjs')).toBe(true);
    expect(PREEXISTING_DANGLING.size).toBe(1);
  });
  it('every entry resolves in packages/hooks and in the deployed tree (hooks.bak tolerated off-rail)', () => {
    const m = JSON.parse(raw);
    const unresolved = Object.values(m)
      .map((e) => e.path)
      .filter((rel) => !PREEXISTING_DANGLING.has(rel))
      .filter((rel) =>
        !fs.existsSync(path.join(REPO_ROOT, 'packages', 'hooks', rel)) ||
        !(fs.existsSync(path.join(REPO_ROOT, '.routekit', 'hooks', rel)) ||
          fs.existsSync(path.join(REPO_ROOT, '.routekit', 'hooks.bak', rel))));
    expect(unresolved).toEqual([]);
  });
});

describe.each([
  ['manifest', () => buildHookRegistration(manifest)],
  ['null (flat fallback)', () => buildHookRegistration(null)],
])('buildHookRegistration(%s)', (_label, build) => {
  const hooks = build();
  it('registers neither removed hook', () => {
    const hits = commandsOf(hooks).filter((c) => REMOVED.some((n) => c.includes(n)));
    expect(hits).toEqual([]);
  });
  it('has no PreToolUse "*" group and no empty group', () => {
    expect(hooks.PreToolUse.map((g) => g.matcher)).not.toContain('*');
    for (const groups of Object.values(hooks)) for (const g of groups) expect(g.hooks.length).toBeGreaterThan(0);
  });
  it('keeps every other group in order', () => {
    expect(hooks.PreToolUse.map((g) => g.matcher)).toEqual(PRE_MATCHERS);
    expect(hooks.PostToolUse.map((g) => g.matcher)).toEqual(POST_MATCHERS);
  });
});

describe('child writer and doctor (temp roots only)', () => {
  it('ensureHookRegistration rewrites an old child block without the removed hooks', () => {
    const root = mk('rks-rm-gate-child-');
    fs.mkdirSync(path.join(root, '.rks'), { recursive: true });
    fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
    const settingsPath = path.join(root, '.claude', 'settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: '*', hooks: [
          { type: 'command', command: tieredCmd(`system/${GATE}.mjs`) },
          { type: 'command', command: tieredCmd(`system/${AUTO}.mjs`) },
        ] }],
        PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: tieredCmd(`system/${AUTO}.mjs`) }] }],
      },
    }, null, 2));
    expect(ensureHookRegistration({ settingsPath, manifest }).changed).toBe(true);
    const written = JSON.parse(fs.readFileSync(settingsPath, 'utf8')).hooks;
    expect(written).toEqual(buildHookRegistration(manifest));
    expect(commandsOf(written).filter((c) => REMOVED.some((n) => c.includes(n)))).toEqual([]);
  });

  it('doctor inspectHookRegistration certifies a child that carries only the remaining hooks', () => {
    const child = mk('rks-rm-gate-doctor-');
    for (const rel of new Set(Object.values(manifest).map((e) => e.path))) {
      const p = path.join(child, '.routekit', 'hooks', rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, '// stub hook\n');
    }
    const canonical = buildHookRegistration(manifest);
    fs.mkdirSync(path.join(child, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(child, '.claude', 'settings.json'), JSON.stringify({ hooks: canonical }, null, 2));
    expect(inspectHookRegistration({ childRoot: child, manifest, canonical })).toEqual(expect.objectContaining({ ok: true }));
  });
});

describe('sync-hooks --check', () => {
  it('reports no orphans and no drift', () => {
    const r = spawnSync(process.execPath, [path.join(REPO_ROOT, 'scripts', 'sync-hooks.mjs'), '--check'], {
      cwd: REPO_ROOT, encoding: 'utf8', timeout: 30_000,
    });
    expect(r.error).toBeUndefined();
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('No drift or orphans');
    expect(r.stderr).not.toMatch(/orphan|missing from dest|content differs|extra in dest/);
  });
});

describe('no stale references', () => {
  const ALLOW = new Set([
    'tests/unit/sync-hooks.test.mjs',
    'tests/unit/protect-system-files.test.mjs',
    'tests/unit/bash-protected-rks-config.test.mjs',
    'tests/unit/purge-dead-guardrails-config.test.mjs',
  ]);
  function walk(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === '.tmp' || e.name === 'node_modules') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, out);
      else if (/\.(m?js|cjs|ts|json|md|ya?ml)$/.test(e.name)) out.push(full);
    }
    return out;
  }
  it('no file under tests/ outside the allowlist names a removed file', () => {
    const needles = [...REMOVED, FLAG];
    const offenders = walk(path.join(REPO_ROOT, 'tests'))
      .map((f) => path.relative(REPO_ROOT, f).split(path.sep).join('/'))
      .filter((rel) => !ALLOW.has(rel))
      .filter((rel) => needles.some((n) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8').includes(n)));
    expect(offenders).toEqual([]);
  });
  it('docs.hooks-inventory has no section for either removed hook', () => {
    const lines = fs.readFileSync(path.join(REPO_ROOT, 'notes', 'docs.hooks-inventory.md'), 'utf8').split('\n');
    for (const n of REMOVED) expect(lines.some((l) => l.trim() === '#'.repeat(3) + ' ' + n)).toBe(false);
  });
});
