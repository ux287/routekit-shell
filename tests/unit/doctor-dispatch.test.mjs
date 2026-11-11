/**
 * Tests for the `doctor` verb registration in the top-level CLI dispatcher
 * at packages/cli/bin/routekit.js.
 *
 * The dispatcher in routekit.js is module-level (not exported). Rather than
 * import-and-invoke, we verify the verb is wired via source-structural checks
 * AND we spawn a quick subprocess to confirm the verb is recognized.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const SPAWN_TIMEOUT = 90_000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const CLI = path.join(REPO_ROOT, 'packages/cli/bin/routekit.js');
const DISPATCHER_SRC = fs.readFileSync(CLI, 'utf8');

describe('CLI dispatcher — doctor verb registration', () => {
  it('the dispatcher file lives at packages/cli/bin/routekit.js (not .mjs, not src/cli/index.js)', () => {
    expect(fs.existsSync(CLI)).toBe(true);
    expect(fs.existsSync(path.join(REPO_ROOT, 'packages/cli/bin/routekit.mjs'))).toBe(false);
    expect(fs.existsSync(path.join(REPO_ROOT, 'packages/cli/src/cli/index.js'))).toBe(false);
  });

  it('dispatcher imports runDoctor from ../src/project/doctor.mjs', () => {
    expect(DISPATCHER_SRC).toMatch(/runDoctor[^;]*from\s+["']\.\.\/src\/project\/doctor\.mjs["']/s);
  });

  it('dispatcher registers `cmd === "doctor"` branch', () => {
    expect(DISPATCHER_SRC).toMatch(/if\s*\(\s*cmd\s*===\s*["']doctor["']\s*\)/);
  });

  it('dispatcher reads kv["dry-run"] and passes it as dryRun to runDoctor', () => {
    expect(DISPATCHER_SRC).toMatch(/kv\[["']dry-run["']\]/);
    expect(DISPATCHER_SRC).toMatch(/runDoctor\(\s*\{[^}]*shellRoot[^}]*dryRun[^}]*\}/s);
  });
});

describe('CLI dispatcher — doctor verb end-to-end (cold-start sanity)', () => {
  it('`routekit doctor --dry-run` exits 0 against a temp shell with no children', () => {
    const tmpShell = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-dispatch-shell-'));
    try {
      // Plant a minimum shell layout so doctor's Check 1 has files to inspect.
      fs.mkdirSync(path.join(tmpShell, 'packages', 'hooks'), { recursive: true });
      fs.mkdirSync(path.join(tmpShell, 'templates', 'generic', '.routekit', 'hooks'), { recursive: true });
      fs.mkdirSync(path.join(tmpShell, 'projects'), { recursive: true });
      // Satisfy server.mjs's hooks-health check in CWD.
      fs.mkdirSync(path.join(tmpShell, '.routekit', 'hooks'), { recursive: true });

      const r = spawnSync(process.execPath, [CLI, 'doctor', '--dry-run'], {
        cwd: tmpShell,
        encoding: 'utf8',
        timeout: SPAWN_TIMEOUT,
        env: {
          ...process.env,
          ROUTEKIT_SHELL_ROOT: tmpShell,
          ROUTEKIT_PROJECT_ID: 'routekit-shell-core',
        },
      });
      // Empty shell with sync'd templates → no drift → exit 0.
      expect(r.error).toBeUndefined();
      expect(r.status, `stderr: ${r.stderr}`).toBe(0);
      expect(r.stdout || '').toContain('routekit doctor');
      expect(r.stdout || '').toContain('DRY RUN');
    } finally {
      fs.rmSync(tmpShell, { recursive: true, force: true });
    }
  });
});
