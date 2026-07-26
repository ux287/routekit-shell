/**
 * Integration test for the `routekit project repin-mcp` CLI verb.
 *
 * Spawns the real CLI binary against a temp child project whose .mcp.json is
 * pinned to an old "core shell" path, then asserts that repin from a new
 * "release shell" updates args[0]. A second invocation is asserted to be a
 * no-op (idempotency).
 *
 * The registry resolution path is exercised by planting a `projects/index.jsonl`
 * in the "release shell" temp dir that points at the child's location.
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

describe('routekit project repin-mcp — integration', () => {
  let childRoot;
  let oldShellRoot;
  let newShellRoot;

  beforeEach(() => {
    oldShellRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'repin-old-shell-'));
    newShellRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'repin-new-shell-'));
    childRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'repin-child-'));

    // Plant the child's pre-repin .mcp.json (pinned to the old shell).
    const initialMcp = {
      mcpServers: {
        rks: {
          command: 'node',
          args: [path.join(oldShellRoot, 'packages/mcp-rks/bin/mcp-rks.mjs')],
          env: {
            ROUTEKIT_PROJECT_ID: 'integration-child',
            ROUTEKIT_PROJECT_ROOT: childRoot,
            CUSTOM_USER_KEY: 'preserve-me',
          },
        },
      },
    };
    fs.writeFileSync(
      path.join(childRoot, '.mcp.json'),
      JSON.stringify(initialMcp, null, 2) + '\n',
    );

    // Plant the new shell's registry pointing at the child.
    fs.mkdirSync(path.join(newShellRoot, 'projects'), { recursive: true });
    fs.writeFileSync(
      path.join(newShellRoot, 'projects/index.jsonl'),
      JSON.stringify({ id: 'integration-child', root: childRoot, stack: 'app' }) + '\n',
    );
  });

  afterEach(() => {
    for (const dir of [childRoot, oldShellRoot, newShellRoot]) {
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function runRepin(args = []) {
    return spawnSync(process.execPath, [CLI, 'project', 'repin-mcp', ...args], {
      cwd: newShellRoot,
      encoding: 'utf8',
      timeout: SPAWN_TIMEOUT,
      env: {
        ...process.env,
        ROUTEKIT_PROJECT_ID: 'routekit-shell-core',
        // Point the CLI's registry resolution at our temp "release shell".
        ROUTEKIT_SHELL_ROOT: newShellRoot,
      },
    });
  }

  it('updates args[0] from the old-shell path to the new-shell path', () => {
    const r = runRepin(['--id', 'integration-child']);
    expect(r.error).toBeUndefined();
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);

    const written = JSON.parse(fs.readFileSync(path.join(childRoot, '.mcp.json'), 'utf8'));
    expect(written.mcpServers.rks.args[0]).toBe(
      path.join(newShellRoot, 'packages/mcp-rks/bin/mcp-rks.mjs'),
    );
    // env preserved.
    expect(written.mcpServers.rks.env.CUSTOM_USER_KEY).toBe('preserve-me');
    expect(written.mcpServers.rks.env.ROUTEKIT_PROJECT_ID).toBe('integration-child');
    expect(written.mcpServers.rks.env.ROUTEKIT_PROJECT_ROOT).toBe(childRoot);
  });

  it('creates a .bak.<timestamp> file on the first run', () => {
    runRepin(['--id', 'integration-child']);
    const baks = fs.readdirSync(childRoot).filter((f) => f.startsWith('.mcp.json.bak.'));
    expect(baks.length).toBe(1);
    expect(baks[0]).toMatch(/^\.mcp\.json\.bak\.\d+$/);
  });

  it('second invocation against the same target is a no-op (no new .bak)', () => {
    runRepin(['--id', 'integration-child']);
    const baksAfterFirst = fs.readdirSync(childRoot).filter((f) => f.startsWith('.mcp.json.bak.'));
    const writtenAfterFirst = fs.readFileSync(path.join(childRoot, '.mcp.json'), 'utf8');

    const r2 = runRepin(['--id', 'integration-child']);
    expect(r2.status, `stderr: ${r2.stderr}`).toBe(0);
    const baksAfterSecond = fs.readdirSync(childRoot).filter((f) => f.startsWith('.mcp.json.bak.'));
    const writtenAfterSecond = fs.readFileSync(path.join(childRoot, '.mcp.json'), 'utf8');
    expect(baksAfterSecond).toEqual(baksAfterFirst);
    expect(writtenAfterSecond).toBe(writtenAfterFirst);
  });

  it('accepts an explicit --shell argument', () => {
    const otherShell = fs.mkdtempSync(path.join(os.tmpdir(), 'repin-explicit-shell-'));
    try {
      const r = runRepin(['--id', 'integration-child', '--shell', otherShell]);
      expect(r.status, `stderr: ${r.stderr}`).toBe(0);
      const written = JSON.parse(fs.readFileSync(path.join(childRoot, '.mcp.json'), 'utf8'));
      expect(written.mcpServers.rks.args[0]).toBe(
        path.join(otherShell, 'packages/mcp-rks/bin/mcp-rks.mjs'),
      );
    } finally {
      fs.rmSync(otherShell, { recursive: true, force: true });
    }
  });

  it('exits non-zero when --id is missing', () => {
    const r = runRepin([]);
    expect(r.status).not.toBe(0);
    expect(r.stderr || '').toMatch(/usage/);
  });

  it('exits non-zero when --id is not registered in the invoking shell', () => {
    const r = runRepin(['--id', 'no-such-child']);
    expect(r.status).not.toBe(0);
    expect(r.stderr || '').toMatch(/not found/i);
  });
});
