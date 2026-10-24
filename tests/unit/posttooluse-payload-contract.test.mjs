/**
 * backlog.fix.posttooluse-tool-response-provenance — sibling sites + deployment parity.
 *
 * rag-embed-on-commit.mjs had a wrong-field read. It uses the tool result to detect a
 * FAILED `git commit`, so with tool_result always undefined (coerced to "") the failure
 * guard could never match and the hook treated EVERY commit as successful — spawning a
 * RAG embed after commits that actually failed.
 *
 * A bare field rename does NOT fix it, because Bash `tool_response` is an
 * OBJECT { stdout, stderr, interrupted, isImage }, and rag-embed-on-commit uses
 * value.includes("fatal:") — String.prototype.includes on an object THROWS TypeError,
 * which would crash the hook on every commit.
 * Hence the object->string normalization, which these tests force.
 *
 * Run:
 *   npx vitest run --config vitest.config.unit.mjs tests/unit/posttooluse-payload-contract.test.mjs
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveHookByName } from '../helpers/hook-path.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const SYSTEM_DIR = path.join(REPO_ROOT, 'packages', 'hooks', 'system');

const RAG_EMBED = path.join(SYSTEM_DIR, 'rag-embed-on-commit.mjs');

let tmpRoot;

beforeEach(() => {
  tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'posttooluse-')));
});

afterEach(() => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
});

function runHook(hookPath, payload) {
  return spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...process.env,
      ROUTEKIT_PROJECT_ROOT: tmpRoot,
      CLAUDE_PROJECT_DIR: tmpRoot,
    },
  });
}

function commitPayload(toolResponse) {
  return {
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'git commit -m "some message"' },
    tool_response: toolResponse,
  };
}

const FAILED_COMMIT = { stdout: '', stderr: 'fatal: not a git repository', interrupted: false, isImage: false };

describe('rag-embed-on-commit: object-shaped Bash tool_response', () => {
  it('FAILED commit spawns no embed and creates no .embed-lock', () => {
    const res = runHook(RAG_EMBED, commitPayload(FAILED_COMMIT));

    // Crash-safety: .includes() on an object would throw TypeError here.
    expect(res.status).toBe(0);
    expect(res.stderr || '').not.toMatch(/TypeError/);

    expect(fs.existsSync(path.join(tmpRoot, '.rks', 'rag', '.embed-lock'))).toBe(false);

    const log = path.join(tmpRoot, '.rks', 'rag', 'post-commit.log');
    if (fs.existsSync(log)) {
      expect(fs.readFileSync(log, 'utf8')).toMatch(/failed|skip/i);
    }
  });

  it('STRING back-compat: a plain-string failed response still skips the embed', () => {
    const res = runHook(RAG_EMBED, commitPayload('fatal: not a git repository'));
    expect(res.status).toBe(0);
    expect(fs.existsSync(path.join(tmpRoot, '.rks', 'rag', '.embed-lock'))).toBe(false);
  });

  it('does not throw on an object payload with neither stdout nor stderr', () => {
    const res = runHook(RAG_EMBED, commitPayload({ interrupted: false, isImage: false }));
    expect(res.status).toBe(0);
    expect(res.stderr || '').not.toMatch(/TypeError/);
  });
});

describe('rag-embed-on-commit: unknown-shape reporting', () => {
  it('a commit payload with NEITHER field exits 0 and reports the unrecognized shape', () => {
    const res = runHook(RAG_EMBED, {
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'git commit -m "x"' },
      // neither tool_response nor tool_result
    });

    expect(res.status).toBe(0);
    expect(res.stderr).toMatch(/\[rag-embed-on-commit\] Unrecognized PostToolUse payload/);
  });

  it('NO SECRET LEAKAGE: the diagnostic never embeds payload values', () => {
    const SECRET = 'ghp_THIS_MUST_NEVER_APPEAR';
    const res = runHook(RAG_EMBED, {
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: `git commit -m "${SECRET}"` },
    });

    expect(res.status).toBe(0);
    expect(res.stderr).toMatch(/Unrecognized PostToolUse payload/);
    expect(res.stderr).not.toContain(SECRET);
  });
});

describe('DEPLOYED VS CANONICAL PARITY', () => {
  const HOOKS = [
    'track-agent-provenance.mjs',
    'rag-embed-on-commit.mjs',
  ];

  it.each(HOOKS)('%s deployed copy is byte-identical to canonical', (name) => {
    const canonical = path.join(SYSTEM_DIR, name);
    expect(fs.existsSync(canonical), `canonical missing: ${canonical}`).toBe(true);

    // Resolve defensively — guardrails-off relocates the read/ and write/ tiers into
    // hooks.bak/. These live in system/, which stays in place, but resolve via the
    // helper anyway so the assertion does not depend on that detail.
    let deployed = null;
    try { deployed = resolveHookByName(name, REPO_ROOT); } catch { deployed = null; }
    if (!deployed || !fs.existsSync(deployed)) {
      // No deployed copy at all — nothing to compare. The sync itself is covered by
      // the SYNC + LIFECYCLE GREEN requirement.
      return;
    }

    expect(
      fs.readFileSync(deployed, 'utf8'),
      `${name}: deployed copy differs from canonical — run \`npm run sync-hooks\``,
    ).toBe(fs.readFileSync(canonical, 'utf8'));
  });
});
