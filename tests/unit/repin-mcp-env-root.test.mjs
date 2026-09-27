/**
 * backlog.fix.upgrade-preserves-stale-mcp-project-root
 *
 * repinMcpServer must reconcile env.ROUTEKIT_PROJECT_ROOT / env.RKS_PROJECT_ROOT
 * against the real project root (before its args[0] early return), and its callers
 * (upgradeProject, the `routekit project repin-mcp` verb) must report the two kinds
 * of change separately.
 *
 * Every fixture lives in fs.mkdtempSync dirs under os.tmpdir() (child, shell, fake
 * HOME); process.env.HOME is redirected and restored; handleProjectCommand always
 * receives an injected getProjectById, so no real registry or child is touched.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { repinMcpServer } from '../../packages/cli/src/project/repin-mcp.mjs';
import { upgradeProject } from '../../packages/cli/src/project/upgrade.mjs';
import { handleProjectCommand } from '../../packages/cli/src/cli/project.js';

let childRoot, shellRoot, fakeHome, prevHome;
const created = [];
const tmp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); created.push(d); return d; };
const bin = () => path.join(shellRoot, 'packages', 'mcp-rks', 'bin', 'mcp-rks.mjs');
const OLD_BIN = '/old-shell/packages/mcp-rks/bin/mcp-rks.mjs';
function writeMcp(env, args0 = OLD_BIN, extra = {}) {
  const cfg = { ...extra, mcpServers: { rks: { command: 'node', args: [args0], env } } };
  fs.writeFileSync(path.join(childRoot, '.mcp.json'), JSON.stringify(cfg, null, 2) + '\n');
}
const mcpFile = () => path.join(childRoot, '.mcp.json');
const readMcp = () => JSON.parse(fs.readFileSync(mcpFile(), 'utf8'));
const baks = () => fs.readdirSync(childRoot).filter((f) => f.startsWith('.mcp.json.bak.'));
const staleRoot = () => path.join(fakeHome, 'other-user', 'Documents', 'projects', 'child');

beforeEach(() => {
  childRoot = tmp('rks-envroot-child-');
  shellRoot = tmp('rks-envroot-shell-');
  fakeHome = tmp('rks-envroot-home-');
  prevHome = process.env.HOME;
  process.env.HOME = fakeHome;
});
afterEach(() => {
  process.env.HOME = prevHome;
  vi.restoreAllMocks();
  for (const d of created.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('repinMcpServer env-root reconciliation', () => {
  it('env-only: rewrites a nonexistent absolute ROUTEKIT_PROJECT_ROOT to projectRoot even when args[0] matches', () => {
    const stale = staleRoot();
    writeMcp({ ROUTEKIT_PROJECT_ID: 'child', ROUTEKIT_PROJECT_ROOT: stale, CUSTOM: 'kept' }, bin());
    const r = repinMcpServer({ projectRoot: childRoot, shellRoot });
    expect(r.changed).toBe(true);
    expect(r.argsChanged).toBe(false);
    expect(r.envRootChanges).toHaveLength(1);
    expect(r.envRootChanges[0]).toEqual({ key: 'ROUTEKIT_PROJECT_ROOT', from: stale, to: childRoot });
    const cfg = readMcp();
    expect(cfg.mcpServers.rks.env.ROUTEKIT_PROJECT_ROOT).toBe(childRoot);
    expect(cfg.mcpServers.rks.args[0]).toBe(bin());
    expect(baks()).toHaveLength(1);
  });

  it('reconciles RKS_PROJECT_ROOT independently of ROUTEKIT_PROJECT_ROOT', () => {
    const stale = staleRoot();
    writeMcp({ ROUTEKIT_PROJECT_ROOT: childRoot, RKS_PROJECT_ROOT: stale }, bin());
    const r = repinMcpServer({ projectRoot: childRoot, shellRoot });
    expect(r.envRootChanges).toEqual([{ key: 'RKS_PROJECT_ROOT', from: stale, to: childRoot }]);
    const env = readMcp().mcpServers.rks.env;
    expect(env.RKS_PROJECT_ROOT).toBe(childRoot);
    expect(env.ROUTEKIT_PROJECT_ROOT).toBe(childRoot);
  });

  it('with both keys stale, reports exactly two changes, one per key', () => {
    const staleA = path.join(fakeHome, 'a', 'child');
    const staleB = path.join(fakeHome, 'b', 'child');
    writeMcp({ ROUTEKIT_PROJECT_ROOT: staleA, RKS_PROJECT_ROOT: staleB }, bin());
    const r = repinMcpServer({ projectRoot: childRoot, shellRoot });
    expect(r.envRootChanges).toHaveLength(2);
    const byKey = Object.fromEntries(r.envRootChanges.map((c) => [c.key, c]));
    expect(byKey.ROUTEKIT_PROJECT_ROOT).toEqual({ key: 'ROUTEKIT_PROJECT_ROOT', from: staleA, to: childRoot });
    expect(byKey.RKS_PROJECT_ROOT).toEqual({ key: 'RKS_PROJECT_ROOT', from: staleB, to: childRoot });
  });

  it('rewrites an existing absolute root that resolves to a different directory', () => {
    const otherDir = tmp('rks-envroot-other-');
    writeMcp({ ROUTEKIT_PROJECT_ROOT: otherDir }, bin());
    const r = repinMcpServer({ projectRoot: childRoot, shellRoot });
    expect(r.changed).toBe(true);
    expect(r.envRootChanges).toEqual([{ key: 'ROUTEKIT_PROJECT_ROOT', from: otherDir, to: childRoot }]);
    expect(readMcp().mcpServers.rks.env.ROUTEKIT_PROJECT_ROOT).toBe(childRoot);
  });

  it('leaves a root that realpath-resolves to projectRoot through a symlink unchanged', () => {
    const linkParent = tmp('rks-envroot-link-');
    const link = path.join(linkParent, 'child-link');
    fs.symlinkSync(childRoot, link);
    writeMcp({ ROUTEKIT_PROJECT_ROOT: link }, bin());
    const before = fs.readFileSync(mcpFile(), 'utf8');
    const r = repinMcpServer({ projectRoot: childRoot, shellRoot });
    expect(r.envRootChanges).toEqual([]);
    expect(r.changed).toBe(false);
    expect(fs.readFileSync(mcpFile(), 'utf8')).toBe(before);
  });

  it('args-only: repins args[0], no env changes, exactly one backup', () => {
    writeMcp({ ROUTEKIT_PROJECT_ROOT: childRoot, RKS_PROJECT_ROOT: '.' });
    const r = repinMcpServer({ projectRoot: childRoot, shellRoot });
    expect(r.argsChanged).toBe(true);
    expect(r.envRootChanges).toEqual([]);
    expect(r.changed).toBe(true);
    expect(readMcp().mcpServers.rks.args[0]).toBe(bin());
    expect(baks()).toHaveLength(1);
  });

  it('both: args[0] drifted and env root stale -> one write, one backup, both rewrites present', () => {
    const stale = staleRoot();
    writeMcp({ ROUTEKIT_PROJECT_ROOT: stale });
    const r = repinMcpServer({ projectRoot: childRoot, shellRoot });
    expect(r.argsChanged).toBe(true);
    expect(r.envRootChanges.length).toBeGreaterThan(0);
    expect(r.changed).toBe(true);
    const cfg = readMcp();
    expect(cfg.mcpServers.rks.args[0]).toBe(bin());
    expect(cfg.mcpServers.rks.env.ROUTEKIT_PROJECT_ROOT).toBe(childRoot);
    expect(baks()).toHaveLength(1);
  });

  it('neither: matching absolute root and "." are byte-identical with no backup', () => {
    writeMcp({ ROUTEKIT_PROJECT_ROOT: childRoot, RKS_PROJECT_ROOT: '.' }, bin());
    const before = fs.readFileSync(mcpFile(), 'utf8');
    const r = repinMcpServer({ projectRoot: childRoot, shellRoot });
    expect(r.changed).toBe(false);
    expect(r.argsChanged).toBe(false);
    expect(r.envRootChanges).toEqual([]);
    expect(fs.readFileSync(mcpFile(), 'utf8')).toBe(before);
    expect(baks()).toEqual([]);
  });

  it('never adds an absent root key', () => {
    writeMcp({ ROUTEKIT_PROJECT_ID: 'child' });
    const r = repinMcpServer({ projectRoot: childRoot, shellRoot });
    expect(r.envRootChanges).toEqual([]);
    const env = readMcp().mcpServers.rks.env;
    expect('ROUTEKIT_PROJECT_ROOT' in env).toBe(false);
    expect('RKS_PROJECT_ROOT' in env).toBe(false);
    expect(env).toEqual({ ROUTEKIT_PROJECT_ID: 'child' });
  });

  it('preserves every other env, server and top-level key after an env-root rewrite', () => {
    const stale = staleRoot();
    const extra = { topLevel: { keep: true } };
    writeMcp({ ROUTEKIT_PROJECT_ID: 'child', ROUTEKIT_PROJECT_ROOT: stale, USER_KEY: 'u', OTHER: '1' }, bin(), extra);
    const cfgIn = readMcp();
    cfgIn.mcpServers.rks.cwd = '/some/cwd';
    cfgIn.mcpServers.other = { command: 'x', args: ['y'] };
    fs.writeFileSync(mcpFile(), JSON.stringify(cfgIn, null, 2) + '\n');

    repinMcpServer({ projectRoot: childRoot, shellRoot });
    const out = readMcp();
    expect(out.topLevel).toEqual({ keep: true });
    expect(out.mcpServers.other).toEqual({ command: 'x', args: ['y'] });
    expect(out.mcpServers.rks.command).toBe('node');
    expect(out.mcpServers.rks.cwd).toBe('/some/cwd');
    expect(out.mcpServers.rks.args).toEqual([bin()]);
    expect(out.mcpServers.rks.env).toEqual({
      ROUTEKIT_PROJECT_ID: 'child',
      ROUTEKIT_PROJECT_ROOT: childRoot,
      USER_KEY: 'u',
      OTHER: '1',
    });
  });
});

describe('upgradeProject report entries for env-root reconciliation', () => {
  function stampChild(version) {
    fs.mkdirSync(path.join(childRoot, '.rks'), { recursive: true });
    fs.writeFileSync(
      path.join(childRoot, '.rks', 'project.json'),
      JSON.stringify({ id: 'child', kgFile: 'routekit/kg.yaml', rksVersion: version }, null, 2),
    );
  }
  function spies(to) {
    return {
      readRksVersion: vi.fn(() => to),
      syncProject: vi.fn(() => []),
      migrateChildSettingsHookPaths: vi.fn(() => false),
      ensureHookRegistration: vi.fn(() => ({ changed: false })),
      migrateConfig: vi.fn(() => ({ ok: true, applied: [], noOp: true })),
      now: () => 'TS',
    };
  }
  const envEntries = (r) => r.reconciled.filter((e) => e.includes('ROUTEKIT_PROJECT_ROOT'));

  it('env-only: rewrites the root and reports it WITHOUT ".mcp.json (repinned)"', () => {
    stampChild('0.20.18');
    const stale = staleRoot();
    writeMcp({ ROUTEKIT_PROJECT_ID: 'child', ROUTEKIT_PROJECT_ROOT: stale }, bin());
    const r = upgradeProject({ projectRoot: childRoot, projectId: 'child', shellRoot }, spies('0.20.19'));
    expect(readMcp().mcpServers.rks.env.ROUTEKIT_PROJECT_ROOT).toBe(childRoot);
    expect(r.reconciled).not.toContain('.mcp.json (repinned)');
    const entries = envEntries(r);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toContain(stale);
    expect(entries[0]).toContain(childRoot);
  });

  it('args drift + stale env root: reports both, separately', () => {
    stampChild('0.20.18');
    const stale = staleRoot();
    writeMcp({ ROUTEKIT_PROJECT_ROOT: stale });
    const r = upgradeProject({ projectRoot: childRoot, projectId: 'child', shellRoot }, spies('0.20.19'));
    expect(r.reconciled).toContain('.mcp.json (repinned)');
    const entries = envEntries(r);
    expect(entries).toHaveLength(1);
    expect(entries[0]).not.toBe('.mcp.json (repinned)');
    expect(entries[0]).toContain(stale);
    expect(entries[0]).toContain(childRoot);
  });

  it('args drift + matching env root: reports repinned and no env entry', () => {
    stampChild('0.20.18');
    writeMcp({ ROUTEKIT_PROJECT_ROOT: childRoot });
    const r = upgradeProject({ projectRoot: childRoot, projectId: 'child', shellRoot }, spies('0.20.19'));
    expect(r.reconciled).toContain('.mcp.json (repinned)');
    expect(envEntries(r)).toEqual([]);
  });
});

describe('recovery path: repin-mcp heals a child already at the current version', () => {
  it('upgrade (boundary none) leaves the stale root; repin-mcp verb with the real repinMcpServer rewrites it', async () => {
    fs.mkdirSync(path.join(childRoot, '.rks'), { recursive: true });
    fs.writeFileSync(
      path.join(childRoot, '.rks', 'project.json'),
      JSON.stringify({ id: 'child', rksVersion: '0.20.19' }, null, 2),
    );
    const stale = staleRoot();
    writeMcp({ ROUTEKIT_PROJECT_ID: 'child', ROUTEKIT_PROJECT_ROOT: stale }, bin());

    const r = upgradeProject(
      { projectRoot: childRoot, projectId: 'child', shellRoot },
      {
        readRksVersion: vi.fn(() => '0.20.19'),
        syncProject: vi.fn(() => []),
        migrateChildSettingsHookPaths: vi.fn(() => false),
        ensureHookRegistration: vi.fn(() => ({ changed: false })),
        migrateConfig: vi.fn(() => ({ ok: true, applied: [], noOp: true })),
        now: () => 'TS',
      },
    );
    expect(r.boundary).toBe('none');
    expect(readMcp().mcpServers.rks.env.ROUTEKIT_PROJECT_ROOT).toBe(stale);

    vi.spyOn(console, 'log').mockImplementation(() => {});
    const processExit = vi.fn();
    const getProjectById = vi.fn(() => ({ id: 'child', root: childRoot }));
    await handleProjectCommand(
      { sub: 'repin-mcp', kv: { id: 'child' }, SHELL_ROOT: shellRoot },
      { processExit, getProjectById },
    );
    expect(getProjectById).toHaveBeenCalledWith('child', shellRoot);
    expect(readMcp().mcpServers.rks.env.ROUTEKIT_PROJECT_ROOT).toBe(childRoot);
    expect(processExit).toHaveBeenCalledWith(0);
  });
});
