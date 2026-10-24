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
import { fileURLToPath } from 'node:url';
import { runDoctor } from '../../packages/cli/src/project/doctor.mjs';
import { buildHookRegistration } from '../../packages/cli/src/project/bootstrap.mjs';
import { CHILD_RKS_ASK_RULES } from '../../packages/cli/src/project/child-permissions.mjs';
import { pruneExtraFiles as realPruneExtraFiles, checkDrift as realCheckDrift } from '../../scripts/sync-hooks.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOK_MANIFEST = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, '.routekit', 'hooks-manifest.json'), 'utf8'),
);
const CANONICAL_HOOKS = buildHookRegistration(HOOK_MANIFEST);

/** The tiered "<tier>/<name>.mjs" of every canonically registered hook command. */
function canonicalHookRelPaths() {
  const out = new Set();
  for (const groups of Object.values(CANONICAL_HOOKS)) {
    for (const g of groups) {
      for (const h of g.hooks) {
        const m = /\.routekit\/hooks\/(\S+\.mjs)/.exec(h.command);
        if (m) out.add(m[1]);
      }
    }
  }
  return [...out];
}

/** Seed the child with the hook scripts its registration points at, so they resolve. */
function seedChildHookScripts(root) {
  for (const rel of canonicalHookRelPaths()) {
    const p = path.join(root, '.routekit', 'hooks', rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '// stub hook\n');
  }
}

function makeShellRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-shell-'));
  fs.mkdirSync(path.join(root, 'packages', 'hooks', 'write'), { recursive: true });
  fs.mkdirSync(path.join(root, 'templates', 'generic', '.routekit', 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(root, 'packages/hooks/write/sample.mjs'), '// canonical\n');
  // backlog.fix.child-hook-registration-repair-and-audit — a real shell SHIPS a hook
  // manifest, and Check 6 fails CLOSED without one (deliberately: a check that cannot
  // see the failure state must never report a pass). A manifest-less fixture would make
  // every child in this file non-recoverable, so this is the fixture becoming honest,
  // not the check being softened.
  fs.mkdirSync(path.join(root, '.routekit'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.routekit', 'hooks-manifest.json'),
    JSON.stringify(HOOK_MANIFEST, null, 2),
  );
  return root;
}

/**
 * @param {object} [o]
 * @param {'valid'|'missing'|'no-hooks-key'|'empty-hooks'|'unresolvable'|'unparseable'} [o.registration]
 *        Check 6 fixture shape. 'no-hooks-key' is the routekit-growth shape: an existing
 *        settings.json whose only top-level key is mcpServers.
 */
function makeChild({ pinned = false, mcpArgs = null, registration = 'valid' } = {}) {
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

  // Check 6's precondition (.routekit/hooks) is satisfied above, so every child in this
  // file is now INSPECTED for hook registration. The default must therefore be a healthy
  // one: scripts on disk AND a canonical, resolvable registration.
  if (registration !== 'unresolvable') seedChildHookScripts(root);
  const settingsPath = path.join(root, '.claude', 'settings.json');
  if (registration !== 'missing') {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    if (registration === 'unparseable') {
      fs.writeFileSync(settingsPath, '{ not valid json');
    } else {
      const body =
        registration === 'no-hooks-key'
          ? { mcpServers: { rks: { command: 'node', args: [] } } }
          : registration === 'empty-hooks'
            ? { mcpServers: {}, hooks: {} }
            : { hooks: CANONICAL_HOOKS };
      fs.writeFileSync(settingsPath, JSON.stringify(body, null, 2));
    }
  }
  return root;
}

function deps(overrides = {}) {
  return {
    syncHooks: vi.fn(),
    checkDrift: vi.fn(() => ({ ok: true, issues: [], srcCount: 0, destCount: 0 })),
    // backlog.fix.doctor-hook-drift-fixer-books-unverified-success: never fall back to real deletion
    // unintentionally — a test that wants the real prune deletes this key.
    pruneExtraFiles: vi.fn(() => ({ removed: [], kept: [] })),
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

// ══════════════════════════════════════════════════════════════════════════════════
// backlog.fix.child-hook-registration-repair-and-audit — Check 6: hook REGISTRATION
// ══════════════════════════════════════════════════════════════════════════════════
//
// Check 2 compares hook SCRIPTS on disk. A real child (routekit-growth) carried all 48
// current scripts and registered NONE of them — every guardrail inert — while preflight,
// upgrade and doctor all reported green. Check 6 is the check that sees that state.
//
// EXIT-CODE CONVENTION (inherited from Checks 2/3, and the reason the FAIL matrix below
// injects a NO-OP fixer): a recoverable finding that the fixer clears books `succeeded`
// and exits 0 — repairing a child is a success, not a failure. So to assert that the
// check FAILS, the fixer must not be allowed to clear it. Injecting `vi.fn()` isolates
// DETECTION from REPAIR and doubles as the deps-injectability proof.
describe('runDoctor — Check 6: per-child hook registration', () => {
  let shellRoot, child;
  beforeEach(() => { shellRoot = makeShellRoot(); });
  afterEach(() => {
    fs.rmSync(shellRoot, { recursive: true, force: true });
    if (child) fs.rmSync(child, { recursive: true, force: true });
    child = null;
  });

  const FAIL_MATRIX = [
    ['no .claude/settings.json at all', 'missing'],
    ['settings.json with no hooks key (the routekit-growth shape)', 'no-hooks-key'],
    ['hooks key present but empty', 'empty-hooks'],
    ['registrations pointing at hook files not on disk in the child', 'unresolvable'],
  ];

  it.each(FAIL_MATRIX)('FAILS on %s — non-zero exit, and the finding is recorded (never silently skipped)', async (_label, registration) => {
    child = makeChild({ registration });
    const noopFixer = vi.fn();
    const d = deps({
      loadProjects: vi.fn(() => [{ id: 'child-x', root: child }]),
      ensureHookRegistration: noopFixer,
    });
    const result = await runDoctor({ shellRoot, dryRun: false, deps: d });

    // MUST NOT SILENTLY SKIP: an absent or empty findings array is a failure, not a pass.
    const finding = result.findings.childHookRegistration.find((c) => c.id === 'child-x');
    expect(finding, 'Check 6 recorded no finding for the broken child').toBeTruthy();
    expect(finding.ok).toBe(false);
    expect(finding.reason).toBeTruthy();

    // The fixer WAS offered the child (deps injectability), and because it did nothing the
    // post-repair verification kept the failure — doctor does not certify an unobserved fix.
    expect(noopFixer).toHaveBeenCalledWith(
      expect.objectContaining({ settingsPath: path.join(child, '.claude', 'settings.json') }),
    );
    expect(result.findings.failed).toBeGreaterThan(0);
    expect(result.exitCode).not.toBe(0);
  });

  it('PASSES a child whose registration is complete and whose every command resolves on disk', async () => {
    child = makeChild({ registration: 'valid' });
    const d = deps({ loadProjects: vi.fn(() => [{ id: 'child-x', root: child }]) });
    const result = await runDoctor({ shellRoot, dryRun: false, deps: d });
    expect(result.findings.childHookRegistration).toEqual([{ id: 'child-x', ok: true }]);
    expect(result.findings.appliedFixers.filter((f) => f.check === 6)).toEqual([]);
    expect(result.exitCode).toBe(0);
  });

  it('WET MODE repairs the routekit-growth fixture via the Check 6 fixer and records it in appliedFixers', async () => {
    child = makeChild({ registration: 'no-hooks-key' });
    const d = deps({ loadProjects: vi.fn(() => [{ id: 'child-x', root: child }]) });
    const result = await runDoctor({ shellRoot, dryRun: false, deps: d });

    expect(result.findings.appliedFixers).toContainEqual({
      check: 6, id: 'child-x', fixer: 'ensureHookRegistration',
    });
    const after = JSON.parse(fs.readFileSync(path.join(child, '.claude', 'settings.json'), 'utf8'));
    expect(after.hooks).toEqual(CANONICAL_HOOKS);
    // MERGE: the pre-existing mcpServers key survives the repair.
    expect(after.mcpServers).toEqual({ rks: { command: 'node', args: [] } });
    // A repaired child is a success, not a failure.
    expect(result.exitCode).toBe(0);
  });

  it('MUST NOT ABSTAIN: an unloadable shell hook manifest is non-recoverable, NOT a pass', async () => {
    // The named anti-pattern: core_skills in preflight.mjs sets skillsPassed = true on
    // manifest_missing, so a child with zero skills gets a green check. Check 6 must fail
    // closed instead — a check that cannot see the failure state has not seen health.
    fs.rmSync(path.join(shellRoot, '.routekit', 'hooks-manifest.json'), { force: true });
    child = makeChild({ registration: 'valid' });
    const d = deps({ loadProjects: vi.fn(() => [{ id: 'child-x', root: child }]) });
    const result = await runDoctor({ shellRoot, dryRun: false, deps: d });

    const finding = result.findings.childHookRegistration.find((c) => c.id === 'child-x');
    expect(finding).toBeTruthy();
    expect(finding.ok).toBe(false); // explicitly NOT a pass
    expect(finding.recoverable).toBe(false);
    expect(result.findings.nonRecoverable.some((nr) => nr.check === 6 && nr.id === 'child-x')).toBe(true);
    expect(result.exitCode).not.toBe(0);
    // No fixer is even attempted: with no manifest there is nothing canonical to write.
    expect(result.findings.appliedFixers.filter((f) => f.check === 6)).toEqual([]);
  });

  it('loadHookManifest is injectable via deps — a null manifest fails closed the same way', async () => {
    child = makeChild({ registration: 'valid' });
    const d = deps({
      loadProjects: vi.fn(() => [{ id: 'child-x', root: child }]),
      loadHookManifest: vi.fn(() => null),
    });
    const result = await runDoctor({ shellRoot, dryRun: false, deps: d });
    expect(d.loadHookManifest).toHaveBeenCalledWith(shellRoot);
    expect(result.findings.nonRecoverable.some((nr) => nr.check === 6)).toBe(true);
    expect(result.exitCode).not.toBe(0);
  });

  it('unparseable settings.json is NON-RECOVERABLE and stays non-zero even under --dry-run', async () => {
    child = makeChild({ registration: 'unparseable' });
    const settingsPath = path.join(child, '.claude', 'settings.json');
    const before = fs.readFileSync(settingsPath, 'utf8');
    const d = deps({ loadProjects: vi.fn(() => [{ id: 'child-x', root: child }]) });

    const dry = await runDoctor({ shellRoot, dryRun: true, deps: d });
    expect(dry.findings.nonRecoverable.some((nr) => nr.check === 6 && nr.id === 'child-x')).toBe(true);
    expect(dry.exitCode).not.toBe(0);
    // Refused, never clobbered.
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe(before);

    const wet = await runDoctor({ shellRoot, dryRun: false, deps: d });
    expect(wet.exitCode).not.toBe(0);
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe(before);
  });

  it('dryRun records the finding and the PLANNED fixer, and mutates nothing', async () => {
    child = makeChild({ registration: 'no-hooks-key' });
    const settingsPath = path.join(child, '.claude', 'settings.json');
    const before = fs.readFileSync(settingsPath, 'utf8');
    const d = deps({ loadProjects: vi.fn(() => [{ id: 'child-x', root: child }]) });
    const result = await runDoctor({ shellRoot, dryRun: true, deps: d });

    expect(result.findings.childHookRegistration.find((c) => c.id === 'child-x').ok).toBe(false);
    expect(result.findings.appliedFixers).toContainEqual({
      check: 6, id: 'child-x', fixer: 'ensureHookRegistration', dryRun: true,
    });
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe(before);
  });

  it('SKIPS only a child with no .routekit/hooks at all — no finding, no fixer, exit 0', async () => {
    // rks makes no claim to govern a project it deployed no hooks into.
    child = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-child-nohooks-'));
    fs.mkdirSync(path.join(child, '.rks'), { recursive: true });
    fs.writeFileSync(path.join(child, '.rks/project.json'), JSON.stringify({ id: 'child-x' }));
    const noopFixer = vi.fn();
    const d = deps({
      loadProjects: vi.fn(() => [{ id: 'child-x', root: child }]),
      ensureHookRegistration: noopFixer,
    });
    const result = await runDoctor({ shellRoot, dryRun: false, deps: d });
    expect(result.findings.childHookRegistration).toEqual([]);
    expect(noopFixer).not.toHaveBeenCalled();
    expect(result.exitCode).toBe(0);
  });

  it('never runs against the shell\'s own record', async () => {
    fs.mkdirSync(path.join(shellRoot, '.routekit', 'hooks'), { recursive: true });
    const noopFixer = vi.fn();
    const d = deps({
      loadProjects: vi.fn(() => [{ id: 'routekit-shell-core', root: shellRoot }]),
      ensureHookRegistration: noopFixer,
    });
    const result = await runDoctor({ shellRoot, dryRun: false, deps: d });
    expect(result.findings.childHookRegistration).toEqual([]);
    expect(noopFixer).not.toHaveBeenCalled();
    expect(result.exitCode).toBe(0);
  });

  it('a Check 6 failure on one child does not abort the loop over the remaining children', async () => {
    child = makeChild({ registration: 'unparseable' }); // non-recoverable, unfixable
    const healthy = makeChild({ registration: 'valid' });
    try {
      const d = deps({
        loadProjects: vi.fn(() => [
          { id: 'broken', root: child },
          { id: 'healthy', root: healthy },
        ]),
      });
      const result = await runDoctor({ shellRoot, dryRun: false, deps: d });
      expect(result.findings.childHookRegistration.map((c) => c.id)).toEqual(['broken', 'healthy']);
      expect(result.findings.childHookRegistration.find((c) => c.id === 'healthy').ok).toBe(true);
      // Check 5 still ran for BOTH children — the loop was not aborted.
      expect(d.migrateConfig).toHaveBeenCalledTimes(2);
    } finally {
      fs.rmSync(healthy, { recursive: true, force: true });
    }
  });
});

// backlog.fix.child-rks-permission-allow-list — Check 7: per-child rks permission rules.
describe('runDoctor — Check 7 rks permission rules', () => {
  let shellRoot, child;
  const extra = [];
  const settingsOf = (root) => path.join(root, '.claude', 'settings.json');
  const readSettings = (root) => JSON.parse(fs.readFileSync(settingsOf(root), 'utf8'));
  const one = (root) => ({ loadProjects: vi.fn(() => [{ id: 'child-x', root }]) });
  const check7 = (result) => result.findings.appliedFixers.filter((f) => f.check === 7);

  beforeEach(() => {
    shellRoot = makeShellRoot();
    child = makeChild();
  });
  afterEach(() => {
    for (const d of [shellRoot, child, ...extra.splice(0)]) fs.rmSync(d, { recursive: true, force: true });
  });

  it('reports the missing entries and repairs them with the real fixer (wet)', async () => {
    const result = await runDoctor({ shellRoot, dryRun: false, deps: deps(one(child)) });
    const finding = result.findings.childPermissionAllow.find((c) => c.id === 'child-x');
    expect(finding.ok).toBe(false);
    expect(finding.missing).toContain('mcp__rks__*');
    for (const t of CHILD_RKS_ASK_RULES) expect(finding.missing).toContain(t);
    expect(check7(result)).toEqual([{ check: 7, id: 'child-x', fixer: 'mergeRksPermissionAllow' }]);
    const s = readSettings(child);
    expect(s.permissions.allow).toContain('mcp__rks__*');
    for (const t of CHILD_RKS_ASK_RULES) expect(s.permissions.ask).toContain(t);
    expect(s.hooks).toEqual(CANONICAL_HOOKS);
    expect(result.exitCode).toBe(0);
  });

  it('post-repair verification: a no-op fixer leaves the finding failed and exit non-zero', async () => {
    const noop = vi.fn(() => ({ changed: true, reason: 'added', added: [], addedAsk: [] }));
    const result = await runDoctor({ shellRoot, dryRun: false, deps: deps({ ...one(child), mergeRksPermissionAllow: noop }) });
    expect(noop).toHaveBeenCalledOnce();
    expect(result.findings.childPermissionAllow.find((c) => c.id === 'child-x').ok).toBe(false);
    expect(result.findings.failed).toBeGreaterThan(0);
    expect(result.exitCode).not.toBe(0);
  });

  it('gate: a child with no .routekit/hooks gets no finding, no fixer call, no write', async () => {
    fs.rmSync(path.join(child, '.routekit'), { recursive: true, force: true });
    const before = fs.readFileSync(settingsOf(child), 'utf8');
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-bare-'));
    extra.push(bare);
    const fixer = vi.fn();
    const d = deps({
      loadProjects: vi.fn(() => [{ id: 'child-x', root: child }, { id: 'bare', root: bare }]),
      mergeRksPermissionAllow: fixer,
    });
    const result = await runDoctor({ shellRoot, dryRun: false, deps: d });
    expect(result.findings.childPermissionAllow).toEqual([]);
    expect(fixer).not.toHaveBeenCalled();
    expect(check7(result)).toEqual([]);
    expect(fs.readFileSync(settingsOf(child), 'utf8')).toBe(before);
    expect(fs.existsSync(settingsOf(bare))).toBe(false);
  });

  it('dryRun records the plan, calls no fixer and writes nothing — also when settings.json is absent', async () => {
    const before = fs.readFileSync(settingsOf(child), 'utf8');
    const fixer = vi.fn();
    const r1 = await runDoctor({ shellRoot, dryRun: true, deps: deps({ ...one(child), mergeRksPermissionAllow: fixer }) });
    expect(check7(r1)).toEqual([{ check: 7, id: 'child-x', fixer: 'mergeRksPermissionAllow', dryRun: true }]);
    expect(fixer).not.toHaveBeenCalled();
    expect(fs.readFileSync(settingsOf(child), 'utf8')).toBe(before);

    const noSettings = makeChild({ registration: 'missing' });
    extra.push(noSettings);
    const r2 = await runDoctor({ shellRoot, dryRun: true, deps: deps(one(noSettings)) });
    expect(r2.findings.childPermissionAllow[0].missing).toContain('mcp__rks__*');
    expect(fs.existsSync(settingsOf(noSettings))).toBe(false);
  });

  it('a compliant child is ok with no fixer; a second wet run after repair is byte-stable', async () => {
    await runDoctor({ shellRoot, dryRun: false, deps: deps(one(child)) });
    const after = fs.readFileSync(settingsOf(child), 'utf8');
    const r2 = await runDoctor({ shellRoot, dryRun: false, deps: deps(one(child)) });
    expect(r2.findings.childPermissionAllow.find((c) => c.id === 'child-x').ok).toBe(true);
    expect(check7(r2)).toEqual([]);
    expect(fs.readFileSync(settingsOf(child), 'utf8')).toBe(after);
  });

  it('an opted-out child is reported, never repaired, and does not fail the run', async () => {
    fs.writeFileSync(
      path.join(child, '.rks', 'project.json'),
      JSON.stringify({ id: 'child-x', claudePermissions: { manageAllowList: false } }, null, 2),
    );
    const before = fs.readFileSync(settingsOf(child), 'utf8');
    const fixer = vi.fn();
    const result = await runDoctor({ shellRoot, dryRun: false, deps: deps({ ...one(child), mergeRksPermissionAllow: fixer }) });
    expect(result.findings.childPermissionAllow.find((c) => c.id === 'child-x').reason).toMatch(/opted.out/);
    expect(fixer).not.toHaveBeenCalled();
    expect(fs.readFileSync(settingsOf(child), 'utf8')).toBe(before);
    expect(result.exitCode).toBe(0);
  });

  it('an unparseable settings.json or settings.local.json is nonRecoverable naming the file, both files untouched', async () => {
    for (const [name, file] of [['settings.json', '.claude/settings.json'], ['settings.local.json', '.claude/settings.local.json']]) {
      const c = makeChild();
      extra.push(c);
      fs.writeFileSync(path.join(c, '.claude', 'settings.local.json'), '{}\n');
      fs.writeFileSync(path.join(c, '.claude', name), '{ not valid json');
      const mainBefore = fs.readFileSync(settingsOf(c), 'utf8');
      const localPath = path.join(c, '.claude', 'settings.local.json');
      const localBefore = fs.readFileSync(localPath, 'utf8');
      const result = await runDoctor({ shellRoot, dryRun: false, deps: deps(one(c)) });
      const nr = result.findings.nonRecoverable.filter((n) => n.check === 7);
      expect(nr.length, name).toBe(1);
      expect(nr[0].reason).toContain(file);
      expect(fs.readFileSync(settingsOf(c), 'utf8')).toBe(mainBefore);
      expect(fs.readFileSync(localPath, 'utf8')).toBe(localBefore);
    }
  });

  it("never runs against the shell's own registry record", async () => {
    fs.mkdirSync(path.join(shellRoot, '.routekit', 'hooks'), { recursive: true });
    const fixer = vi.fn();
    const d = deps({ loadProjects: vi.fn(() => [{ id: 'shell', root: shellRoot }]), mergeRksPermissionAllow: fixer });
    const result = await runDoctor({ shellRoot, dryRun: false, deps: d });
    expect(result.findings.childPermissionAllow.find((c) => c.id === 'shell')).toBeUndefined();
    expect(fixer).not.toHaveBeenCalled();
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

  it('imports mergeRksPermissionAllow from ./child-permissions.mjs (does not redefine)', () => {
    expect(SRC).toMatch(/import\s*\{[^}]*\bmergeRksPermissionAllow\b[^}]*\}\s*from\s*["']\.\/child-permissions\.mjs["']/);
    expect(SRC).not.toMatch(/function\s+mergeRksPermissionAllow/);
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

// ══════════════════════════════════════════════════════════════════════════════════
// backlog.fix.shell-self-sync-skill-wipe-health-gate — doctor is the THIRD wipe vector
// ══════════════════════════════════════════════════════════════════════════════════
//
// setup.mjs registers the SHELL in its own registry, and loadProjects returns every record
// unfiltered. So runDoctor iterates the shell as if it were one of its own children and hands it to
// syncProject with projectRoot === shellRoot — which syncs the shell FROM ITSELF and deletes its
// skills. `routekit doctor`, the tool you run when something feels wrong, was quietly eating them.
//
// FIXTURE REACHABILITY (the trap): makeShellRoot() above does NOT create <shellRoot>/.routekit/hooks,
// and Check 2 is gated on exactly that. Without it a shell record never reaches syncProject at all —
// so this test would pass against the UNFIXED code, "witnessing" a wipe it structurally cannot see.
// We create that directory on purpose, so the shell record genuinely WOULD be synced, and the skip is
// the only thing stopping it.
describe('runDoctor — the shell is not one of its own children', () => {
  let shellRoot, child;
  beforeEach(() => {
    shellRoot = makeShellRoot();
    // Make the shell record REACHABLE by Check 2 — otherwise the guard is untested.
    fs.mkdirSync(path.join(shellRoot, '.routekit', 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(shellRoot, '.routekit/hooks/sample.mjs'), '// drifted\n');
    child = makeChild();
  });
  afterEach(() => {
    fs.rmSync(shellRoot, { recursive: true, force: true });
    fs.rmSync(child, { recursive: true, force: true });
  });

  it('SKIPS the shell\'s own registry record while still fixing a real child', async () => {
    const d = deps({
      // The registry holds BOTH — exactly what setup.mjs produces.
      loadProjects: vi.fn(() => [
        { id: 'routekit-shell-core', root: shellRoot },
        { id: 'child-x', root: child },
      ]),
      // Drift on every pre-fix judge, so nothing is skipped for lack of drift. The post-fix re-check
      // (same src/dest pair, second call) is clean: the fix cleared the drift, so nothing is failed.
      checkDrift: (() => {
        const seen = new Set();
        return vi.fn((src, dest) => {
          const key = `${src}\u0000${dest}`;
          if (seen.has(key)) return { ok: true, issues: [] };
          seen.add(key);
          return { ok: false, issues: ['drift'] };
        });
      })(),
    });

    const { findings } = await runDoctor({ shellRoot, dryRun: false, deps: d });

    // POSITIVE CONTROL — the loop genuinely RAN and reached the fixer. Without this, "the shell was
    // not synced" is also true of a doctor that fell over before the loop.
    expect(d.syncProject).toHaveBeenCalledWith({ projectRoot: child, projectId: 'child-x', shellRoot });

    // THE CLAIM: no fixer of ANY kind ran against the shell. Not just syncProject — Checks 3 and 5
    // are in the same loop, and migrateConfig WRITES the shell's own .rks/project.json.
    const againstShell = expect.objectContaining({ projectRoot: shellRoot });
    expect(d.syncProject).not.toHaveBeenCalledWith(againstShell);
    expect(d.repinMcpServer).not.toHaveBeenCalledWith(againstShell);
    expect(d.migrateConfig).not.toHaveBeenCalledWith(againstShell);

    // And it is a SKIP, not a swallowed throw. syncProject now refuses self-targeting loudly, and
    // Check 2's catch books any throw as failed + nonRecoverable — so if we had let it reach the
    // fixer, `routekit doctor` would report a permanent, unfixable failure against the shell on every
    // single run, on the very tool that is supposed to tell you the ecosystem is healthy.
    expect(findings.failed).toBe(0);
    expect(findings.nonRecoverable).toEqual([]);
    expect(findings.skippedShellRecord).toEqual({ id: 'routekit-shell-core', root: shellRoot });
  });
});

// ══════════════════════════════════════════════════════════════════════════════════
// backlog.fix.upgrade-never-restores-vitest-unit-shim — Check 8: per-child vitest files
// ══════════════════════════════════════════════════════════════════════════════════
//
// The REAL seedVitestFiles runs here (it is not in deps()), against a temp shell that either
// carries templates/base + scripts or deliberately does not.
describe('runDoctor — Check 8: per-child vitest files (childVitestShim)', () => {
  const SHIM = 'vitest.config.unit.mjs';
  const BASE = 'vitest.config.base.mjs';
  const RUNNER = path.join('scripts', 'vitest-runner.mjs');
  const SPAWN = path.join('scripts', 'lib', 'spawn-managed.mjs');
  const ALL = [SHIM, BASE, RUNNER, SPAWN];
  const TPL_SHIM = '// template shim\nexport default {};\n';

  let shellRoot, child;
  const put = (root, rel, body) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  };
  const read = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8');
  const exists = (root, rel) => fs.existsSync(path.join(root, rel));
  const check8 = (result) => result.findings.appliedFixers.filter((f) => f.check === 8);
  const one = (root) => ({ loadProjects: vi.fn(() => [{ id: 'child-x', root }]) });

  function addShellSources(root) {
    put(root, path.join('templates', 'base', SHIM), TPL_SHIM);
    put(root, path.join('templates', 'base', BASE), '// template base\n');
    put(root, RUNNER, '// shell runner\n');
    put(root, SPAWN, '// shell spawn\n');
  }

  beforeEach(() => {
    shellRoot = makeShellRoot();
    child = makeChild();
  });
  afterEach(() => {
    fs.rmSync(shellRoot, { recursive: true, force: true });
    fs.rmSync(child, { recursive: true, force: true });
  });

  it('reports a childVitestShim entry naming the child and listing the missing shim', async () => {
    addShellSources(shellRoot);
    const result = await runDoctor({ shellRoot, dryRun: true, deps: deps(one(child)) });
    const entry = result.findings.childVitestShim.find((e) => e.id === 'child-x');
    expect(entry).toBeDefined();
    expect(entry.missing).toContain(SHIM);
  });

  it('wet: restores the shim from templates/base and books a check 8 fixer only once it exists', async () => {
    addShellSources(shellRoot);
    const result = await runDoctor({ shellRoot, dryRun: false, deps: deps(one(child)) });
    expect(read(child, SHIM)).toBe(TPL_SHIM);
    expect(check8(result)).toEqual([{ check: 8, id: 'child-x', fixer: 'seedVitestFiles' }]);
    const entry = result.findings.childVitestShim.find((e) => e.id === 'child-x');
    expect(entry.created).toContain(SHIM);
    for (const rel of entry.created) expect(exists(child, rel)).toBe(true);
    expect(result.findings.succeeded).toBeGreaterThanOrEqual(1);
    expect(result.exitCode).toBe(0);
  });

  it('wet: a customised runner and spawn-managed stay byte-identical while the missing shim is restored', async () => {
    addShellSources(shellRoot);
    put(child, RUNNER, '// MY runner\n');
    put(child, SPAWN, '// MY spawn\n');
    await runDoctor({ shellRoot, dryRun: false, deps: deps(one(child)) });
    expect(exists(child, SHIM)).toBe(true);
    expect(read(child, RUNNER)).toBe('// MY runner\n');
    expect(read(child, SPAWN)).toBe('// MY spawn\n');
  });

  it('dryRun: reports the finding and the planned fixer, writes nothing into the child', async () => {
    addShellSources(shellRoot);
    put(child, RUNNER, '// MY runner\n');
    const result = await runDoctor({ shellRoot, dryRun: true, deps: deps(one(child)) });
    expect(result.findings.childVitestShim.find((e) => e.id === 'child-x').missing).toContain(SHIM);
    expect(check8(result)).toEqual([{ check: 8, id: 'child-x', fixer: 'seedVitestFiles', dryRun: true }]);
    expect(exists(child, SHIM)).toBe(false);
    expect(exists(child, BASE)).toBe(false);
    expect(exists(child, SPAWN)).toBe(false);
    expect(read(child, RUNNER)).toBe('// MY runner\n');
  });

  it('a child with all four files gets no entry and its files are not modified', async () => {
    addShellSources(shellRoot);
    for (const rel of ALL) put(child, rel, `// CUSTOM ${rel}\n`);
    const result = await runDoctor({ shellRoot, dryRun: false, deps: deps(one(child)) });
    expect(result.findings.childVitestShim.find((e) => e.id === 'child-x')).toBeUndefined();
    expect(check8(result)).toEqual([]);
    for (const rel of ALL) expect(read(child, rel)).toBe(`// CUSTOM ${rel}\n`);
  });

  it('template missing: reported on the entry, no fixer, not failed, not nonRecoverable, exit 0', async () => {
    // makeShellRoot() carries no templates/base and no scripts — the existing-fixture shape.
    const result = await runDoctor({ shellRoot, dryRun: false, deps: deps(one(child)) });
    const entry = result.findings.childVitestShim.find((e) => e.id === 'child-x');
    expect(entry.templateMissing).toContain(SHIM);
    expect(entry.created).toEqual([]);
    expect(exists(child, SHIM)).toBe(false);
    expect(check8(result)).toEqual([]);
    expect(result.findings.failed).toBe(0);
    expect(result.findings.nonRecoverable).toEqual([]);
    expect(result.exitCode).toBe(0);
  });

  it('a throwing seeder is failed + nonRecoverable with check 8 (existing fixer pattern)', async () => {
    const d = deps({ ...one(child), seedVitestFiles: vi.fn(() => { throw new Error('EACCES'); }) });
    const result = await runDoctor({ shellRoot, dryRun: false, deps: d });
    expect(result.findings.nonRecoverable).toContainEqual({ check: 8, id: 'child-x', reason: 'EACCES' });
    expect(result.exitCode).toBe(1);
  });

  it('never runs against the shell\'s own registry record', async () => {
    const seeder = vi.fn(() => ({ created: [], templateMissing: [] }));
    const d = deps({ loadProjects: vi.fn(() => [{ id: 'shell', root: shellRoot }]), seedVitestFiles: seeder });
    const result = await runDoctor({ shellRoot, dryRun: false, deps: d });
    expect(result.findings.childVitestShim).toEqual([]);
    expect(seeder).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════════════════════════
// backlog.fix.doctor-hook-drift-fixer-books-unverified-success — Checks 1 and 2 prune
// orphans, re-check drift after the fixer, and book from the re-check
// ══════════════════════════════════════════════════════════════════════════════════
//
// Every fixture is a mkdtemp tree; nothing here touches the real repo's hooks trees.
describe('runDoctor — Checks 1 and 2: prune, re-check, book from the observed result', () => {
  const ORPHAN = path.join('write', 'retired-probe.mjs');
  const ORPHAN_2 = path.join('read', 'retired-probe-2.mjs');
  const LIB_ORPHAN = path.join('lib', 'retired-helper.mjs');
  const NESTED_LIB_ORPHAN = path.join('write', 'lib', 'retired-helper.mjs');
  const EXTRA = (rel) => `extra in dest (not in canonical): ${rel}`;
  const temps = [];
  const track = (...dirs) => { temps.push(...dirs); return dirs; };
  afterEach(() => { for (const d of temps.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

  const templateOf = (shell) => path.join(shell, 'templates', 'generic', '.routekit', 'hooks');
  const canonicalOf = (shell) => path.join(shell, 'packages', 'hooks');
  const hooksOf = (child) => path.join(child, '.routekit', 'hooks');
  const put = (p, body) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); };
  function snapshot(dir) {
    if (!fs.existsSync(dir)) return [];
    const out = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else out.push([path.relative(dir, p), fs.readFileSync(p, 'utf8')]);
      }
    };
    walk(dir);
    return out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  }
  /** Backups of `rel` (relative to root) under <root>/.rks/.backup/. */
  function backupsOf(root, rel) {
    const dir = path.join(root, '.rks', '.backup', path.dirname(rel));
    if (!fs.existsSync(dir)) return [];
    const re = new RegExp(`^${path.basename(rel).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.bak\\.\\d+$`);
    return fs.readdirSync(dir).filter((f) => re.test(f)).map((f) => path.join(dir, f));
  }

  /** A shell + child whose canonical, template and child hook trees are identical (no drift). */
  function makePair({ registration = 'valid' } = {}) {
    const shell = makeShellRoot();
    fs.mkdirSync(path.join(shell, '.rks'), { recursive: true }); // owning root for Check 1 backups
    const child = makeChild({ registration });
    track(shell, child);
    for (const dir of [canonicalOf(shell), templateOf(shell)]) {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.cpSync(hooksOf(child), dir, { recursive: true });
    }
    return { shell, child };
  }
  const oneChild = (child) => ({ loadProjects: vi.fn(() => [{ id: 'child-x', root: child }]) });
  /** deps() with the REAL checkDrift and REAL prune (fixers stay injected no-ops). */
  function realDeps(child, overrides = {}) {
    const d = deps({ ...(child ? oneChild(child) : {}), ...overrides });
    if (!('checkDrift' in overrides)) delete d.checkDrift;
    if (!('pruneExtraFiles' in overrides)) delete d.pruneExtraFiles;
    return d;
  }
  /** succeeded/failed of an identical but drift-free fixture — the other checks' contribution. */
  async function baseline({ registration = 'valid', withChild = true } = {}) {
    const { shell, child } = makePair({ registration });
    const { findings } = await runDoctor({ shellRoot: shell, dryRun: false, deps: realDeps(withChild ? child : null) });
    return { succeeded: findings.succeeded, failed: findings.failed };
  }
  const nr = (findings, check, id) =>
    findings.nonRecoverable.filter((n) => n.check === check && (id === undefined ? n.id === undefined : n.id === id));
  const fixerEntry = (findings, check) => findings.appliedFixers.find((f) => f.check === check && !f.dryRun);
  function registerIn(child, file, rel) {
    const p = path.join(child, '.claude', file);
    const settings = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};
    settings.hooks = settings.hooks || {};
    settings.hooks.PreToolUse = [
      ...(settings.hooks.PreToolUse || []),
      { matcher: 'Bash', hooks: [{ type: 'command', command: `node "$CLAUDE_PROJECT_DIR"/.routekit/hooks/${rel.split(path.sep).join('/')}` }] },
    ];
    put(p, JSON.stringify(settings, null, 2));
  }

  // ── Check 2, real temp dirs ────────────────────────────────────────────────────
  it('Check 2: an unregistered child orphan is pruned, post-fix drift is ok, the entry lists it, succeeded counts it', async () => {
    const base = await baseline();
    const { shell, child } = makePair();
    put(path.join(hooksOf(child), ORPHAN), '// orphan\n');
    const { findings } = await runDoctor({ shellRoot: shell, dryRun: false, deps: realDeps(child) });

    expect(fs.existsSync(path.join(hooksOf(child), ORPHAN))).toBe(false);
    const entry = fixerEntry(findings, 2);
    expect(entry).toMatchObject({ check: 2, id: 'child-x', fixer: 'syncProject', pruned: [ORPHAN], kept: [] });
    expect(entry.postFixDrift.ok).toBe(true);
    expect(findings.succeeded).toBe(base.succeeded + 1);
    expect(findings.failed).toBe(base.failed);
    expect(nr(findings, 2, 'child-x')).toEqual([]);
  });

  it('Check 1: a template orphan absent from packages/hooks is pruned, entry carries it and an ok post-fix drift', async () => {
    const base = await baseline({ withChild: false });
    const { shell } = makePair();
    put(path.join(templateOf(shell), ORPHAN), '// template orphan\n');
    const { findings } = await runDoctor({ shellRoot: shell, dryRun: false, deps: realDeps(null) });

    expect(fs.existsSync(path.join(templateOf(shell), ORPHAN))).toBe(false);
    const entry = fixerEntry(findings, 1);
    expect(entry).toMatchObject({ check: 1, fixer: 'syncHooks', pruned: [ORPHAN], kept: [] });
    expect(entry.postFixDrift.ok).toBe(true);
    expect(findings.succeeded).toBe(base.succeeded + 1);
    expect(findings.failed).toBe(base.failed);
  });

  it('every pruned file (Check 1 and Check 2) has exactly one byte-identical backup under the owning root .rks/.backup; nothing is written into the dest trees or hooks.bak', async () => {
    const { shell, child } = makePair();
    put(path.join(templateOf(shell), ORPHAN), '// template orphan body\n');
    put(path.join(hooksOf(child), ORPHAN), '// child orphan body\n');
    put(path.join(child, '.routekit', 'hooks.bak', 'write', 'parked.mjs'), '// parked\n');
    const templateAfterExpected = snapshot(templateOf(shell)).filter(([f]) => f !== ORPHAN);
    const childAfterExpected = snapshot(hooksOf(child)).filter(([f]) => f !== ORPHAN);
    const bakBefore = snapshot(path.join(child, '.routekit', 'hooks.bak'));

    await runDoctor({ shellRoot: shell, dryRun: false, deps: realDeps(child) });

    const childBackups = backupsOf(child, path.join('.routekit', 'hooks', ORPHAN));
    expect(childBackups).toHaveLength(1);
    expect(fs.readFileSync(childBackups[0], 'utf8')).toBe('// child orphan body\n');
    const shellBackups = backupsOf(shell, path.join('templates', 'generic', '.routekit', 'hooks', ORPHAN));
    expect(shellBackups).toHaveLength(1);
    expect(fs.readFileSync(shellBackups[0], 'utf8')).toBe('// template orphan body\n');

    expect(snapshot(templateOf(shell))).toEqual(templateAfterExpected);
    expect(snapshot(hooksOf(child))).toEqual(childAfterExpected);
    expect(snapshot(path.join(child, '.routekit', 'hooks.bak'))).toEqual(bakBefore);
  });

  it('a populated .routekit/hooks.bak stays byte-identical and the prune dependency never sees a hooks.bak path', async () => {
    const { shell, child } = makePair();
    const bak = path.join(child, '.routekit', 'hooks.bak');
    put(path.join(bak, 'write', 'retired-probe.mjs'), '// parked tier\n');
    put(path.join(bak, 'read', 'parked-read.mjs'), '// parked read tier\n');
    put(path.join(hooksOf(child), ORPHAN), '// orphan\n');
    const before = snapshot(bak);
    const prune = vi.fn(realPruneExtraFiles);

    await runDoctor({ shellRoot: shell, dryRun: false, deps: realDeps(child, { pruneExtraFiles: prune }) });

    expect(prune).toHaveBeenCalled(); // positive control: the child really was pruned
    expect(fs.existsSync(path.join(hooksOf(child), ORPHAN))).toBe(false);
    expect(snapshot(bak)).toEqual(before);
    for (const args of prune.mock.calls) {
      for (const a of args.slice(0, 2)) expect(a.includes('hooks.bak')).toBe(false);
    }
  });

  it.each([
    ['settings.json'],
    ['settings.local.json'],
  ])('Check 2: an orphan registered only in .claude/%s is kept, named with the registering file; failed not succeeded; an unregistered orphan is still pruned', async (file) => {
    const base = await baseline();
    const { shell, child } = makePair();
    put(path.join(hooksOf(child), ORPHAN), '// registered orphan\n');
    put(path.join(hooksOf(child), ORPHAN_2), '// unregistered orphan\n');
    registerIn(child, file, ORPHAN);

    const { findings } = await runDoctor({ shellRoot: shell, dryRun: false, deps: realDeps(child) });

    expect(fs.readFileSync(path.join(hooksOf(child), ORPHAN), 'utf8')).toBe('// registered orphan\n');
    expect(fs.existsSync(path.join(hooksOf(child), ORPHAN_2))).toBe(false);
    const entries = nr(findings, 2, 'child-x');
    expect(entries).toHaveLength(1);
    expect(entries[0].reason).toContain('write/retired-probe.mjs');
    expect(entries[0].reason).toContain(`.claude/${file}`);
    expect(fixerEntry(findings, 2)).toMatchObject({ pruned: [ORPHAN_2], kept: [ORPHAN] });
    expect(findings.succeeded).toBe(base.succeeded);
    expect(findings.failed).toBe(base.failed + 1);
  });

  it.each([
    ['settings.json'],
    ['settings.local.json'],
  ])('Check 2: an unparseable .claude/%s prunes nothing in the child and is named in nonRecoverable', async (file) => {
    const { shell, child } = makePair();
    put(path.join(hooksOf(child), ORPHAN), '// orphan\n');
    put(path.join(child, '.claude', file), '{ not valid json');
    const before = snapshot(hooksOf(child));
    const prune = vi.fn(realPruneExtraFiles);

    const { findings } = await runDoctor({ shellRoot: shell, dryRun: false, deps: realDeps(child, { pruneExtraFiles: prune }) });

    expect(snapshot(hooksOf(child))).toEqual(before);
    expect(prune.mock.calls.filter(([, dest]) => dest === hooksOf(child))).toEqual([]);
    expect(nr(findings, 2, 'child-x').some((n) => n.reason.includes(`.claude/${file}`))).toBe(true);
    expect(backupsOf(child, path.join('.routekit', 'hooks', ORPHAN))).toEqual([]);
  });

  it('Check 2: a child with no .claude/settings.json at all still has its unregistered orphan pruned', async () => {
    const { shell, child } = makePair({ registration: 'missing' });
    put(path.join(hooksOf(child), ORPHAN), '// orphan\n');
    await runDoctor({ shellRoot: shell, dryRun: false, deps: realDeps(child) });
    expect(fs.existsSync(path.join(hooksOf(child), ORPHAN))).toBe(false);
  });

  it('Check 2: a lib/ orphan is kept (not deleted, not backed up) with exactly one nonRecoverable entry; a non-lib orphan is still pruned', async () => {
    const base = await baseline();
    const { shell, child } = makePair();
    put(path.join(hooksOf(child), LIB_ORPHAN), '// shared module\n');
    put(path.join(hooksOf(child), ORPHAN), '// orphan\n');

    const { findings } = await runDoctor({ shellRoot: shell, dryRun: false, deps: realDeps(child) });

    expect(fs.readFileSync(path.join(hooksOf(child), LIB_ORPHAN), 'utf8')).toBe('// shared module\n');
    expect(backupsOf(child, path.join('.routekit', 'hooks', LIB_ORPHAN))).toEqual([]);
    expect(fs.existsSync(path.join(hooksOf(child), ORPHAN))).toBe(false);
    const entry = fixerEntry(findings, 2);
    expect(entry.kept).toEqual([LIB_ORPHAN]);
    expect(entry.pruned).toEqual([ORPHAN]);
    const entries = nr(findings, 2, 'child-x');
    expect(entries).toHaveLength(1);
    expect(entries[0].reason).toContain('lib/retired-helper.mjs');
    expect(findings.failed).toBe(base.failed + 1);
    expect(findings.succeeded).toBe(base.succeeded);
  });

  it('Check 2: a dest-only file in a nested lib directory is kept and not deleted', async () => {
    const { shell, child } = makePair();
    put(path.join(hooksOf(child), NESTED_LIB_ORPHAN), '// nested shared module\n');
    const { findings } = await runDoctor({ shellRoot: shell, dryRun: false, deps: realDeps(child) });
    expect(fs.readFileSync(path.join(hooksOf(child), NESTED_LIB_ORPHAN), 'utf8')).toBe('// nested shared module\n');
    expect(fixerEntry(findings, 2).kept).toEqual([NESTED_LIB_ORPHAN]);
  });

  // ── Rule 2e: manifest-named child files are never pruned ────────────────────────
  const MANIFEST_ORPHAN = path.join('write', 'manifest-probe.mjs');
  const withProbe = () => ({
    ...HOOK_MANIFEST,
    'manifest-probe': { tier: 'write', path: 'write/manifest-probe.mjs' },
  });

  it('Check 2: a manifest-named orphan is kept (not deleted, not backed up) with one nonRecoverable entry naming the hook manifest; an unrelated orphan is pruned', async () => {
    const base = await baseline();
    const { shell, child } = makePair();
    put(path.join(hooksOf(child), MANIFEST_ORPHAN), '// manifest-named hook\n');
    put(path.join(hooksOf(child), ORPHAN), '// orphan\n');

    const { findings } = await runDoctor({
      shellRoot: shell,
      dryRun: false,
      deps: realDeps(child, { loadHookManifest: vi.fn(() => withProbe()) }),
    });

    expect(fs.readFileSync(path.join(hooksOf(child), MANIFEST_ORPHAN), 'utf8')).toBe('// manifest-named hook\n');
    expect(backupsOf(child, path.join('.routekit', 'hooks', MANIFEST_ORPHAN))).toEqual([]);
    expect(fs.existsSync(path.join(hooksOf(child), ORPHAN))).toBe(false);
    const entry = fixerEntry(findings, 2);
    expect(entry.kept).toEqual([MANIFEST_ORPHAN]);
    expect(entry.pruned).toEqual([ORPHAN]);
    const entries = nr(findings, 2, 'child-x');
    expect(entries).toHaveLength(1);
    expect(entries[0].reason).toContain('write/manifest-probe.mjs');
    expect(entries[0].reason).toContain('hook manifest');
    expect(findings.failed).toBe(base.failed + 1);
    expect(findings.succeeded).toBe(base.succeeded);
  });

  it('Check 2: a null hook manifest keeps nothing under the manifest rule — an unregistered non-lib orphan is still pruned', async () => {
    const { shell, child } = makePair();
    put(path.join(hooksOf(child), MANIFEST_ORPHAN), '// would be manifest-named\n');
    put(path.join(hooksOf(child), ORPHAN), '// orphan\n');

    const { findings } = await runDoctor({
      shellRoot: shell,
      dryRun: false,
      deps: realDeps(child, { loadHookManifest: vi.fn(() => null) }),
    });

    expect(fs.existsSync(path.join(hooksOf(child), MANIFEST_ORPHAN))).toBe(false);
    expect(fs.existsSync(path.join(hooksOf(child), ORPHAN))).toBe(false);
    const entry = fixerEntry(findings, 2);
    expect(entry.kept).toEqual([]);
    expect([...entry.pruned].sort()).toEqual([ORPHAN, MANIFEST_ORPHAN].sort());
    expect(nr(findings, 2, 'child-x').some((n) => n.reason.includes('hook manifest') && n.reason.includes('kept'))).toBe(false);
  });

  it('Check 1: a template lib/ orphan is kept, listed as kept, one check 1 nonRecoverable entry, failed incremented', async () => {
    const base = await baseline({ withChild: false });
    const { shell } = makePair();
    put(path.join(templateOf(shell), LIB_ORPHAN), '// shared module\n');

    const { findings } = await runDoctor({ shellRoot: shell, dryRun: false, deps: realDeps(null) });

    expect(fs.readFileSync(path.join(templateOf(shell), LIB_ORPHAN), 'utf8')).toBe('// shared module\n');
    expect(fixerEntry(findings, 1).kept).toEqual([LIB_ORPHAN]);
    const entries = nr(findings, 1);
    expect(entries).toHaveLength(1);
    expect(entries[0].reason).toContain('lib/retired-helper.mjs');
    expect(findings.failed).toBe(base.failed + 1);
  });

  it('kept-only residue (a registered orphan and a lib/ orphan) → exactly the two per-file entries, no residual-issues entry, failed +1', async () => {
    const base = await baseline();
    const { shell, child } = makePair();
    put(path.join(hooksOf(child), ORPHAN), '// registered orphan\n');
    put(path.join(hooksOf(child), LIB_ORPHAN), '// shared module\n');
    registerIn(child, 'settings.json', ORPHAN);

    const { findings } = await runDoctor({ shellRoot: shell, dryRun: false, deps: realDeps(child) });

    const entries = nr(findings, 2, 'child-x');
    expect(entries).toHaveLength(2);
    expect(entries.some((n) => n.reason.includes('write/retired-probe.mjs'))).toBe(true);
    expect(entries.some((n) => n.reason.includes('lib/retired-helper.mjs'))).toBe(true);
    expect(entries.some((n) => n.reason.includes('extra in dest'))).toBe(false);
    expect(findings.failed).toBe(base.failed + 1);
  });

  it('a kept file plus a residual content-differs issue → the per-file entry plus one residual entry naming only the content drift', async () => {
    const { shell, child } = makePair();
    put(path.join(hooksOf(child), LIB_ORPHAN), '// shared module\n');
    const victim = snapshot(hooksOf(child)).map(([f]) => f).find((f) => f !== LIB_ORPHAN);
    fs.writeFileSync(path.join(hooksOf(child), victim), '// locally edited\n');

    // No-op syncProject (deps default) cannot clear the content drift.
    const { findings } = await runDoctor({ shellRoot: shell, dryRun: false, deps: realDeps(child) });

    const entries = nr(findings, 2, 'child-x');
    expect(entries).toHaveLength(2);
    const kept = entries.filter((n) => n.reason.includes('lib/retired-helper.mjs'));
    expect(kept).toHaveLength(1);
    const residual = entries.filter((n) => n.reason.includes('content differs'));
    expect(residual).toHaveLength(1);
    expect(residual[0].reason).toContain(`content differs: ${victim}`);
    expect(residual[0].reason).not.toContain('lib/retired-helper.mjs');
  });

  // ── injected checkDrift contracts ─────────────────────────────────────────────
  it('Check 2: drift the fixer leaves → not succeeded, failed, nonRecoverable names the residual issue', async () => {
    const base = await baseline();
    const { shell, child } = makePair();
    const d = deps({
      ...oneChild(child),
      checkDrift: vi.fn((src, dest) =>
        dest === hooksOf(child) ? { ok: false, issues: ['content differs: write/x.mjs'] } : { ok: true, issues: [] }),
    });
    const { findings } = await runDoctor({ shellRoot: shell, dryRun: false, deps: d });
    expect(findings.succeeded).toBe(base.succeeded);
    expect(findings.failed).toBe(base.failed + 1);
    const entries = nr(findings, 2, 'child-x');
    expect(entries).toHaveLength(1);
    expect(entries[0].reason).toContain('content differs: write/x.mjs');
  });

  it('Check 1: drift the fixer leaves → not succeeded, failed, nonRecoverable names the residual issue', async () => {
    const { shell } = makePair();
    const d = deps({
      checkDrift: vi.fn(() => ({ ok: false, issues: ['content differs: write/x.mjs'] })),
    });
    const { findings } = await runDoctor({ shellRoot: shell, dryRun: false, deps: d });
    expect(d.syncHooks).toHaveBeenCalledTimes(1);
    expect(findings.succeeded).toBe(0);
    expect(findings.failed).toBe(1);
    const entries = nr(findings, 1);
    expect(entries).toHaveLength(1);
    expect(entries[0].reason).toContain('content differs: write/x.mjs');
  });

  it('wet run: checkDrift is called a second time with the same (src, dest) pair after each fixer', async () => {
    const { shell, child } = makePair();
    const seen = new Set();
    const d = deps({
      ...oneChild(child),
      checkDrift: vi.fn((src, dest) => {
        const k = `${src}|${dest}`;
        if (seen.has(k)) return { ok: true, issues: [] };
        seen.add(k);
        return { ok: false, issues: ['content differs: write/x.mjs'] };
      }),
    });
    const { findings } = await runDoctor({ shellRoot: shell, dryRun: false, deps: d });
    const calls = d.checkDrift.mock.calls;
    expect(calls.filter(([s, t]) => s === canonicalOf(shell) && t === templateOf(shell))).toHaveLength(2);
    expect(calls.filter(([s, t]) => s === templateOf(shell) && t === hooksOf(child))).toHaveLength(2);
    expect(fixerEntry(findings, 1).postFixDrift.ok).toBe(true);
    expect(fixerEntry(findings, 2).postFixDrift.ok).toBe(true);
    expect(nr(findings, 1)).toEqual([]);
    expect(nr(findings, 2, 'child-x')).toEqual([]);
  });

  it('dry run with drift (orphans on disk) deletes nothing, calls no fixer or prune, one checkDrift per pair', async () => {
    const { shell, child } = makePair();
    put(path.join(templateOf(shell), ORPHAN), '// template orphan\n');
    put(path.join(hooksOf(child), ORPHAN), '// child orphan\n');
    const tplBefore = snapshot(templateOf(shell));
    const childBefore = snapshot(hooksOf(child));
    const d = deps({ ...oneChild(child), checkDrift: vi.fn(realCheckDrift) });

    const { findings } = await runDoctor({ shellRoot: shell, dryRun: true, deps: d });

    expect(snapshot(templateOf(shell))).toEqual(tplBefore);
    expect(snapshot(hooksOf(child))).toEqual(childBefore);
    expect(d.syncHooks).not.toHaveBeenCalled();
    expect(d.syncProject).not.toHaveBeenCalled();
    expect(d.pruneExtraFiles).not.toHaveBeenCalled();
    expect(d.checkDrift.mock.calls).toEqual([
      [canonicalOf(shell), templateOf(shell)],
      [templateOf(shell), hooksOf(child)],
    ]);
    expect(findings.appliedFixers.filter((f) => f.check === 1 || f.check === 2).every((f) => f.dryRun === true)).toBe(true);
  });

  it('a clean tree calls no syncHooks, syncProject or prune and books nothing for Checks 1 and 2', async () => {
    const { shell, child } = makePair();
    const d = deps(oneChild(child));
    const { findings } = await runDoctor({ shellRoot: shell, dryRun: false, deps: d });
    expect(d.syncHooks).not.toHaveBeenCalled();
    expect(d.syncProject).not.toHaveBeenCalled();
    expect(d.pruneExtraFiles).not.toHaveBeenCalled();
    expect(findings.appliedFixers.filter((f) => f.check === 1 || f.check === 2)).toEqual([]);
    expect(findings.nonRecoverable.filter((n) => n.check === 1 || n.check === 2)).toEqual([]);
  });

  it('a throwing fixer keeps today\'s handling: failed, nonRecoverable from the error, no re-check booked as success', async () => {
    const { shell, child } = makePair();
    const seen = new Set();
    const d = deps({
      ...oneChild(child),
      syncHooks: vi.fn(() => { throw new Error('EACCES: template write refused'); }),
      syncProject: vi.fn(() => { throw new Error('EACCES: sync refused'); }),
      checkDrift: vi.fn((src, dest) => {
        const k = `${src}|${dest}`;
        if (seen.has(k)) return { ok: true, issues: [] };
        seen.add(k);
        return { ok: false, issues: ['content differs: write/x.mjs'] };
      }),
    });
    const { findings } = await runDoctor({ shellRoot: shell, dryRun: false, deps: d });
    expect(findings.nonRecoverable).toContainEqual({ check: 1, reason: 'EACCES: template write refused' });
    expect(findings.nonRecoverable).toContainEqual({ check: 2, id: 'child-x', reason: 'EACCES: sync refused' });
    expect(d.checkDrift).toHaveBeenCalledTimes(2); // pre-fix judges only — no post-fix re-check
    expect(d.pruneExtraFiles).not.toHaveBeenCalled();
    expect(findings.appliedFixers.filter((f) => f.check === 1 || f.check === 2)).toEqual([]);
    expect(findings.failed).toBeGreaterThanOrEqual(2);
  });
});
