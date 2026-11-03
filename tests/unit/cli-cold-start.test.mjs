/**
 * CLI cold-start test: invoking `routekit` from a CWD without `.rks/project.json`
 * and with `ROUTEKIT_PROJECT_ID` unset in the env must not emit the
 * SELF_PROJECT_ID fatal diagnostic.
 *
 * Before this fix, the CLI transitively imported server.mjs, whose module-load
 * IIFE threw "[rks] Cannot determine SELF_PROJECT_ID …" — producing the
 * `[rks-mcp] FATAL` line on stderr and exiting before any verb ran.
 *
 * This integration test exercises the real CLI binary as a subprocess.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const SPAWN_TIMEOUT = 60_000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_BIN = path.resolve(__dirname, '../../packages/cli/bin/routekit.js');

// SKIPPED 2026-06-04: real `spawnSync('node', CLI_BIN, ...)` cold-start is flaky on
// CI's slow runner — observed `spawnSync node ETIMEDOUT` after 60s+. Reliable
// locally (~1-3s/test) but blows the spawn timeout on CI. Either move to
// tests/integration/ or mock the CLI. Follow-up: slow-subprocess-tests stub.
describe.skip('CLI cold-start — no identity in CWD or env', () => {
  let tmpCwd;

  beforeEach(() => {
    tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'rks-cold-start-'));
    // Sanity: ensure no .rks/project.json exists in the temp CWD.
    expect(fs.existsSync(path.join(tmpCwd, '.rks'))).toBe(false);
    // Satisfy the out-of-scope verifyHooksPresent check (a different FATAL
    // path, governed by a different story). With this directory present, the
    // CLI's failure modes here are scoped to the SELF_PROJECT_ID resolver
    // alone — which is what this story covers.
    fs.mkdirSync(path.join(tmpCwd, '.routekit', 'hooks'), { recursive: true });
  });

  afterEach(() => {
    if (tmpCwd) fs.rmSync(tmpCwd, { recursive: true, force: true });
  });

  function runCli(args = []) {
    const env = { ...process.env };
    delete env.ROUTEKIT_PROJECT_ID;
    return spawnSync('node', [CLI_BIN, ...args], {
      cwd: tmpCwd,
      env,
      encoding: 'utf8',
      timeout: SPAWN_TIMEOUT,
    });
  }

  it('`routekit --help` from a temp CWD does not emit the SELF_PROJECT_ID fatal diagnostic', () => {
    const result = runCli(['--help']);
    expect(result.error).toBeUndefined();
    // The SELF_PROJECT_ID fatal would emit the exact diagnostic string. Pre-fix,
    // it printed before anything else and forced a non-zero exit. Post-fix it
    // must NOT appear under any circumstance.
    expect(result.stderr || '').not.toContain('Cannot determine SELF_PROJECT_ID');
    // The `--help` output is on stdout, proving the CLI got past the
    // server.mjs import that previously crashed it.
    expect(result.stdout || '').toContain('routekit commands');
  });

  it('`routekit project list` from a temp CWD does not crash on SELF_PROJECT_ID resolution', () => {
    // `project list` is a low-side-effect verb that reads the shell's registry.
    // Pre-fix, this exited fatally before doing any work. Post-fix it must
    // execute its own logic and exit with whatever status that verb produces —
    // crucially WITHOUT the SELF_PROJECT_ID fatal.
    const result = runCli(['project', 'list']);
    expect(result.error).toBeUndefined();
    expect(result.stderr || '').not.toContain('[rks-mcp] FATAL');
    expect(result.stderr || '').not.toContain('Cannot determine SELF_PROJECT_ID');
  });

  it('explicit timeout is set on spawnSync (test hygiene)', () => {
    // Sentinel test — fail if SPAWN_TIMEOUT is unset or non-numeric. Keeps the
    // subprocess-timeout convention enforceable across the suite.
    expect(typeof SPAWN_TIMEOUT).toBe('number');
    expect(SPAWN_TIMEOUT).toBeGreaterThan(0);
  });
});
