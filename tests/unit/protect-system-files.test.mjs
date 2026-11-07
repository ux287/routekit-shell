/**
 * protect-system-files (system tier) — rks project config and server-written state classes.
 * Story: backlog.fix.child-config-write-deny-rks-project-json
 *
 * The canonical hook is exercised ONLY as a spawned node process fed a PreToolUse payload on
 * stdin; it is never imported in-process. Every project root is a fresh mkdtemp directory under
 * os.tmpdir(); nothing reads or writes the real repository .rks or .routekit directories.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isBuiltin } from 'node:module';
import { canonicalHookPath } from '../helpers/hook-path.mjs';

const HOOK = canonicalHookPath('system/protect-system-files.mjs');
const LIB = path.join(path.dirname(HOOK), '..', 'lib', 'protected-rks-paths.mjs');
const IS_WIN = process.platform === 'win32';

const CONFIG = ['.rks/project.json', '.rks/rag/config.json', '.routekit/command-policy.yaml', '.rks/protected-files.yml'];
const STATE = ['.rks/active-scope.json', '.rks/telemetry/research-agent-outage.json', '.rks/guardrails-state.json'];
const P = '.rks/project.json';
// Per-test budget for the many-spawn cases (each spawn is also individually bounded).
const SLOW = { timeout: 60_000 };

const temps = [];
function mkTemp(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(d);
  return d;
}

function makeRoot() {
  const root = mkTemp('rks-psf-');
  fs.mkdirSync(path.join(root, '.rks', 'rag'), { recursive: true });
  fs.mkdirSync(path.join(root, '.rks', 'telemetry'), { recursive: true });
  fs.mkdirSync(path.join(root, '.routekit'), { recursive: true });
  return root;
}

function writeScope(root, scope) {
  const body = typeof scope === 'string' ? scope : JSON.stringify(scope);
  fs.writeFileSync(path.join(root, '.rks', 'active-scope.json'), body);
}

function toolInputFor(toolName, p) {
  switch (toolName) {
    case 'Write': return { file_path: p, content: '{}' };
    case 'Edit': return { file_path: p, old_string: 'a', new_string: 'b' };
    case 'MultiEdit': return { file_path: p, edits: [] };
    case 'NotebookEdit': return { notebook_path: p, new_source: '' };
    case 'Read': return { file_path: p };
    case 'Bash': return { command: `cat ${p}` };
    default: throw new Error(`unknown tool ${toolName}`);
  }
}

/** Spawn a hook file once. A spawn error (including a timeout) throws, so it never reads as allow. */
function spawnHook(hookFile, projectDir, toolName, p, cwd = projectDir) {
  const result = spawnSync(process.execPath, [hookFile], {
    input: JSON.stringify({ tool_name: toolName, tool_input: toolInputFor(toolName, p) }),
    encoding: 'utf8',
    cwd,
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
    timeout: 15_000,
  });
  if (result.error) throw new Error(`hook spawn failed (${toolName} ${p}): ${result.error.message}`);
  return { code: result.status, stderr: result.stderr || '' };
}

const run = (projectDir, toolName, p, cwd) => spawnHook(HOOK, projectDir, toolName, p, cwd);

/** Relative, absolute, ./-prefixed and ..-containing forms of a project-relative path. */
function forms(root, rel) {
  const first = rel.split('/')[0];
  return [rel, path.join(root, rel), `./${rel}`, `${first}/../${rel}`, `src/../${rel}`];
}

function expectDeny(r, msg) {
  expect(r.code, `${msg}\nstderr: ${r.stderr}`).toBe(2);
}
function expectAllow(r, msg) {
  expect(r.code, `${msg}\nstderr: ${r.stderr}`).toBe(0);
}

let root;
beforeEach(() => { root = makeRoot(); });
afterEach(() => {
  while (temps.length) fs.rmSync(temps.pop(), { recursive: true, force: true });
});

describe('scope source pin', () => {
  it('reads the scope file from CLAUDE_PROJECT_DIR, not from cwd', () => {
    const a = root;
    const b = makeRoot();
    writeScope(a, { writeMode: 'scoped', allowedFiles: [P] });
    expectAllow(run(a, 'Write', P, b), 'CLAUDE_PROJECT_DIR=A (scoped), cwd=B');
    expectDeny(run(b, 'Write', P, a), 'CLAUDE_PROJECT_DIR=B (no scope), cwd=A');
  });
});

describe('rks project config class', () => {
  it('denies Write and Edit to every config path in every path form with no scope file', SLOW, () => {
    for (const rel of CONFIG) {
      for (const f of forms(root, rel)) {
        for (const tool of ['Write', 'Edit']) {
          const r = run(root, tool, f);
          expectDeny(r, `${tool} ${f}`);
          expect(r.stderr).toContain(rel);
        }
      }
    }
    expectDeny(run(root, 'Write', '.rks/../.rks/project.json'), '.rks/../.rks/project.json');
    expectDeny(run(root, 'Write', 'src/../.rks/rag/config.json'), 'src/../.rks/rag/config.json');
  });

  it('covers NotebookEdit and MultiEdit', () => {
    expectDeny(run(root, 'NotebookEdit', P), 'NotebookEdit config');
    expectDeny(run(root, 'NotebookEdit', '.rks/active-scope.json'), 'NotebookEdit state');
    expectDeny(run(root, 'MultiEdit', P), 'MultiEdit config');
    expectAllow(run(root, 'NotebookEdit', 'notebooks/a.ipynb'), 'NotebookEdit unrelated');
  });

  it('config deny stderr names the file and the governed routes, never disabling hooks', () => {
    const r = run(root, 'Write', P);
    expectDeny(r, 'Write config');
    expect(r.stderr).toContain(P);
    expect(r.stderr).toMatch(/rks_init|rks_rag_init|rks_onboarder|routekit project/);
    expect(r.stderr).toMatch(/story/);
    expect(r.stderr).toMatch(/targetFiles/);
    expect(r.stderr).toMatch(/exact path/);
    expect(r.stderr).toMatch(/guardrails-off/);
    expect(r.stderr).toMatch(/user may edit the file directly/i);
    expect(r.stderr).not.toMatch(/hooks\.bak/);
    expect(r.stderr).not.toMatch(/disabl/i);
  });

  it('exempts exactly the allowedFiles path in a scoped off-rail session', () => {
    writeScope(root, { writeMode: 'scoped', allowedFiles: [P] });
    for (const f of [P, path.join(root, P), `./${P}`]) {
      for (const tool of ['Write', 'Edit', 'NotebookEdit']) {
        expectAllow(run(root, tool, f), `${tool} ${f} exempt`);
      }
    }
    expectDeny(run(root, 'Write', '.rks/rag/config.json'), 'other config path stays denied');
  });

  it('normalizes allowedFiles entries like targets', () => {
    writeScope(root, { writeMode: 'scoped', allowedFiles: [`./${P}`] });
    expectAllow(run(root, 'Write', P), './-prefixed allowedFiles entry');
    writeScope(root, { writeMode: 'scoped', allowedFiles: [path.join(root, P)] });
    expectAllow(run(root, 'Write', P), 'absolute allowedFiles entry');
  });

  it('never exempts glob entries', () => {
    for (const g of ['.rks/**', '.rks/*.json', '**/*']) {
      writeScope(root, { writeMode: 'scoped', allowedFiles: [g] });
      expectDeny(run(root, 'Write', P), `glob ${g}`);
    }
  });

  it('fails closed on every malformed or non-scoped scope file', () => {
    const scopes = [
      { writeMode: 'read-only', allowedFiles: [P] },
      { writeMode: 'deny-list', allowedFiles: [P] },
      { allowedFiles: [P] },
      { writeMode: 'scoped' },
      { writeMode: 'scoped', allowedFiles: P },
      '{ not json',
      '',
    ];
    for (const s of scopes) {
      writeScope(root, s);
      expectDeny(run(root, 'Write', P), `scope ${JSON.stringify(s)}`);
    }
    const scopePath = path.join(root, '.rks', 'active-scope.json');
    fs.rmSync(scopePath, { force: true });
    fs.mkdirSync(scopePath);
    expectDeny(run(root, 'Write', P), 'scope file is a directory');
  });
});

describe('server-written state class', () => {
  it('denies Write, Edit and NotebookEdit in every form under every scope condition', SLOW, () => {
    for (const rel of STATE) {
      const conditions = [
        ['no scope file', () => fs.rmSync(path.join(root, '.rks', 'active-scope.json'), { recursive: true, force: true })],
        ['unparseable scope', () => writeScope(root, '{ nope')],
        ['scoped allowedFiles lists it', () => writeScope(root, { writeMode: 'scoped', allowedFiles: [rel] })],
      ];
      for (const [label, setup] of conditions) {
        setup();
        for (const f of forms(root, rel)) {
          for (const tool of ['Write', 'Edit', 'NotebookEdit']) {
            const r = run(root, tool, f);
            expectDeny(r, `${tool} ${f} (${label})`);
            expect(r.stderr).toContain(rel);
          }
        }
      }
    }
  });

  it('state deny stderr names the file, the server writer and the no-exemption rule', () => {
    for (const rel of STATE) {
      const r = run(root, 'Write', rel);
      expectDeny(r, rel);
      expect(r.stderr).toContain(rel);
      expect(r.stderr).toMatch(/written only by the rks MCP server/);
      expect(r.stderr).toMatch(/No story or off-rail scope can exempt it/);
      expect(r.stderr).toMatch(/user may still edit it directly/i);
      expect(r.stderr).not.toMatch(/hooks\.bak/);
      expect(r.stderr).not.toMatch(/disabl/i);
    }
  });
});

describe.skipIf(IS_WIN)('symlinks', () => {
  it('denies file and directory symlink aliases, even with the real path exempted', () => {
    fs.writeFileSync(path.join(root, P), '{}');
    fs.symlinkSync(path.join(root, P), path.join(root, 'link.json'));
    fs.symlinkSync(path.join(root, '.rks'), path.join(root, 'cfg'));
    for (const f of ['link.json', 'cfg/project.json', 'cfg/active-scope.json']) {
      expectDeny(run(root, 'Write', f), `alias ${f}`);
    }
    writeScope(root, { writeMode: 'scoped', allowedFiles: [P] });
    expectDeny(run(root, 'Write', 'link.json'), 'link.json with real path exempted');
  });

  it('denies across a symlinked project root in both directions', () => {
    const linkParent = mkTemp('rks-psf-link-');
    const linkRoot = path.join(linkParent, 'proj');
    fs.symlinkSync(root, linkRoot);
    const real = fs.realpathSync(root);
    expectDeny(run(linkRoot, 'Write', path.join(real, P)), 'CLAUDE_PROJECT_DIR=symlink, real-path target');
    expectDeny(run(real, 'Write', path.join(linkRoot, P)), 'CLAUDE_PROJECT_DIR=real, symlink target');
  });
});

describe('case variants', () => {
  it('denies case variants on every platform, and the exemption is case-sensitive', () => {
    for (const f of ['.RKS/project.json', '.rks/PROJECT.json', '.Rks/Rag/Config.json', '.rks/Active-Scope.json']) {
      expectDeny(run(root, 'Write', f), `case variant ${f}`);
    }
    writeScope(root, { writeMode: 'scoped', allowedFiles: [P] });
    expectDeny(run(root, 'Write', '.RKS/project.json'), '.RKS/project.json with exact lowercase exempted');
  });
});

describe('existing user-only patterns', () => {
  const FILES = ['CLAUDE.md', 'sub/CLAUDE.md', '.claude/settings.json', '.claude/settings.local.json'];

  it('deny Write and Edit (relative and absolute) with no exemption', SLOW, () => {
    for (const withScope of [false, true]) {
      for (const rel of FILES) {
        if (withScope) writeScope(root, { writeMode: 'scoped', allowedFiles: [rel] });
        for (const f of [rel, path.join(root, rel)]) {
          for (const tool of ['Write', 'Edit']) {
            const r = run(root, tool, f);
            expectDeny(r, `${tool} ${f} scope=${withScope}`);
            expect(r.stderr).toContain('is a protected system file');
          }
        }
      }
    }
  });

  it('apply to NotebookEdit and MultiEdit', () => {
    const a = run(root, 'NotebookEdit', 'CLAUDE.md');
    expectDeny(a, 'NotebookEdit CLAUDE.md');
    expect(a.stderr).toContain('is a protected system file');
    const b = run(root, 'MultiEdit', '.claude/settings.json');
    expectDeny(b, 'MultiEdit settings');
    expect(b.stderr).toContain('is a protected system file');
  });
});

describe('unrelated and near-miss paths', () => {
  it('allow unrelated paths and non-write tools', () => {
    for (const f of [
      '.rks/other.json', '.rks/rag/other.json', '.rks/telemetry/other.json',
      '.rks/telemetry/events-2026-10-07.jsonl', '.routekit/guardrails.yaml', 'src/index.ts',
      'project.json', '.rks/project.json.bak', '.rks/project.jsonx',
    ]) {
      expectAllow(run(root, 'Write', f), `Write ${f}`);
    }
    expectAllow(run(root, 'Read', P), 'Read');
    expectAllow(run(root, 'Bash', P), 'Bash');
  });
});

describe('one protected list, loaded fail-closed (ARCH Item 5)', () => {
  it('source pin: dynamic lib import, builtin-only static imports, no protected literals', () => {
    const src = fs.readFileSync(HOOK, 'utf8');
    expect(src).toContain('protected-rks-paths.mjs');
    expect(src).toMatch(/await import\(/);
    expect(src).not.toMatch(/^\s*import\s[^(]*protected-rks-paths/m);
    const specs = [...src.matchAll(/^\s*import\s[^(]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
    expect(specs.length).toBeGreaterThan(0);
    for (const s of specs) expect(isBuiltin(s), `static import ${s}`).toBe(true);
    for (const lit of ['.rks/project.json', 'rag/config.json', 'command-policy.yaml', 'protected-files.yml', 'guardrails-state.json', 'research-agent-outage.json']) {
      expect(src).not.toContain(lit);
    }
  });

  it('lib binding: every entry of both shared lists is denied; state entries never exempt', async () => {
    const { PROTECTED_CONFIG_PATHS, PROTECTED_STATE_PATHS } = await import(pathToFileURL(LIB).href);
    expect(PROTECTED_CONFIG_PATHS.length).toBeGreaterThan(0);
    expect(PROTECTED_STATE_PATHS.length).toBeGreaterThan(0);
    for (const rel of [...PROTECTED_CONFIG_PATHS, ...PROTECTED_STATE_PATHS]) {
      expectDeny(run(root, 'Write', rel), `lib entry ${rel}`);
    }
    for (const rel of PROTECTED_STATE_PATHS) {
      writeScope(root, { writeMode: 'scoped', allowedFiles: [rel] });
      expectDeny(run(root, 'Write', rel), `lib state entry ${rel} with scope`);
    }
  });

  function assertFailClosed(copy) {
    for (const f of ['.rks/project.json', '.rks/other.json', '.RKS/x.json', '.routekit/guardrails.yaml']) {
      for (const tool of ['Write', 'Edit', 'NotebookEdit']) {
        const r = spawnHook(copy, root, tool, f);
        expectDeny(r, `fail-closed ${tool} ${f}`);
        expect(r.stderr).toContain('protected-rks-paths.mjs');
        expect(r.stderr).not.toMatch(/hooks\.bak/);
        expect(r.stderr).not.toMatch(/disabl/i);
      }
    }
    expectDeny(spawnHook(copy, root, 'Write', 'CLAUDE.md'), 'fail-closed CLAUDE.md');
    expectAllow(spawnHook(copy, root, 'Write', 'src/index.ts'), 'fail-closed src/index.ts');
  }

  it('denies .rks and .routekit writes when the lib is missing or exports neither list', SLOW, () => {
    const hooksDir = mkTemp('rks-psf-hooks-');
    fs.mkdirSync(path.join(hooksDir, 'system'));
    const copy = path.join(hooksDir, 'system', 'protect-system-files.mjs');
    fs.copyFileSync(HOOK, copy);

    assertFailClosed(copy);

    fs.mkdirSync(path.join(hooksDir, 'lib'));
    fs.writeFileSync(path.join(hooksDir, 'lib', 'protected-rks-paths.mjs'), 'export const OTHER = 1;\n');
    assertFailClosed(copy);

    fs.rmSync(path.join(hooksDir, 'lib'), { recursive: true, force: true });
    fs.cpSync(path.dirname(LIB), path.join(hooksDir, 'lib'), { recursive: true });
    expectAllow(spawnHook(copy, root, 'Write', '.rks/other.json'), 'positive control .rks/other.json');
    expectDeny(spawnHook(copy, root, 'Write', P), 'positive control config');
  });
});

describe('outside-root suffix rule (ARCH Item 2a)', () => {
  it('classifies outside-root paths by suffix and never exempts them', () => {
    const other = mkTemp('rks-psf-other-');
    expectDeny(run(root, 'Write', path.join(other, '.rks', 'project.json')), 'other/.rks/project.json');
    expectDeny(run(root, 'Write', path.join(other, '.RKS', 'Project.json')), 'other/.RKS/Project.json');
    expectDeny(run(root, 'Write', path.join(other, '.rks', 'active-scope.json')), 'other/.rks/active-scope.json');
    expectDeny(run(root, 'Write', '../other/.rks/active-scope.json'), '../other/.rks/active-scope.json');
    writeScope(root, { writeMode: 'scoped', allowedFiles: [P] });
    expectDeny(run(root, 'Write', path.join(other, '.rks', 'project.json')), 'outside root never exempt');
    expectAllow(run(root, 'Write', path.join(other, '.rks', 'other.json')), 'other/.rks/other.json');
    expectAllow(run(root, 'Write', path.join(other, 'x.rks', 'project.json')), 'other/x.rks/project.json');
  });
});
