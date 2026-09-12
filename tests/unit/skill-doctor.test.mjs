/**
 * Tests for the `/doctor` Dispatcher skill.
 *
 * Verifies the canonical `.claude/skills/doctor/SKILL.md` has the right
 * frontmatter, documents the invocation contract, and is byte-identical
 * to its templated copy under templates/generic/.claude/skills/doctor/SKILL.md.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const CANON = path.join(REPO_ROOT, '.claude/skills/doctor/SKILL.md');
const TEMPLATED = path.join(REPO_ROOT, 'templates/generic/.claude/skills/doctor/SKILL.md');

const canonRaw = fs.readFileSync(CANON, 'utf8');
const parsed = matter(canonRaw);
const fm = parsed.data;
const body = parsed.content;

describe('SKILL.md frontmatter', () => {
  it('parses as valid YAML frontmatter + markdown body', () => {
    expect(fm).toBeTypeOf('object');
    expect(body).toBeTypeOf('string');
    expect(body.length).toBeGreaterThan(50);
  });

  it('name === "doctor"', () => {
    expect(fm.name).toBe('doctor');
  });

  it('user-invocable === true', () => {
    expect(fm['user-invocable']).toBe(true);
  });

  it('disable-model-invocation === false', () => {
    expect(fm['disable-model-invocation']).toBe(false);
  });

  it('verbosity === "silent"', () => {
    expect(fm.verbosity).toBe('silent');
  });

  it('description is a non-empty string', () => {
    expect(typeof fm.description).toBe('string');
    expect(fm.description.trim().length).toBeGreaterThan(0);
  });

  it('contains no fields beyond the five established ones', () => {
    const allowed = new Set(['name', 'description', 'user-invocable', 'disable-model-invocation', 'verbosity']);
    for (const k of Object.keys(fm)) {
      expect(allowed.has(k), `unexpected frontmatter field: ${k}`).toBe(true);
    }
  });
});

describe('SKILL.md template parity', () => {
  it('templates/generic copy exists', () => {
    expect(fs.existsSync(TEMPLATED)).toBe(true);
  });

  it('templated copy is byte-identical to canonical', () => {
    const templated = fs.readFileSync(TEMPLATED, 'utf8');
    expect(templated).toBe(canonRaw);
  });

  it('parent directory templates/generic/.claude/skills exists', () => {
    expect(fs.existsSync(path.join(REPO_ROOT, 'templates/generic/.claude/skills'))).toBe(true);
  });
});

describe('SKILL.md body — invocation contract', () => {
  it('documents the `routekit doctor` command literally', () => {
    expect(body).toContain('routekit doctor');
  });

  it('documents the --dry-run flag forwarding', () => {
    expect(body).toContain('--dry-run');
  });

  it('documents single-invocation contract (no loop/retry)', () => {
    // The skill is intentionally a thin wrapper — invokes the CLI once per run.
    expect(body).toMatch(/once per skill invocation|exactly once|no loops|no retries/i);
  });

  it('documents non-recoverable findings must be surfaced', () => {
    expect(body).toMatch(/non[-\s]?recoverable/i);
  });

  it('documents per-child outcome reporting', () => {
    expect(body.toLowerCase()).toMatch(/per-child|outcomes/);
  });
});

describe('SKILL.md body — does not bypass the CLI', () => {
  it('does not reference any mcp__rks__* MCP tool', () => {
    expect(body).not.toMatch(/mcp__rks__/);
  });

  it('does not reference rks_* internal helpers (e.g. rks_governor_init, rks_agent_*)', () => {
    expect(body).not.toMatch(/\brks_(governor|agent|guardrails|story|cycle|ship|exec|plan|publish|telemetry|kg|rag|init|preflight|review|refine|reset|restore|resolve|stash|tag|validate)/);
  });
});
