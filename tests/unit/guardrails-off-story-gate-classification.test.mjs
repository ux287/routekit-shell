/**
 * Tests for backlog.fix.guardrails-off-branch-aware-story-gate.
 *
 * The story-note gate in `guardrailsOff` used to be a single
 * `storyPhase !== 'arch-approved'` test whose subject stayed `null` in three
 * structurally different situations:
 *
 *   1. the note file does not exist in the current worktree (it lives on
 *      another branch)
 *   2. the note exists but its frontmatter carries no `phase` field
 *   3. the read or frontmatter parse threw, and a bare `catch {}` swallowed it
 *
 * All three collapsed into `reason: 'story_not_ready'` with the message
 * "(current: not found)". Only case 2 is honestly a phase problem. Case 1 is a
 * BRANCH problem, and the advice attached to story_not_ready — run PO → QA →
 * ARCH — is actively wrong for it, because the story is frequently already
 * arch-approved on the branch that has the note. Case 3 was silent.
 *
 * `classifyStoryGate` is the pure split-out of that decision. The caller does
 * all fs/git I/O and hands over a descriptor, which is what lets these tests
 * live in the unit tier at all — tests/unit rejects spawn-family calls
 * (SPAWN_FAMILY_RE in tests/unit/unit-tier-purity.test.mjs).
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { classifyStoryGate } from '../../packages/mcp-rks/src/server/guardrails-audit.mjs';
import { PHASE_GATE_GUARDRAIL } from '../../packages/mcp-rks/src/workflow/phases.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const AUDIT_SRC = fs.readFileSync(
  path.join(REPO_ROOT, 'packages/mcp-rks/src/server/guardrails-audit.mjs'),
  'utf8'
);

const STORY_ID = 'backlog.fix.example';
const NOTE_PATH = '/repo/notes/backlog.fix.example.md';

/** A descriptor for the happy path; override one field per test. */
function descriptor(overrides = {}) {
  return {
    problemId: STORY_ID,
    notePath: NOTE_PATH,
    noteExists: true,
    phase: PHASE_GATE_GUARDRAIL,
    readError: null,
    archivedNotePath: null,
    branch: 'staging',
    ...overrides,
  };
}

describe('classifyStoryGate — pass path', () => {
  it('passes when the note exists, is readable, and is arch-approved', () => {
    const result = classifyStoryGate(descriptor());
    expect(result.ok).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('uses the real PHASE_GATE_GUARDRAIL value, not a hardcoded string', () => {
    expect(PHASE_GATE_GUARDRAIL).toBe('arch-approved');
    expect(classifyStoryGate(descriptor({ phase: PHASE_GATE_GUARDRAIL })).ok).toBe(true);
  });
});

describe('classifyStoryGate — story_note_not_on_branch (the branch problem)', () => {
  it('fires when the note is absent and there was no read error', () => {
    const result = classifyStoryGate(descriptor({ noteExists: false, phase: null }));
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('story_note_not_on_branch');
  });

  it('names the branch and the path it looked at', () => {
    const result = classifyStoryGate(
      descriptor({ noteExists: false, phase: null, branch: 'rks/some-feature' })
    );
    expect(result.message).toContain('rks/some-feature');
    expect(result.message).toContain(NOTE_PATH);
    expect(result.message).toMatch(/branch problem, not a phase problem/i);
  });

  it('does not tell the operator to re-run the pipeline', () => {
    // The whole point of separating this reason: the story is often already
    // arch-approved on another branch, so PO → QA → ARCH would be wasted work
    // on an approved story.
    const result = classifyStoryGate(descriptor({ noteExists: false, phase: null }));
    expect(result.message).not.toMatch(/PO → QA → ARCH/);
    expect(result.message).not.toMatch(/has not reached phase/);
  });

  it('reports an archived counterpart as already shipped, naming its path', () => {
    const archived = '/repo/notes/backlog.z_implemented.fix.example.md';
    const result = classifyStoryGate(
      descriptor({ noteExists: false, phase: null, archivedNotePath: archived })
    );
    expect(result.reason).toBe('story_note_not_on_branch');
    expect(result.message).toMatch(/already shipped/i);
    expect(result.message).toMatch(/archived/i);
    expect(result.message).toContain(archived);
  });

  it('omits the archived sentence when there is no counterpart', () => {
    const result = classifyStoryGate(descriptor({ noteExists: false, phase: null }));
    expect(result.message).not.toMatch(/already shipped/i);
  });
});

describe('classifyStoryGate — story_not_ready (the genuine phase problem)', () => {
  it('fires only when the note is present with a non-approved phase', () => {
    for (const phase of ['draft', 'ready', 'executing', 'integrated']) {
      const result = classifyStoryGate(descriptor({ phase }));
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('story_not_ready');
    }
  });

  it('reports the phase value actually supplied', () => {
    expect(classifyStoryGate(descriptor({ phase: 'draft' })).message).toContain('draft');
    expect(classifyStoryGate(descriptor({ phase: 'ready' })).message).toContain('ready');
  });

  it('describes a present-but-phaseless note without claiming the note is missing', () => {
    // Case 2: the note IS here, its frontmatter just has no phase field. This
    // is the only one of the three original cases that story_not_ready ever
    // described honestly.
    const result = classifyStoryGate(descriptor({ phase: null }));
    expect(result.reason).toBe('story_not_ready');
    expect(result.message).toMatch(/no phase field/i);
  });

  it('is NOT returned when the note is absent', () => {
    expect(classifyStoryGate(descriptor({ noteExists: false, phase: null }).reason)).not.toBe(
      'story_not_ready'
    );
  });
});

describe('classifyStoryGate — story_note_unreadable (the formerly silent case)', () => {
  it('fires when a read error is present', () => {
    const result = classifyStoryGate(
      descriptor({ readError: new Error('EACCES: permission denied') })
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('story_note_unreadable');
  });

  it('surfaces the underlying error text', () => {
    const result = classifyStoryGate(
      descriptor({ readError: new Error('unexpected end of the stream') })
    );
    expect(result.message).toContain('unexpected end of the stream');
  });

  it('accepts a non-Error thrown value without losing it', () => {
    const result = classifyStoryGate(descriptor({ readError: 'raw string failure' }));
    expect(result.reason).toBe('story_note_unreadable');
    expect(result.message).toContain('raw string failure');
  });

  it('takes precedence over the absent-note branch', () => {
    // A failed read must not be reclassified as "the note is on another
    // branch" — that was exactly the swallowing behavior being removed.
    const result = classifyStoryGate(
      descriptor({ noteExists: false, phase: null, readError: new Error('boom') })
    );
    expect(result.reason).toBe('story_note_unreadable');
  });
});

describe('classifyStoryGate — invariants across every failure path', () => {
  const failures = [
    ['absent note', descriptor({ noteExists: false, phase: null })],
    ['no phase field', descriptor({ phase: null })],
    ['wrong phase', descriptor({ phase: 'draft' })],
    ['read error', descriptor({ readError: new Error('kaboom') })],
  ];

  it("never produces the string '(current: not found)'", () => {
    // The original message rendered this for all three collapsed cases and is
    // what sent the Dispatcher chasing a phase gate that was not the problem.
    for (const [label, d] of failures) {
      const result = classifyStoryGate(d);
      expect(result.message, label).not.toContain('(current: not found)');
      expect(result.message, label).not.toContain('not found');
    }
  });

  it('carries storyId, branch and notePath on every failure return', () => {
    for (const [label, d] of failures) {
      const result = classifyStoryGate(d);
      expect(result.ok, label).toBe(false);
      expect(result.storyId, label).toBe(STORY_ID);
      expect(result.branch, label).toBe('staging');
      expect(result.notePath, label).toBe(NOTE_PATH);
    }
  });

  it('renders a readable placeholder for a branch-less checkout and does not throw', () => {
    // getCurrentBranch returns the literal 'HEAD' on a detached checkout and
    // null when it cannot resolve at all. Neither may read as a branch name.
    for (const branch of [null, undefined, '', 'HEAD']) {
      const d = descriptor({ noteExists: false, phase: null, branch });
      let result;
      expect(() => { result = classifyStoryGate(d); }).not.toThrow();
      expect(result.reason).toBe('story_note_not_on_branch');
      expect(result.message).toMatch(/detached HEAD \/ no current branch/);
      expect(result.message).not.toMatch(/branch `HEAD`/);
    }
  });

  it('preserves the supplied branch value on the payload even when unresolvable', () => {
    const result = classifyStoryGate(descriptor({ noteExists: false, phase: null, branch: null }));
    expect(result.branch).toBeNull();
  });

  it('does not throw when called with no arguments at all', () => {
    expect(() => classifyStoryGate()).not.toThrow();
    expect(classifyStoryGate().reason).toBe('story_note_not_on_branch');
  });
});

describe('guardrails-audit.mjs — wiring and purity', () => {
  // Fragment-built so this file cannot trip the unit-tier purity guard.
  const SPAWN_FAMILY = new RegExp(
    '(?<![\\w.])(' + 'spawn' + 'Sync|spawn|' + 'exec' + 'Sync|' + 'exec' + '|fork)\\s*\\(',
    'g'
  );

  function classifyBody() {
    const start = AUDIT_SRC.indexOf('export function classifyStoryGate');
    expect(start).toBeGreaterThan(-1);
    // Bound at the next top-level export so the slice is anchor-to-anchor
    // rather than a fixed character window.
    const end = AUDIT_SRC.indexOf('export async function guardrailsOff', start);
    expect(end).toBeGreaterThan(start);
    return AUDIT_SRC.slice(start, end);
  }

  it('imports getCurrentBranch from utils/git.mjs', () => {
    expect(AUDIT_SRC).toMatch(
      /import\s*\{[^}]*getCurrentBranch[^}]*\}\s*from\s*['"]\.\.\/utils\/git\.mjs['"]/
    );
  });

  it('resolves the branch non-fatally rather than adding a git call site', () => {
    expect(AUDIT_SRC).toMatch(
      /getCurrentBranch\(\s*projectRoot\s*,\s*\{\s*throwOnError:\s*false\s*\}\s*\)/
    );
  });

  it('keeps classifyStoryGate free of fs, git and subprocess work', () => {
    const body = classifyBody();
    expect(body).not.toMatch(SPAWN_FAMILY);
    expect(body).not.toMatch(/\bfs\./);
    expect(body).not.toMatch(/existsSync/);
    expect(body).not.toMatch(/readFileSync/);
    expect(body).not.toMatch(/getCurrentBranch\(/);
    expect(body).not.toMatch(/resolveNotesDir/);
  });

  it('no longer swallows the note read failure with a bare catch', () => {
    expect(AUDIT_SRC).not.toContain('} catch { /* treat as missing */ }');
  });

  it('routes the gate through the classifier instead of returning inline', () => {
    expect(AUDIT_SRC).toMatch(/const gate = classifyStoryGate\(/);
    expect(AUDIT_SRC).toMatch(/if \(!gate\.ok\) return gate;/);
  });
});
