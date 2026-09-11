/**
 * Hook subprocesses must detect a credential that exists only in `.env`.
 *
 * Hook scripts are separate node processes spawned fresh by Claude Code. They inherit only Claude
 * Code's shell environment and never call `dotenv.config()`, while the MCP server DOES load `.env`
 * at startup. So a key present in `.env` but unexported was visible to the server and invisible to
 * hooks — and the hooks then told agents "the Research Agent is unavailable" while
 * `rks_agent_research` was answering normally in the same session. Agents that believe that stop
 * investigating, which is the actual harm.
 *
 * WHY EVERY PROOF SPAWNS A SUBPROCESS: this is a subprocess-ENVIRONMENT defect. Calling
 * `isKeyless()` in-process shares this runner's environment and proves nothing about what a spawned
 * hook concludes. Every directional assertion below runs a real child process.
 *
 * SAFETY: a fake sentinel is used as the credential value and every spawn is asserted not to echo
 * it. No test may create, modify, or delete a `.env` at the repository root — the real one holds a
 * live credential.
 *
 * (backlog.fix.hook-credential-presence-dotenv)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = path.join(REPO_ROOT, 'packages', 'hooks');

/** Obvious fake. Must never appear in any spawn's output. */
const SENTINEL = 'sk-ant-api03-FAKE-TEST-SENTINEL-do-not-use';

let projectDir;

/** Env with every recognized credential key removed, so only `.env` can supply one. */
function bareEnv(extra = {}) {
  const env = { ...process.env, CLAUDE_PROJECT_DIR: projectDir, ...extra };
  delete env.ANTHROPIC_API_KEY;
  delete env.OPENAI_API_KEY;
  return env;
}

/**
 * Ask a spawned node process what credential-presence.mjs concludes.
 * Prints only the boolean verdict — never the value.
 */
function verdictFromSubprocess(env) {
  const src = `
    import { isKeyless } from ${JSON.stringify(path.join(HOOKS, 'system', 'credential-presence.mjs'))};
    process.stdout.write(String(isKeyless(process.env)));
  `;
  const harness = path.join(projectDir, 'harness.mjs');
  fs.writeFileSync(harness, src);
  const res = spawnSync(process.execPath, [harness], { encoding: 'utf8', timeout: 10000, env });
  return { keyless: res.stdout.trim() === 'true', res };
}

/** Spawn a real redirect hook and return its combined output. */
function runHook(rel, hookData, env) {
  const res = spawnSync(process.execPath, [path.join(HOOKS, rel)], {
    input: JSON.stringify(hookData),
    encoding: 'utf8',
    timeout: 10000,
    env,
  });
  return { ...res, combined: `${res.stdout || ''}${res.stderr || ''}` };
}

const KEYLESS_MSG = 'the Research Agent is unavailable';

beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-cred-'));
});

afterEach(() => {
  if (projectDir && fs.existsSync(projectDir)) fs.rmSync(projectDir, { recursive: true, force: true });
  // Belt and braces: this suite must never have touched the real one.
  expect(fs.existsSync(path.join(REPO_ROOT, '.env.test-fixture'))).toBe(false);
});

describe('credential presence in a spawned hook subprocess', () => {
  it('DIRECTION A: key present only in .env, not exported → credential detected', () => {
    fs.writeFileSync(path.join(projectDir, '.env'), `ANTHROPIC_API_KEY=${SENTINEL}\n`);

    const { keyless, res } = verdictFromSubprocess(bareEnv());

    expect(keyless).toBe(false);
    expect(`${res.stdout}${res.stderr}`).not.toContain(SENTINEL);
  });

  it('DIRECTION B: no key in env and no .env at all → stays keyless', () => {
    // The fresh-clone case. Must NOT be conflated with an error, or keyless mode dies for
    // exactly the audience it exists to serve.
    expect(fs.existsSync(path.join(projectDir, '.env'))).toBe(false);

    const { keyless } = verdictFromSubprocess(bareEnv());

    expect(keyless).toBe(true);
  });

  it('DIRECTION B: .env exists but holds no recognized key → stays keyless', () => {
    fs.writeFileSync(path.join(projectDir, '.env'), 'SOME_OTHER_VAR=value\n# a comment\n');

    const { keyless } = verdictFromSubprocess(bareEnv());

    expect(keyless).toBe(true);
  });

  it('FAIL-CLOSED: an unreadable .env is ambiguous → reports credential present', () => {
    // A directory named .env yields EISDIR — deterministic on CI, unlike chmod under root.
    fs.mkdirSync(path.join(projectDir, '.env'));

    const { keyless } = verdictFromSubprocess(bareEnv());

    // Ambiguity must never unlock the more permissive keyless posture.
    expect(keyless).toBe(false);
  });

  it('the missing and unreadable cases produce OPPOSITE verdicts', () => {
    // The trap: a naive try/catch lumping ENOENT in with every other error would report
    // credential-present on a bare clone and silently destroy keyless mode.
    const missing = verdictFromSubprocess(bareEnv()).keyless;
    fs.mkdirSync(path.join(projectDir, '.env'));
    const unreadable = verdictFromSubprocess(bareEnv()).keyless;

    expect(missing).toBe(true);
    expect(unreadable).toBe(false);
  });

  it('does NOT walk upward — an ancestor .env must not credential a child project', () => {
    const child = path.join(projectDir, 'child');
    fs.mkdirSync(child);
    fs.writeFileSync(path.join(projectDir, '.env'), `ANTHROPIC_API_KEY=${SENTINEL}\n`);

    const { keyless } = verdictFromSubprocess(bareEnv({ CLAUDE_PROJECT_DIR: child }));

    expect(keyless).toBe(true);
  });

  it('CLAUDE_PROJECT_DIR steers which project .env is consulted', () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-cred-other-'));
    try {
      fs.writeFileSync(path.join(other, '.env'), `OPENAI_API_KEY=${SENTINEL}\n`);

      expect(verdictFromSubprocess(bareEnv()).keyless).toBe(true);
      expect(verdictFromSubprocess(bareEnv({ CLAUDE_PROJECT_DIR: other })).keyless).toBe(false);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });
});

describe('the three redirect hooks stop announcing keyless when a key exists in .env', () => {
  const CASES = [
    ['read/redirect-read-to-agent.mjs', { tool_name: 'Read', tool_input: { file_path: 'packages/mcp-rks/src/server.mjs' } }],
    ['read/redirect-grep-to-agent.mjs', { tool_name: 'Grep', tool_input: { pattern: 'foo' } }],
    ['read/redirect-read-bash-to-agent.mjs', { tool_name: 'Bash', tool_input: { command: 'cat packages/mcp-rks/src/server.mjs' } }],
  ];

  for (const [rel, hookData] of CASES) {
    it(`${rel} — keyless text ABSENT when .env supplies a key`, () => {
      fs.writeFileSync(path.join(projectDir, '.env'), `ANTHROPIC_API_KEY=${SENTINEL}\n`);

      const res = runHook(rel, hookData, bareEnv());

      expect(res.combined).not.toContain(KEYLESS_MSG);
      expect(res.combined).not.toContain(SENTINEL);
    });

    it(`${rel} — keyless text PRESENT when genuinely keyless`, () => {
      // Proves the assertion above is not vacuous: the same hook, same payload, no .env.
      const res = runHook(rel, hookData, bareEnv());

      expect(res.combined).toContain(KEYLESS_MSG);
    });
  }
});
