/**
 * Integration test for `routekit doctor`.
 *
 * Spawns the real CLI binary against a complete fake-ecosystem temp tree:
 *   - A "shell" temp dir with canonical+template hooks and a registry.
 *   - One drifted child (.mcp.json pinned to wrong shell, schemaVersion behind).
 *   - One pinned:true child whose .mcp.json drift should NOT be repaired.
 *
 * The first run reports findings and applies fixes; the second run reports
 * clean (idempotency).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const SPAWN_TIMEOUT = 60_000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CLI = path.join(REPO_ROOT, 'packages/cli/bin/routekit.js');

function setupShell() {
  const shellRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-int-shell-'));
  fs.mkdirSync(path.join(shellRoot, 'packages', 'hooks', 'write'), { recursive: true });
  fs.mkdirSync(path.join(shellRoot, 'templates', 'generic', '.routekit', 'hooks', 'write'), { recursive: true });
  fs.mkdirSync(path.join(shellRoot, 'projects'), { recursive: true });
  fs.mkdirSync(path.join(shellRoot, '.routekit', 'hooks'), { recursive: true });
  const sample = '// canonical sample hook\n';
  fs.writeFileSync(path.join(shellRoot, 'packages/hooks/write/sample.mjs'), sample);
  fs.writeFileSync(path.join(shellRoot, 'templates/generic/.routekit/hooks/write/sample.mjs'), sample);
  return shellRoot;
}

function setupChild({ pinned = false, mcpPointsToShell = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-int-child-'));
  fs.mkdirSync(path.join(root, '.routekit', 'hooks'), { recursive: true });
  fs.mkdirSync(path.join(root, '.rks'), { recursive: true });
  fs.mkdirSync(path.join(root, 'routekit'), { recursive: true });
  // .rks/project.json — used for pinned read.
  fs.writeFileSync(
    path.join(root, '.rks/project.json'),
    JSON.stringify(pinned ? { id: 'child-x', pinned: true } : { id: 'child-x' }, null, 2),
  );
  // routekit/project.json — used by metadata.js for migrateConfig.
  fs.writeFileSync(
    path.join(root, 'routekit/project.json'),
    JSON.stringify({
      id: 'child-x',
      root,
      schemaVersion: 1,
      notes: { vaultPath: 'notes', dendronConfig: 'dendron.yml' },
      rag: { indexPath: 'routekit/rag/index.lance', enabled: true },
      kg: { configPath: 'routekit/kg.yaml' },
      llm: { providerEnvVar: 'ROUTEKIT_LLM_PROVIDER' },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }, null, 2),
  );
  const pointer = mcpPointsToShell
    ? path.join(mcpPointsToShell, 'packages/mcp-rks/bin/mcp-rks.mjs')
    : '/old/shell/packages/mcp-rks/bin/mcp-rks.mjs';
  fs.writeFileSync(
    path.join(root, '.mcp.json'),
    JSON.stringify({
      mcpServers: { rks: { command: 'node', args: [pointer], env: { ROUTEKIT_PROJECT_ID: 'child-x' } } },
    }, null, 2),
  );
  return root;
}

describe('routekit doctor — integration', () => {
  let shellRoot;
  let driftedChild;

  beforeEach(() => {
    shellRoot = setupShell();
    driftedChild = setupChild({ pinned: false });
    fs.writeFileSync(
      path.join(shellRoot, 'projects/index.jsonl'),
      JSON.stringify({ id: 'child-x', root: driftedChild, stack: 'app' }) + '\n',
    );
  });

  afterEach(() => {
    for (const dir of [shellRoot, driftedChild]) {
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function runDoctor(args = []) {
    return spawnSync(process.execPath, [CLI, 'doctor', ...args], {
      cwd: shellRoot,
      encoding: 'utf8',
      timeout: SPAWN_TIMEOUT,
      env: {
        ...process.env,
        ROUTEKIT_SHELL_ROOT: shellRoot,
        ROUTEKIT_PROJECT_ID: 'routekit-shell-core',
      },
    });
  }

  it('reports drift on a drifted child and applies fixes; second run is clean', () => {
    const r1 = runDoctor([]);
    expect(r1.error).toBeUndefined();
    // The doctor subprocess must actually launch and succeed — a non-launching
    // CLI (e.g. a stale REPO_ROOT resolving to a nonexistent path) must fail
    // loudly here, not slip silently to the repin assertion below.
    expect(r1.status, `doctor first run must exit 0; stderr: ${r1.stderr}`).toBe(0);
    // First run repins the drifted child.
    const repinnedArgs = JSON.parse(fs.readFileSync(path.join(driftedChild, '.mcp.json'), 'utf8'));
    expect(repinnedArgs.mcpServers.rks.args[0]).toBe(
      path.join(shellRoot, 'packages/mcp-rks/bin/mcp-rks.mjs'),
    );
    // Second run sees no drift.
    const r2 = runDoctor([]);
    expect(r2.error).toBeUndefined();
    expect(r2.status, `stderr: ${r2.stderr}`).toBe(0);
  });

  it('--dry-run does not modify .mcp.json', () => {
    const before = fs.readFileSync(path.join(driftedChild, '.mcp.json'), 'utf8');
    const r = runDoctor(['--dry-run']);
    expect(r.error).toBeUndefined();
    const after = fs.readFileSync(path.join(driftedChild, '.mcp.json'), 'utf8');
    expect(after).toBe(before);
    expect(r.stdout || '').toContain('DRY RUN');
  });

  it('pinned:true child with .mcp.json drift exits non-zero; args[0] unchanged', () => {
    // Replace the drifted child with a pinned one.
    fs.rmSync(driftedChild, { recursive: true, force: true });
    driftedChild = setupChild({ pinned: true });
    fs.writeFileSync(
      path.join(shellRoot, 'projects/index.jsonl'),
      JSON.stringify({ id: 'child-x', root: driftedChild, stack: 'app' }) + '\n',
    );
    const beforeArgs = JSON.parse(fs.readFileSync(path.join(driftedChild, '.mcp.json'), 'utf8'));
    const r = runDoctor([]);
    expect(r.error).toBeUndefined();
    expect(r.status).not.toBe(0); // non-recoverable finding.
    const afterArgs = JSON.parse(fs.readFileSync(path.join(driftedChild, '.mcp.json'), 'utf8'));
    expect(afterArgs.mcpServers.rks.args[0]).toBe(beforeArgs.mcpServers.rks.args[0]);
    expect(r.stdout || '').toMatch(/NON-RECOVERABLE/);
  });
});
