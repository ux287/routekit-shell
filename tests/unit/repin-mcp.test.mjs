/**
 * Unit tests for repinMcpServer() in packages/cli/src/project/repin-mcp.mjs.
 *
 * Tests the isolated function against temp-directory fixtures. The dispatch
 * wiring is covered separately in project-repin-mcp-dispatch.test.mjs and the
 * end-to-end CLI flow in tests/project-repin-mcp.test.mjs.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { repinMcpServer } from '../../packages/cli/src/project/repin-mcp.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const REPIN_SRC = fs.readFileSync(
  path.join(REPO_ROOT, 'packages/cli/src/project/repin-mcp.mjs'),
  'utf8',
);
const BOOTSTRAP_SRC_PATH = path.join(REPO_ROOT, 'packages/cli/src/project/bootstrap.mjs');

function makeChildProject(env = {}) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'repin-mcp-child-'));
  const initialMcp = {
    mcpServers: {
      rks: {
        command: 'node',
        args: ['/path/to/old-shell/packages/mcp-rks/bin/mcp-rks.mjs'],
        env: {
          ROUTEKIT_PROJECT_ID: 'fixture-child',
          ROUTEKIT_PROJECT_ROOT: projectRoot,
          ...env,
        },
      },
    },
  };
  fs.writeFileSync(path.join(projectRoot, '.mcp.json'), JSON.stringify(initialMcp, null, 2) + '\n');
  return projectRoot;
}

function listBaks(projectRoot) {
  return fs.readdirSync(projectRoot).filter((f) => f.startsWith('.mcp.json.bak.'));
}

describe('repinMcpServer — isolated unit', () => {
  let projectRoot;
  let shellRoot;

  beforeEach(() => {
    projectRoot = makeChildProject();
    shellRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'repin-mcp-shell-'));
  });

  afterEach(() => {
    if (projectRoot) fs.rmSync(projectRoot, { recursive: true, force: true });
    if (shellRoot) fs.rmSync(shellRoot, { recursive: true, force: true });
  });

  it('exports repinMcpServer as a callable function', () => {
    expect(typeof repinMcpServer).toBe('function');
  });

  it('rewrites mcpServers.rks.args[0] to the invoking shell\'s mcp-rks.mjs path', () => {
    const result = repinMcpServer({ projectRoot, shellRoot });
    expect(result.ok).toBe(true);
    expect(result.changed).toBe(true);
    const written = JSON.parse(fs.readFileSync(path.join(projectRoot, '.mcp.json'), 'utf8'));
    expect(written.mcpServers.rks.args[0]).toBe(
      path.join(shellRoot, 'packages/mcp-rks/bin/mcp-rks.mjs'),
    );
  });

  it('preserves mcpServers.rks.env byte-for-byte (incl. user-added keys)', () => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
    projectRoot = makeChildProject({ CUSTOM_USER_KEY: 'preserved-value', ANOTHER: 'kept' });
    repinMcpServer({ projectRoot, shellRoot });
    const written = JSON.parse(fs.readFileSync(path.join(projectRoot, '.mcp.json'), 'utf8'));
    expect(written.mcpServers.rks.env).toEqual({
      ROUTEKIT_PROJECT_ID: 'fixture-child',
      ROUTEKIT_PROJECT_ROOT: projectRoot,
      CUSTOM_USER_KEY: 'preserved-value',
      ANOTHER: 'kept',
    });
  });

  it("preserves mcpServers.rks.command ('node') and any other top-level keys", () => {
    // Add a top-level key the user might have set.
    const mcpPath = path.join(projectRoot, '.mcp.json');
    const orig = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
    orig._userMeta = { note: 'custom top-level' };
    fs.writeFileSync(mcpPath, JSON.stringify(orig, null, 2) + '\n');

    repinMcpServer({ projectRoot, shellRoot });
    const written = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
    expect(written.mcpServers.rks.command).toBe('node');
    expect(written._userMeta).toEqual({ note: 'custom top-level' });
  });

  it('creates a .bak.<timestamp> file byte-equal to the pre-write .mcp.json', () => {
    const mcpPath = path.join(projectRoot, '.mcp.json');
    const before = fs.readFileSync(mcpPath, 'utf8');
    repinMcpServer({ projectRoot, shellRoot });
    const baks = listBaks(projectRoot);
    expect(baks.length).toBe(1);
    const bakName = baks[0];
    // Numeric Date.now() suffix.
    expect(bakName).toMatch(/^\.mcp\.json\.bak\.\d+$/);
    const bakContent = fs.readFileSync(path.join(projectRoot, bakName), 'utf8');
    expect(bakContent).toBe(before);
  });

  it('writes JSON with 2-space indent and trailing newline (matches bootstrap.mjs format)', () => {
    repinMcpServer({ projectRoot, shellRoot });
    const written = fs.readFileSync(path.join(projectRoot, '.mcp.json'), 'utf8');
    expect(written.endsWith('\n')).toBe(true);
    // 2-space indent verification — the second line of pretty-printed JSON starts with two spaces.
    const lines = written.split('\n');
    const indented = lines.find((l) => l.startsWith('  ') && !l.startsWith('   '));
    expect(indented, 'expected at least one line with 2-space indent').toBeDefined();
  });

  it('idempotent: second invocation with the same shellRoot is a no-op (no rewrite, no new .bak)', () => {
    repinMcpServer({ projectRoot, shellRoot });
    const baksAfterFirst = listBaks(projectRoot);
    const writtenAfterFirst = fs.readFileSync(path.join(projectRoot, '.mcp.json'), 'utf8');

    const result2 = repinMcpServer({ projectRoot, shellRoot });
    expect(result2.changed).toBe(false);
    const baksAfterSecond = listBaks(projectRoot);
    expect(baksAfterSecond).toEqual(baksAfterFirst);
    const writtenAfterSecond = fs.readFileSync(path.join(projectRoot, '.mcp.json'), 'utf8');
    expect(writtenAfterSecond).toBe(writtenAfterFirst);
  });

  it("throws a clear 'not bootstrapped' error when .mcp.json is absent (does NOT create one)", () => {
    const emptyProject = fs.mkdtempSync(path.join(os.tmpdir(), 'repin-mcp-empty-'));
    try {
      expect(() => repinMcpServer({ projectRoot: emptyProject, shellRoot })).toThrow(
        /not bootstrapped|attach/i,
      );
      expect(fs.existsSync(path.join(emptyProject, '.mcp.json'))).toBe(false);
    } finally {
      fs.rmSync(emptyProject, { recursive: true, force: true });
    }
  });

  it('throws when projectRoot is missing', () => {
    expect(() => repinMcpServer({ shellRoot })).toThrow(/projectRoot/);
  });

  it('throws when shellRoot is missing', () => {
    expect(() => repinMcpServer({ projectRoot })).toThrow(/shellRoot/);
  });
});

describe('repin-mcp.mjs — source structure', () => {
  it('does NOT import from ./bootstrap.mjs or ./bootstrap', () => {
    // Static guard: any future regression that re-introduces a bootstrap import
    // would silently couple this module to bootstrap's internals.
    expect(REPIN_SRC).not.toMatch(/from\s+["']\.\/bootstrap(\.mjs)?["']/);
    expect(REPIN_SRC).not.toMatch(/require\(["']\.\/bootstrap(\.mjs)?["']\)/);
  });

  it('does NOT name `writeJSONWithBackup` or `writeFileWithBackup` as imports', () => {
    // The inlined helper is named writeJSONWithBackupLocal to make the
    // distinction explicit.
    expect(REPIN_SRC).not.toMatch(/import\s+\{[^}]*\bwriteJSONWithBackup\b[^}]*\}/);
    expect(REPIN_SRC).not.toMatch(/import\s+\{[^}]*\bwriteFileWithBackup\b[^}]*\}/);
  });

  it('inlines a JSON-with-backup helper locally', () => {
    // The module must define its own write helper (any function whose body
    // writes a .bak.<ts> file and then fs.writeFileSync the new JSON).
    expect(REPIN_SRC).toMatch(/\.bak\.\$\{Date\.now\(\)\}/);
    expect(REPIN_SRC).toMatch(/fs\.copyFileSync/);
    expect(REPIN_SRC).toMatch(/fs\.writeFileSync/);
  });

  it('bootstrap.mjs is not modified — writeJSONWithBackup remains module-internal (not exported)', () => {
    const bootstrap = fs.readFileSync(BOOTSTRAP_SRC_PATH, 'utf8');
    // The helper is still declared as a plain function, never exported.
    expect(bootstrap).toMatch(/^function writeJSONWithBackup/m);
    expect(bootstrap).not.toMatch(/^export\s+function\s+writeJSONWithBackup/m);
    expect(bootstrap).not.toMatch(/^export\s+\{[^}]*\bwriteJSONWithBackup\b/m);
  });
});
