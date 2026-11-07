// CREATE FILE: tests/unit/doctor-release-pin.test.mjs
/**
 * backlog.fix.doctor-repins-release-pinned-children — unit witnesses for runDoctor's per-child
 * shell resolver and the REPORT-ONLY contract (user decision): doctor never writes to a child
 * pinned to another rks shell. For such a child Checks 2, 3, 5, 6, 7 and 8 only report; Checks
 * 9a and 9b still run. Each shell's doctor repairs only its own children.
 *
 * `routekit project upgrade --from-release <R>` leaves a child with
 *   .mcp.json mcpServers.rks.args[0] = <R>/packages/mcp-rks/bin/mcp-rks.mjs
 *   .rks/project.json rksVersion     = <R>/package.json version
 * Doctor run from a DIFFERENT shell used to repin that child (Check 3), resync its hooks (Check 2)
 * and rewrite its hook registration (Check 6) from the invoking shell. Cases marked RED reproduce
 * that against the unfixed doctor.mjs.
 *
 * Deterministic: every shell, release root and child is a mkdtemp fixture. Nothing reads a real
 * ../routekit-shell-release, and git is never spawned (Check 9b is injected).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { runDoctor, resolveChildShellRoot, inspectHookRegistration } from '../../packages/cli/src/project/doctor.mjs';
import { shellMcpBinary } from '../../packages/cli/src/project/repin-mcp.mjs';
import { buildHookRegistration } from '../../packages/cli/src/project/bootstrap.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOK_MANIFEST = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, '.routekit', 'hooks-manifest.json'), 'utf8'),
);
const CANONICAL_HOOKS = buildHookRegistration(HOOK_MANIFEST);
const BIN_REL = path.join('packages', 'mcp-rks', 'bin', 'mcp-rks.mjs');
const STAMP = '0.74.2';
const SHELL_VERSION = '0.99.0';
const DRIFT = { ok: false, issues: ['content differs: x.mjs'], srcCount: 1, destCount: 1 };
const OK_DRIFT = { ok: true, issues: [], srcCount: 0, destCount: 0 };
/** The release-lag hook: registered by the invoking shell, absent from the child R deployed. */
const LAG_HOOK_REL = 'system/block-git-during-off-rail.mjs';
/** Every Check 2/3/5/6/7/8 dependency that report-only must never call for a pinned-elsewhere child. */
const WRITERS = [
  'syncProject',
  'migrateConfig',
  'repinMcpServer',
  'inspectHookRegistration',
  'ensureHookRegistration',
  'mergeRksPermissionAllow',
  'seedVitestFiles',
];
const REPORT_ONLY_CHECKS = [2, 3, 5, 6, 7, 8];

const tmp = [];
function mk(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmp.push(d);
  return d;
}
function put(root, rel, body) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
}

/** The tiered "<tier>/<name>.mjs" of every hook command in a registration, de-duplicated. */
function hookRelPathsOf(registration) {
  const out = new Set();
  for (const groups of Object.values(registration)) {
    for (const g of groups) {
      for (const h of g.hooks) {
        const m = /\.routekit\/hooks\/(\S+\.mjs)/.exec(h.command);
        if (m) out.add(m[1]);
      }
    }
  }
  return [...out];
}

/** A registration with every command naming `rel` removed (empty groups and events dropped). */
function withoutHookCommand(registration, rel) {
  const out = {};
  for (const [event, groups] of Object.entries(registration)) {
    const kept = groups
      .map((g) => ({ ...g, hooks: g.hooks.filter((h) => !h.command.includes(`.routekit/hooks/${rel}`)) }))
      .filter((g) => g.hooks.length > 0);
    if (kept.length > 0) out[event] = kept;
  }
  return out;
}

/** Every file under `dir` as [relative path, content] pairs, sorted — a byte-level snapshot. */
function snapshotDir(dir) {
  const out = [];
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else out.push([path.relative(dir, p), fs.readFileSync(p, 'utf8')]);
    }
  };
  walk(dir);
  return out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/** The INVOKING shell. Its version deliberately differs from every child's stamp. */
function makeShellRoot() {
  const root = mk('doctor-rp-shell-');
  put(root, 'packages/hooks/write/sample.mjs', '// canonical\n');
  put(root, 'templates/generic/.routekit/hooks/write/sample.mjs', '// canonical\n');
  put(root, '.routekit/hooks-manifest.json', JSON.stringify(HOOK_MANIFEST, null, 2));
  put(root, 'package.json', JSON.stringify({ name: 'routekit-shell', version: SHELL_VERSION }, null, 2));
  return root;
}

/**
 * Another rks shell R, as `upgrade --from-release <R>` would have used it. It carries templates, a
 * hook manifest and a child-permissions.mjs that throws on import, so a doctor that judged,
 * loaded or ran anything from R would have something to read — report-only reads none of it.
 */
function makeReleaseRoot({ version = STAMP, packageJson = true, bin = true } = {}) {
  const root = mk('doctor-rp-release-');
  if (packageJson) put(root, 'package.json', JSON.stringify({ name: 'routekit-shell', version }, null, 2));
  if (bin) put(root, BIN_REL, '// release mcp-rks\n');
  put(root, 'templates/generic/.routekit/hooks/write/release-only.mjs', '// release template\n');
  put(root, '.routekit/hooks-manifest.json', JSON.stringify(HOOK_MANIFEST, null, 2));
  put(root, 'packages/cli/src/project/child-permissions.mjs', 'throw new Error("doctor must never import code from another shell");\n');
  return root;
}

/**
 * A governed child whose .mcp.json args[0] is `pointer` and whose stamp is `rksVersion`.
 * `settings` is written as .claude/settings.json (null → no file); `hookRels` are the hook
 * scripts written under .routekit/hooks.
 */
function makeChild({
  pointer,
  rksVersion = STAMP,
  settings = { hooks: CANONICAL_HOOKS, permissions: { ask: ['mcp__rks__*'] } },
  hookRels = hookRelPathsOf(CANONICAL_HOOKS),
} = {}) {
  const root = mk('doctor-rp-child-');
  put(root, '.rks/project.json', JSON.stringify({ id: 'child-x', rksVersion }, null, 2));
  put(
    root,
    '.mcp.json',
    JSON.stringify({ mcpServers: { rks: { command: 'node', args: [pointer], env: {} } } }, null, 2),
  );
  for (const rel of hookRels) put(root, path.join('.routekit', 'hooks', rel), '// stub hook\n');
  if (settings) put(root, '.claude/settings.json', JSON.stringify(settings, null, 2));
  return root;
}

function deps(children, overrides = {}) {
  return {
    syncHooks: vi.fn(),
    checkDrift: vi.fn(() => ({ ...OK_DRIFT })),
    // backlog.fix.doctor-hook-drift-fixer-books-unverified-success: injected so no test prunes for real
    // unless it deletes this key on purpose.
    pruneExtraFiles: vi.fn(() => ({ removed: [], kept: [] })),
    syncProject: vi.fn(() => []),
    repinMcpServer: vi.fn(() => ({ ok: true, changed: true })),
    migrateConfig: vi.fn(() => ({ ok: true, applied: [], noOp: true, fromVersion: 1, currentVersion: 1 })),
    upsertProject: vi.fn(),
    loadProjects: vi.fn(() => children),
    isPinned: vi.fn(() => false),
    inspectHookRegistration: vi.fn(() => ({ ok: true })),
    ensureHookRegistration: vi.fn(() => ({ changed: true, reason: 'created' })),
    mergeRksPermissionAllow: vi.fn(),
    seedVitestFiles: vi.fn(() => ({ created: [], templateMissing: [] })),
    listTrackedRuntimeArtifacts: vi.fn(() => ({ skipped: true, reason: 'not exercised by this file' })),
    ...overrides,
  };
}
const one = (child) => [{ id: 'child-x', root: child }];
const hooksOf = (child) => path.join(child, '.routekit', 'hooks');
const templateOf = (root) => path.join(root, 'templates', 'generic', '.routekit', 'hooks');
const settingsOf = (child) => path.join(child, '.claude', 'settings.json');
const remedy = (R) => `routekit project upgrade --id child-x --from-release ${R}`;
const entryOf = (list, id = 'child-x') => list.find((c) => c.id === id);
const nonRecoverableFor = (result, id = 'child-x') => result.findings.nonRecoverable.filter((n) => n.id === id);
const reportOnlyFixers = (result, id = 'child-x') =>
  result.findings.appliedFixers.filter((f) => f.id === id && REPORT_ONLY_CHECKS.includes(f.check));
/** checkDrift calls whose DEST is this child's hooks dir (Check 2) — excludes the Check 1 call. */
const check2Calls = (d, child) => d.checkDrift.mock.calls.filter(([, dest]) => dest === hooksOf(child));
const driftingFor = (child) => vi.fn((src, dest) => (dest === hooksOf(child) ? { ...DRIFT } : { ...OK_DRIFT }));
/**
 * Drift on the FIRST Check 2 judge of each listed child, clean on the post-fix re-check — the fixer
 * cleared it. backlog.fix.doctor-hook-drift-fixer-books-unverified-success
 */
const driftingOnceFor = (...children) => {
  const judged = new Set();
  return vi.fn((src, dest) => {
    const child = children.find((c) => dest === hooksOf(c));
    if (!child || judged.has(child)) return { ...OK_DRIFT };
    judged.add(child);
    return { ...DRIFT };
  });
};
const pinnedReason = (R) =>
  `pinned to ${R} — not checked or repaired by ${shellRoot}; run that shell's doctor to repair`;

let shellRoot;
beforeEach(() => {
  shellRoot = makeShellRoot();
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('shellMcpBinary — the single source of the canonical bin suffix', () => {
  it('repin-mcp.mjs exports shellMcpBinary(root) → <root>/packages/mcp-rks/bin/mcp-rks.mjs', () => {
    expect(typeof shellMcpBinary).toBe('function');
    expect(shellMcpBinary('/r')).toBe(path.join('/r', BIN_REL));
  });

  it('doctor.mjs imports shellMcpBinary from ./repin-mcp.mjs and holds no second hard-coded copy', () => {
    const SRC = fs.readFileSync(path.join(REPO_ROOT, 'packages/cli/src/project/doctor.mjs'), 'utf8');
    expect(SRC).toMatch(/import\s*\{[^}]*\bshellMcpBinary\b[^}]*\}\s*from\s*["']\.\/repin-mcp\.mjs["']/);
    expect(SRC).not.toMatch(/["']mcp-rks\.mjs["']/);
  });
});

describe('resolveChildShellRoot — which rks shell is this child pinned to?', () => {
  it('pointer under the invoking shell → invoking-shell', () => {
    const P = shellMcpBinary(shellRoot);
    const child = makeChild({ pointer: P });
    expect(resolveChildShellRoot({ childRoot: child, shellRoot, pointer: P })).toEqual({ basis: 'invoking-shell', root: shellRoot });
  });

  it('another rks shell R, bin present, version equal to the stamp → release-pin with root R', () => {
    const R = makeReleaseRoot();
    const P = shellMcpBinary(R);
    const child = makeChild({ pointer: P });
    expect(resolveChildShellRoot({ childRoot: child, shellRoot, pointer: P })).toEqual({ basis: 'release-pin', root: R });
  });

  it.each([
    ['a nonexistent root (/wrong/shell)', () => '/wrong/shell/packages/mcp-rks/bin/mcp-rks.mjs'],
    ['a root with the bin but no package.json', () => shellMcpBinary(makeReleaseRoot({ packageJson: false }))],
    ['a non-canonical file under an rks shell', () => path.join(makeReleaseRoot(), 'other.mjs')],
    ['a relative pointer', () => path.join('rel', BIN_REL)],
    ['no pointer', () => null],
  ])("%s → invoking-shell (today's behaviour)", (_label, pointerOf) => {
    const pointer = pointerOf();
    const child = makeChild({ pointer: pointer ?? 'node-only' });
    expect(resolveChildShellRoot({ childRoot: child, shellRoot, pointer })).toEqual({ basis: 'invoking-shell', root: shellRoot });
  });

  it('R version differs from the stamp → stale-release-pin naming both versions', () => {
    const R = makeReleaseRoot({ version: '9.9.9' });
    const P = shellMcpBinary(R);
    const child = makeChild({ pointer: P });
    expect(resolveChildShellRoot({ childRoot: child, shellRoot, pointer: P })).toEqual({
      basis: 'stale-release-pin',
      root: R,
      detail: `${R} is rks 9.9.9 but the child is stamped ${STAMP}`,
    });
  });

  it('the bin under R is missing → stale-release-pin naming the missing pointer', () => {
    const R = makeReleaseRoot({ bin: false });
    const P = shellMcpBinary(R);
    const child = makeChild({ pointer: P });
    expect(resolveChildShellRoot({ childRoot: child, shellRoot, pointer: P })).toEqual({
      basis: 'stale-release-pin',
      root: R,
      detail: `${P} is missing`,
    });
  });

  it('the invoking shell reached through a symlink, stamp equal to its version → invoking-shell, never release-pin', () => {
    put(shellRoot, BIN_REL, '// shell mcp-rks\n');
    const alias = path.join(mk('doctor-rp-alias-'), 'shell-link');
    fs.symlinkSync(shellRoot, alias);
    const P = shellMcpBinary(alias);
    const child = makeChild({ pointer: P, rksVersion: SHELL_VERSION });
    // Control: every release-pin condition other than identity holds through the alias.
    expect(fs.existsSync(P)).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(alias, 'package.json'), 'utf8')).version).toBe(SHELL_VERSION);
    expect(resolveChildShellRoot({ childRoot: child, shellRoot, pointer: P })).toEqual({ basis: 'invoking-shell', root: shellRoot });
  });
});

describe('release pin — Checks 2, 3, 5, 6, 7 and 8 only report', () => {
  it.each([false, true])('RED before fix: dryRun=%s → no Check 2, 5, 6, 7 or 8 judge and no fixer is called (Check 3 judges the pointer read-only), nothing is planned, every Check 2, 5, 6, 7 and 8 entry is a skip', async (dryRun) => {
    const R = makeReleaseRoot();
    const P = shellMcpBinary(R);
    const child = makeChild({ pointer: P });
    const d = deps(one(child), { checkDrift: driftingFor(child) });
    const result = await runDoctor({ shellRoot, dryRun, deps: d });

    expect(check2Calls(d, child)).toEqual([]);
    for (const name of WRITERS) expect(d[name], name).not.toHaveBeenCalled();
    expect(d.pruneExtraFiles.mock.calls.filter(([, dest]) => dest === hooksOf(child))).toEqual([]);
    expect(reportOnlyFixers(result)).toEqual([]);
    expect(nonRecoverableFor(result)).toEqual([]);

    const skipped = { id: 'child-x', skipped: true, reason: pinnedReason(R), judgedAgainst: R, judgedBasis: 'release-pin' };
    expect(entryOf(result.findings.childHooksDrift)).toEqual(skipped);
    expect(entryOf(result.findings.childHookRegistration)).toEqual(skipped);
    expect(entryOf(result.findings.childPermissionAllow)).toEqual(skipped);
    expect(entryOf(result.findings.childSchemaVersion)).toEqual(skipped);
    expect(entryOf(result.findings.childVitestShim)).toEqual({ ...skipped, missing: expect.any(Array) });
    expect(entryOf(result.findings.childMcpPointer)).toEqual({
      id: 'child-x', exists: true, pointer: P, healthy: true, judgedAgainst: R, judgedBasis: 'release-pin',
    });
    expect(result.exitCode).toBe(0);
  });

  it('RED before fix: Check 5 only reports (migrateConfig never called); Checks 9a and 9b still run for a release-pinned child', async () => {
    const R = makeReleaseRoot();
    const child = makeChild({ pointer: shellMcpBinary(R) });
    const d = deps(one(child));
    const result = await runDoctor({ shellRoot, dryRun: false, deps: d });
    // Check 5 applies THIS checkout's schema migrations — never to a child pinned to another shell.
    expect(d.migrateConfig).not.toHaveBeenCalled();
    expect(entryOf(result.findings.childSchemaVersion)).toEqual({
      id: 'child-x', skipped: true, reason: pinnedReason(R), judgedAgainst: R, judgedBasis: 'release-pin',
    });
    expect(result.findings.appliedFixers.filter((f) => f.id === 'child-x' && f.check === 5)).toEqual([]);
    // Checks 9a and 9b do not depend on which shell is used.
    expect(entryOf(result.findings.childRuntimeGitignore)).toMatchObject({ ok: true });
    expect(fs.readFileSync(path.join(child, '.gitignore'), 'utf8')).toContain('.rks/runs/');
    expect(d.listTrackedRuntimeArtifacts).toHaveBeenCalledWith(child);
  });

  it('RED before fix: release lag — with every real judge and fixer, a wet run leaves .mcp.json, settings.json and the hooks tree byte-identical', async () => {
    const R = makeReleaseRoot();
    const P = shellMcpBinary(R);
    const rRegistration = withoutHookCommand(CANONICAL_HOOKS, LAG_HOOK_REL);
    const child = makeChild({
      pointer: P,
      settings: { hooks: rRegistration, permissions: { ask: ['mcp__rks__*'] } },
      hookRels: hookRelPathsOf(rRegistration),
    });
    const mcpBefore = fs.readFileSync(path.join(child, '.mcp.json'), 'utf8');
    const settingsBefore = fs.readFileSync(settingsOf(child), 'utf8');
    const hooksBefore = snapshotDir(hooksOf(child));
    // Reachability controls: judged against the INVOKING shell this child is unhealthy on three
    // surfaces, so the unfixed doctor repins it, resyncs its hooks and rewrites its registration.
    expect(JSON.stringify(CANONICAL_HOOKS)).toContain(LAG_HOOK_REL);
    expect(settingsBefore).not.toContain(LAG_HOOK_REL);
    expect(inspectHookRegistration({ childRoot: child, manifest: HOOK_MANIFEST, canonical: CANONICAL_HOOKS }).ok).toBe(false);
    expect(fs.existsSync(path.join(templateOf(shellRoot), 'write', 'sample.mjs'))).toBe(true);
    expect(fs.existsSync(path.join(hooksOf(child), 'write', 'sample.mjs'))).toBe(false);
    expect(P.startsWith(shellRoot + path.sep)).toBe(false);

    const d = deps(one(child));
    // runDoctor falls back to the real functions — the prune helper included.
    for (const name of ['checkDrift', 'pruneExtraFiles', ...WRITERS]) delete d[name];
    await runDoctor({ shellRoot, dryRun: false, deps: d });

    expect(fs.readFileSync(path.join(child, '.mcp.json'), 'utf8')).toBe(mcpBefore);
    expect(fs.readFileSync(settingsOf(child), 'utf8')).toBe(settingsBefore);
    expect(snapshotDir(hooksOf(child))).toEqual(hooksBefore);
  });

  it('reads exactly one file under R — R/package.json — and lists no directory under R', async () => {
    const R = makeReleaseRoot();
    const child = makeChild({ pointer: shellMcpBinary(R) });
    const under = (p) => typeof p === 'string' && (p === R || p.startsWith(R + path.sep));
    const realReadFileSync = fs.readFileSync;
    const realReaddirSync = fs.readdirSync;
    const reads = [];
    const listings = [];
    vi.spyOn(fs, 'readFileSync').mockImplementation((p, ...rest) => {
      if (under(p)) reads.push(p);
      return realReadFileSync.call(fs, p, ...rest);
    });
    vi.spyOn(fs, 'readdirSync').mockImplementation((p, ...rest) => {
      if (under(p)) listings.push(p);
      return realReaddirSync.call(fs, p, ...rest);
    });
    const result = await runDoctor({ shellRoot, dryRun: false, deps: deps(one(child)) });
    vi.restoreAllMocks();
    expect(entryOf(result.findings.childMcpPointer).judgedBasis).toBe('release-pin');
    // The resolver's one read is observed (positive control for the spy) and it is the only one.
    expect(reads).toEqual([path.join(R, 'package.json')]);
    expect(listings).toEqual([]);
  });
});

describe('stale pin — reported with the upgrade --from-release remedy, never repaired', () => {
  const STALE = [
    ['R version differs from the child stamp', { version: '9.9.9' }],
    ['the bin under R is missing', { bin: false }],
  ];

  it.each(STALE)('%s → one nonRecoverable check 3 naming R and the remedy; nothing called; exit 1', async (_label, opts) => {
    const R = makeReleaseRoot(opts);
    const P = path.join(R, BIN_REL);
    const child = makeChild({ pointer: P });
    const d = deps(one(child), { checkDrift: driftingFor(child) });
    const result = await runDoctor({ shellRoot, dryRun: false, deps: d });

    const nr = nonRecoverableFor(result);
    expect(nr).toHaveLength(1);
    expect(nr[0].check).toBe(3);
    expect(nr[0].reason).toContain(R);
    expect(nr[0].reason).toContain('Checks 2, 5, 6, 7 and 8 not run; Check 3 reported only; .mcp.json not repinned');
    expect(nr[0].reason).toContain(remedy(R));
    expect(check2Calls(d, child)).toEqual([]);
    for (const name of WRITERS) expect(d[name], name).not.toHaveBeenCalled();
    expect(reportOnlyFixers(result)).toEqual([]);
    expect(entryOf(result.findings.childMcpPointer)).toEqual({
      id: 'child-x', exists: true, pointer: P, healthy: false, judgedAgainst: R, judgedBasis: 'stale-release-pin',
    });
    for (const list of ['childHooksDrift', 'childHookRegistration', 'childPermissionAllow', 'childSchemaVersion', 'childVitestShim']) {
      expect(entryOf(result.findings[list]), list).toMatchObject({
        skipped: true, judgedAgainst: R, judgedBasis: 'stale-release-pin', reason: expect.stringContaining(remedy(R)),
      });
    }
    expect(result.findings.failed).toBe(1);
    expect(result.exitCode).toBe(1);
  });

  it('dry run: the stale pin is still reported once and nothing is called or planned', async () => {
    const R = makeReleaseRoot({ version: '9.9.9' });
    const child = makeChild({ pointer: shellMcpBinary(R) });
    const d = deps(one(child), { checkDrift: driftingFor(child) });
    const result = await runDoctor({ shellRoot, dryRun: true, deps: d });
    expect(nonRecoverableFor(result).map((n) => n.check)).toEqual([3]);
    expect(check2Calls(d, child)).toEqual([]);
    for (const name of WRITERS) expect(d[name], name).not.toHaveBeenCalled();
    expect(reportOnlyFixers(result)).toEqual([]);
    expect(result.exitCode).toBe(1);
  });

  it('stale pin + pinned:true → exactly one nonRecoverable, the stale one', async () => {
    const R = makeReleaseRoot({ version: '9.9.9' });
    const child = makeChild({ pointer: shellMcpBinary(R) });
    const d = deps(one(child), { isPinned: vi.fn(() => true) });
    const result = await runDoctor({ shellRoot, dryRun: false, deps: d });
    const nr = nonRecoverableFor(result);
    expect(nr).toHaveLength(1);
    expect(nr[0].reason).toContain(remedy(R));
    expect(nr[0].reason).not.toContain('pinned:true');
  });

  it('RED before fix: with the real repinMcpServer a wet run leaves the stale child .mcp.json byte-identical', async () => {
    const R = makeReleaseRoot({ version: '9.9.9' });
    const child = makeChild({ pointer: shellMcpBinary(R) });
    const mcpPath = path.join(child, '.mcp.json');
    const before = fs.readFileSync(mcpPath, 'utf8');
    const d = deps(one(child));
    delete d.repinMcpServer; // runDoctor falls back to the real fixer
    await runDoctor({ shellRoot, dryRun: false, deps: d });
    expect(fs.readFileSync(mcpPath, 'utf8')).toBe(before);
  });
});

describe("invoking-shell children — today's behaviour", () => {
  it('pointer under the invoking shell with drift → the unchanged Check 2 judge and fixer call; Check 3 healthy', async () => {
    const P = shellMcpBinary(shellRoot);
    // Stamp 0.74.2 differs from the invoking shell's 0.99.0 — rule 1 (pointer under shellRoot) wins regardless.
    const child = makeChild({ pointer: P });
    const d = deps(one(child), { checkDrift: driftingOnceFor(child) });
    const result = await runDoctor({ shellRoot, dryRun: false, deps: d });
    // The pre-fix judge plus exactly one post-fix re-check on the same pair.
    expect(check2Calls(d, child)).toEqual([
      [templateOf(shellRoot), hooksOf(child)],
      [templateOf(shellRoot), hooksOf(child)],
    ]);
    expect(nonRecoverableFor(result).filter((n) => n.check === 2)).toEqual([]);
    expect(d.syncProject.mock.calls).toEqual([[{ projectRoot: child, projectId: 'child-x', shellRoot }]]);
    expect(d.syncProject.mock.calls[0][0]).not.toHaveProperty('refreshStamp');
    expect(d.migrateConfig.mock.calls).toEqual([[{ projectRoot: child }]]);
    expect(entryOf(result.findings.childHooksDrift)).toEqual({
      id: 'child-x', drift: DRIFT, judgedAgainst: shellRoot, judgedBasis: 'invoking-shell',
    });
    expect(entryOf(result.findings.childMcpPointer)).toEqual({
      id: 'child-x', exists: true, pointer: P, healthy: true, judgedAgainst: shellRoot, judgedBasis: 'invoking-shell',
    });
    expect(d.repinMcpServer).not.toHaveBeenCalled();
  });

  it('nonexistent root (/wrong/shell) + unpinned → repinMcpServer({ projectRoot, shellRoot })', async () => {
    const P = '/wrong/shell/packages/mcp-rks/bin/mcp-rks.mjs';
    const child = makeChild({ pointer: P });
    const d = deps(one(child));
    const result = await runDoctor({ shellRoot, dryRun: false, deps: d });
    expect(d.repinMcpServer.mock.calls).toEqual([[{ projectRoot: child, shellRoot }]]);
    expect(entryOf(result.findings.childMcpPointer)).toEqual({
      id: 'child-x', exists: true, pointer: P, healthy: false, judgedAgainst: shellRoot, judgedBasis: 'invoking-shell',
    });
  });

  it('a root holding the bin but no package.json is not a pin → repinned to the invoking shell', async () => {
    const R = makeReleaseRoot({ packageJson: false });
    const child = makeChild({ pointer: shellMcpBinary(R) });
    const d = deps(one(child));
    await runDoctor({ shellRoot, dryRun: false, deps: d });
    expect(d.repinMcpServer.mock.calls).toEqual([[{ projectRoot: child, shellRoot }]]);
  });

  it('nonexistent root + pinned:true → one nonRecoverable check 3, no repin, exit 1', async () => {
    const child = makeChild({ pointer: '/wrong/shell/packages/mcp-rks/bin/mcp-rks.mjs' });
    const d = deps(one(child), { isPinned: vi.fn(() => true) });
    const result = await runDoctor({ shellRoot, dryRun: false, deps: d });
    expect(d.repinMcpServer).not.toHaveBeenCalled();
    expect(nonRecoverableFor(result).filter((n) => n.check === 3)).toHaveLength(1);
    expect(result.exitCode).toBe(1);
  });

  it('dry run → Check 5 unchanged: migrateConfig not called, skipped-under-dry-run recorded', async () => {
    const child = makeChild({ pointer: shellMcpBinary(shellRoot) });
    const d = deps(one(child));
    const result = await runDoctor({ shellRoot, dryRun: true, deps: d });
    expect(d.migrateConfig).not.toHaveBeenCalled();
    expect(entryOf(result.findings.childSchemaVersion)).toEqual({ id: 'child-x', status: 'skipped-under-dry-run' });
  });

  it('Checks 6, 7 and 8 keep their call shapes and record real (non-skipped) entries', async () => {
    const child = makeChild({ pointer: shellMcpBinary(shellRoot), settings: null });
    const d = deps(one(child), { inspectHookRegistration });
    const result = await runDoctor({ shellRoot, dryRun: false, deps: d });
    expect(d.ensureHookRegistration).toHaveBeenCalledTimes(1);
    const arg = d.ensureHookRegistration.mock.calls[0][0];
    expect(Object.keys(arg).sort()).toEqual(['manifest', 'settingsPath']);
    expect(arg.settingsPath).toBe(settingsOf(child));
    expect(d.seedVitestFiles.mock.calls).toEqual([[{ projectRoot: child, shellRoot }]]);
    for (const list of ['childHookRegistration', 'childPermissionAllow', 'childVitestShim']) {
      expect(entryOf(result.findings[list]), list).toBeDefined();
      expect(entryOf(result.findings[list]), list).not.toHaveProperty('skipped');
    }
  });

  it('a release-pinned and an invoking-shell child in one run → only the invoking child is judged and synced', async () => {
    const R = makeReleaseRoot();
    const rel = makeChild({ pointer: shellMcpBinary(R) });
    const core = makeChild({ pointer: shellMcpBinary(shellRoot) });
    const d = deps([{ id: 'rel', root: rel }, { id: 'core', root: core }], {
      checkDrift: driftingOnceFor(rel, core),
    });
    const result = await runDoctor({ shellRoot, dryRun: false, deps: d });
    expect(check2Calls(d, rel)).toEqual([]);
    expect(d.pruneExtraFiles.mock.calls.filter(([, dest]) => dest === hooksOf(rel))).toEqual([]);
    expect(check2Calls(d, core)).toEqual([
      [templateOf(shellRoot), hooksOf(core)],
      [templateOf(shellRoot), hooksOf(core)],
    ]);
    expect(d.syncProject.mock.calls).toEqual([[{ projectRoot: core, projectId: 'core', shellRoot }]]);
    expect(d.migrateConfig.mock.calls).toEqual([[{ projectRoot: core }]]);
    expect(d.repinMcpServer).not.toHaveBeenCalled();
    expect(entryOf(result.findings.childMcpPointer, 'rel')).toMatchObject({ healthy: true, judgedAgainst: R, judgedBasis: 'release-pin' });
    expect(entryOf(result.findings.childMcpPointer, 'core')).toMatchObject({
      healthy: true, judgedAgainst: shellRoot, judgedBasis: 'invoking-shell',
    });
  });
});

describe('Check 2 — a checkDrift failure is never silent (invoking-shell; exit code unchanged)', () => {
  it('a throw → one unverifiable entry plus one nonRecoverable naming the invoking templates and the error; exit 1 as before', async () => {
    const child = makeChild({ pointer: shellMcpBinary(shellRoot) });
    const d = deps(one(child), {
      checkDrift: vi.fn((src, dest) => {
        if (dest === hooksOf(child)) throw new Error('EIO: drift read failed');
        return { ...OK_DRIFT };
      }),
    });
    const result = await runDoctor({ shellRoot, dryRun: false, deps: d });
    const nr = nonRecoverableFor(result).filter((n) => n.check === 2);
    expect(nr).toHaveLength(1);
    expect(nr[0].reason).toContain(templateOf(shellRoot));
    expect(nr[0].reason).toContain('EIO: drift read failed');
    expect(entryOf(result.findings.childHooksDrift)).toEqual({
      id: 'child-x', drift: { ok: false, unverifiable: true, issues: [nr[0].reason] }, judgedAgainst: shellRoot, judgedBasis: 'invoking-shell',
    });
    expect(d.syncProject).not.toHaveBeenCalled();
    expect(result.exitCode).toBe(1);
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
  ])('a %s result → booked as "checkDrift returned no result", never a pass', async (_label, value) => {
    const child = makeChild({ pointer: shellMcpBinary(shellRoot) });
    const d = deps(one(child), {
      checkDrift: vi.fn((src, dest) => (dest === hooksOf(child) ? value : { ...OK_DRIFT })),
    });
    const result = await runDoctor({ shellRoot, dryRun: false, deps: d });
    const nr = nonRecoverableFor(result).filter((n) => n.check === 2);
    expect(nr).toHaveLength(1);
    expect(nr[0].reason).toContain('checkDrift returned no result');
    expect(nr[0].reason).toContain(templateOf(shellRoot));
    expect(entryOf(result.findings.childHooksDrift)).toEqual({
      id: 'child-x', drift: { ok: false, unverifiable: true, issues: [nr[0].reason] }, judgedAgainst: shellRoot, judgedBasis: 'invoking-shell',
    });
    expect(d.syncProject).not.toHaveBeenCalled();
    expect(result.exitCode).toBe(1);
  });
});
