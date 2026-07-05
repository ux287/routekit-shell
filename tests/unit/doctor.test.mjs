/**
 * Unit tests for runDoctor() in packages/cli/src/project/doctor.mjs.
 *
 * All fixers and registry helpers are mocked via dependency injection. Temp
 * directories provide the per-child file fixtures the function inspects.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runDoctor } from '../../packages/cli/src/project/doctor.mjs';

function makeShellRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-shell-'));
  fs.mkdirSync(path.join(root, 'packages', 'hooks', 'write'), { recursive: true });
  fs.mkdirSync(path.join(root, 'templates', 'generic', '.routekit', 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(root, 'packages/hooks/write/sample.mjs'), '// canonical\n');
  return root;
}

function makeChild({ pinned = false, mcpArgs = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-child-'));
  fs.mkdirSync(path.join(root, '.routekit', 'hooks'), { recursive: true });
  fs.mkdirSync(path.join(root, '.rks'), { recursive: true });
  if (pinned) {
    fs.writeFileSync(path.join(root, '.rks/project.json'), JSON.stringify({ id: 'child-x', pinned: true }, null, 2));
  } else {
    fs.writeFileSync(path.join(root, '.rks/project.json'), JSON.stringify({ id: 'child-x' }, null, 2));
  }
  fs.writeFileSync(
    path.join(root, '.mcp.json'),
    JSON.stringify({
      mcpServers: { rks: { command: 'node', args: mcpArgs ?? ['/some/shell/packages/mcp-rks/bin/mcp-rks.mjs'], env: {} } },
    }, null, 2),
  );
  return root;
}

function deps(overrides = {}) {
  return {
    syncHooks: vi.fn(),
    checkDrift: vi.fn(() => ({ ok: true, issues: [], srcCount: 0, destCount: 0 })),
    syncProject: vi.fn(() => []),
    repinMcpServer: vi.fn(() => ({ ok: true, changed: true })),
    migrateConfig: vi.fn(() => ({ ok: true, applied: [], noOp: true, fromVersion: 1, currentVersion: 1 })),
    upsertProject: vi.fn(),
    loadProjects: vi.fn(() => []),
    isPinned: vi.fn(() => false),
    ...overrides,
  };
}

describe('runDoctor — clean ecosystem', () => {
  let shellRoot;
  beforeEach(() => { shellRoot = makeShellRoot(); });
  afterEach(() => { if (shellRoot) fs.rmSync(shellRoot, { recursive: true, force: true }); });

  it('clean ecosystem reports zero findings, performs no writes, exits 0', async () => {
    const d = deps();
    const result = await runDoctor({ shellRoot, dryRun: false, deps: d });
    expect(result.exitCode).toBe(0);
    expect(result.findings.failed).toBe(0);
    expect(result.findings.nonRecoverable).toEqual([]);
    expect(d.syncHooks).not.toHaveBeenCalled();
    expect(d.syncProject).not.toHaveBeenCalled();
    expect(d.repinMcpServer).not.toHaveBeenCalled();
  });

  it('exports runDoctor as a named export and accepts { shellRoot, dryRun, deps }', () => {
    expect(typeof runDoctor).toBe('function');
  });
});

describe('runDoctor — Check 1: shell-side template drift', () => {
  let shellRoot;
  beforeEach(() => { shellRoot = makeShellRoot(); });
  afterEach(() => { fs.rmSync(shellRoot, { recursive: true, force: true }); });

  it('invokes checkDrift against canonical hooks vs templates/generic; on drift+wet, calls syncHooks', async () => {
    const d = deps({
      checkDrift: vi.fn(() => ({ ok: false, issues: ['missing from dest: x.mjs'] })),
    });
    await runDoctor({ shellRoot, dryRun: false, deps: d });
    expect(d.checkDrift).toHaveBeenCalled();
    expect(d.syncHooks).toHaveBeenCalled();
  });

  it('on drift + dryRun, does NOT invoke syncHooks', async () => {
    const d = deps({
      checkDrift: vi.fn(() => ({ ok: false, issues: ['drift'] })),
    });
    await runDoctor({ shellRoot, dryRun: true, deps: d });
    expect(d.syncHooks).not.toHaveBeenCalled();
  });
});

describe('runDoctor — Check 2: per-child hooks drift', () => {
  let shellRoot, child;
  beforeEach(() => {
    shellRoot = makeShellRoot();
    child = makeChild();
  });
  afterEach(() => {
    fs.rmSync(shellRoot, { recursive: true, force: true });
    fs.rmSync(child, { recursive: true, force: true });
  });

  it('per-child drift triggers syncProject in wet mode', async () => {
    let callIdx = 0;
    const d = deps({
      loadProjects: vi.fn(() => [{ id: 'child-x', root: child }]),
      checkDrift: vi.fn(() => {
        callIdx += 1;
        // First call (shell-side) ok; second (per-child) reports drift.
        return callIdx === 1 ? { ok: true } : { ok: false, issues: ['child drift'] };
      }),
    });
    await runDoctor({ shellRoot, dryRun: false, deps: d });
    expect(d.syncProject).toHaveBeenCalledWith({ projectRoot: child, projectId: 'child-x', shellRoot });
  });
});

describe('runDoctor — Check 3: .mcp.json shell pointer + pinned:true', () => {
  let shellRoot, child;
  beforeEach(() => { shellRoot = makeShellRoot(); });
  afterEach(() => {
    fs.rmSync(shellRoot, { recursive: true, force: true });
    if (child) fs.rmSync(child, { recursive: true, force: true });
  });

  it('drifted .mcp.json + unpinned child → repinMcpServer invoked', async () => {
    child = makeChild({ pinned: false, mcpArgs: ['/wrong/shell/packages/mcp-rks/bin/mcp-rks.mjs'] });
    const d = deps({
      loadProjects: vi.fn(() => [{ id: 'child-x', root: child }]),
      isPinned: vi.fn(() => false),
    });
    await runDoctor({ shellRoot, dryRun: false, deps: d });
    expect(d.repinMcpServer).toHaveBeenCalledWith({ projectRoot: child, shellRoot });
  });

  it('drifted .mcp.json + pinned:true child → repinMcpServer NOT invoked, finding marked non-recoverable, exitCode non-zero', async () => {
    child = makeChild({ pinned: true, mcpArgs: ['/wrong/shell/packages/mcp-rks/bin/mcp-rks.mjs'] });
    const d = deps({
      loadProjects: vi.fn(() => [{ id: 'child-x', root: child }]),
      isPinned: vi.fn(() => true),
    });
    const result = await runDoctor({ shellRoot, dryRun: false, deps: d });
    expect(d.repinMcpServer).not.toHaveBeenCalled();
    expect(result.findings.nonRecoverable.some((nr) => nr.check === 3 && nr.id === 'child-x')).toBe(true);
    expect(result.exitCode).not.toBe(0);
  });

  it('healthy .mcp.json (points under shellRoot) → no repin', async () => {
    child = makeChild({ mcpArgs: [path.join(shellRoot, 'packages/mcp-rks/bin/mcp-rks.mjs')] });
    const d = deps({ loadProjects: vi.fn(() => [{ id: 'child-x', root: child }]) });
    await runDoctor({ shellRoot, dryRun: false, deps: d });
    expect(d.repinMcpServer).not.toHaveBeenCalled();
  });
});

describe('runDoctor — Check 4: registry presence (upsertProject directly, NOT add-existing handler)', () => {
  let shellRoot;
  beforeEach(() => { shellRoot = makeShellRoot(); });
  afterEach(() => { fs.rmSync(shellRoot, { recursive: true, force: true }); });

  it('unregistered candidate → upsertProject invoked with { id, root, stack }', async () => {
    const d = deps({
      loadProjects: vi.fn(() => []),
      findUnregisteredChildren: vi.fn(() => [{ id: 'orphan', root: '/tmp/orphan', stack: 'app' }]),
    });
    await runDoctor({ shellRoot, dryRun: false, deps: d });
    expect(d.upsertProject).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'orphan', root: '/tmp/orphan', stack: 'app' }),
      shellRoot,
    );
  });

  it('Check 4 does NOT invoke the add-existing handler under any condition (negative assertion)', async () => {
    // Provide a mock handler via deps that we can prove was never called.
    const addExistingHandler = vi.fn();
    const d = deps({
      loadProjects: vi.fn(() => []),
      findUnregisteredChildren: vi.fn(() => [{ id: 'orphan', root: '/tmp/orphan' }]),
      addExistingHandler, // Doctor MUST NOT call this regardless of injection presence.
    });
    await runDoctor({ shellRoot, dryRun: false, deps: d });
    expect(addExistingHandler).not.toHaveBeenCalled();
  });

  it('dryRun + unregistered candidate → upsertProject NOT invoked', async () => {
    const d = deps({
      loadProjects: vi.fn(() => []),
      findUnregisteredChildren: vi.fn(() => [{ id: 'orphan', root: '/tmp/orphan' }]),
    });
    await runDoctor({ shellRoot, dryRun: true, deps: d });
    expect(d.upsertProject).not.toHaveBeenCalled();
  });
});

describe('runDoctor — Check 5: schemaVersion migration', () => {
  let shellRoot, child;
  beforeEach(() => {
    shellRoot = makeShellRoot();
    child = makeChild();
  });
  afterEach(() => {
    fs.rmSync(shellRoot, { recursive: true, force: true });
    fs.rmSync(child, { recursive: true, force: true });
  });

  it('migrateConfig invoked once per child in wet mode', async () => {
    const d = deps({
      loadProjects: vi.fn(() => [{ id: 'child-x', root: child }]),
    });
    await runDoctor({ shellRoot, dryRun: false, deps: d });
    expect(d.migrateConfig).toHaveBeenCalledWith({ projectRoot: child });
  });

  it('dryRun mode: migrateConfig NOT invoked (Check 5 is read-skipped under dry-run)', async () => {
    const d = deps({
      loadProjects: vi.fn(() => [{ id: 'child-x', root: child }]),
    });
    await runDoctor({ shellRoot, dryRun: true, deps: d });
    expect(d.migrateConfig).not.toHaveBeenCalled();
  });
});

describe('runDoctor — batch resilience & idempotency', () => {
  let shellRoot, childA, childB;
  beforeEach(() => {
    shellRoot = makeShellRoot();
    childA = makeChild();
    childB = makeChild();
  });
  afterEach(() => {
    fs.rmSync(shellRoot, { recursive: true, force: true });
    fs.rmSync(childA, { recursive: true, force: true });
    fs.rmSync(childB, { recursive: true, force: true });
  });

  it('per-child fixer failure does NOT abort the batch', async () => {
    let n = 0;
    const d = deps({
      loadProjects: vi.fn(() => [
        { id: 'a', root: childA },
        { id: 'b', root: childB },
      ]),
      migrateConfig: vi.fn(({ projectRoot }) => {
        n += 1;
        if (n === 1) throw new Error('first failed');
        return { ok: true, applied: [], noOp: true };
      }),
    });
    const result = await runDoctor({ shellRoot, dryRun: false, deps: d });
    expect(d.migrateConfig).toHaveBeenCalledTimes(2);
    expect(result.findings.failed).toBeGreaterThan(0);
    expect(result.exitCode).not.toBe(0);
  });

  it('second invocation after a successful auto-fix reports zero findings', async () => {
    // First call: clean; second call: also clean (since no drift was introduced)
    const d = deps({ loadProjects: vi.fn(() => []) });
    const r1 = await runDoctor({ shellRoot, dryRun: false, deps: d });
    const r2 = await runDoctor({ shellRoot, dryRun: false, deps: d });
    expect(r1.exitCode).toBe(0);
    expect(r2.exitCode).toBe(0);
  });
});

describe('runDoctor — source structure (no fixer duplication)', () => {
  const SRC = fs.readFileSync(
    new URL('../../packages/cli/src/project/doctor.mjs', import.meta.url),
    'utf8',
  );

  it('imports syncHooks/checkDrift from scripts/sync-hooks.mjs (does not redefine)', () => {
    expect(SRC).toMatch(/from\s+["'].*scripts\/sync-hooks\.mjs["']/);
  });

  it('imports syncProject from ./sync.mjs', () => {
    expect(SRC).toMatch(/from\s+["']\.\/sync\.mjs["']/);
  });

  it('imports repinMcpServer from ./repin-mcp.mjs', () => {
    expect(SRC).toMatch(/from\s+["']\.\/repin-mcp\.mjs["']/);
  });

  it('imports migrateConfig from ./migrate-config.mjs', () => {
    expect(SRC).toMatch(/from\s+["']\.\/migrate-config\.mjs["']/);
  });

  it('imports upsertProject directly from ./index.js (NOT the add-existing handler in ../cli/project.js)', () => {
    expect(SRC).toMatch(/upsertProject[^;]*from\s+["']\.\/index\.js["']/s);
    expect(SRC).not.toMatch(/from\s+["']\.\.\/cli\/project\.js["']/);
  });
});
