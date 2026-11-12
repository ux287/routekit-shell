/**
 * Pins the user-facing release notes for v0.85.0 onward in CHANGELOG.md.
 * (backlog.docs.release-notes-backfill-0-85-0-onward)
 *
 * Static doc-content test: reads CHANGELOG.md and the story notes' frontmatter,
 * no fixtures, no subprocesses.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const CHANGELOG = fs.readFileSync(path.resolve('CHANGELOG.md'), 'utf8').split('\n');
const NOTES_DIR = path.resolve('notes');

// AC1: the in-scope list recorded in the story note. Append any later old-process release.
const IN_SCOPE = ['0.87.0', '0.86.0', '0.85.0'];

const HEADING_RE = /^## \[(\d+)\.(\d+)\.(\d+)\] - \d{4}-\d{2}-\d{2}$/;
const COMMIT_SUBJECT_RE = /^- (feat|fix|docs|chore|refactor|test|ci|build|perf|style|revert)(\([^)]*\))?!?: /;
const ENTRY_RE = /^- (New|Fix|Changed): \S/;

// version -> { normalizedStoryId: { line: '<durable substring of its body line>' } | { omitted: '<reason>' } }
// normalizedStoryId strips a 'z_implemented.' segment so archival renames do not break the map.
const COVERAGE = {
  '0.87.0': {
    'backlog.feat.dispatch-detach-status': { line: '`routekit dispatch --detach` starts a governed run in the background' },
    'backlog.fix.dispatch-worker-handoff-nonce': { line: 'must now present a key issued for its own run' },
    'backlog.fix.dispatch-status-segment-truthfulness': { line: 'Dispatch status is now truthful' },
    'backlog.fix.dispatch-permission-denials-truthful': { line: 'Dispatch now counts permission denials correctly' },
    // One line covers both shell-bypass fixes (run_command and preCommands).
    'backlog.fix.run-command-shell-metacharacter-bypass': { line: 'Plan commands (`run_command`) and a story\'s `preCommands` no longer run through a shell' },
    'backlog.fix.story-precommands-shell-bypass': { line: 'Plan commands (`run_command`) and a story\'s `preCommands` no longer run through a shell' },
    'backlog.fix.run-command-allowlist-admits-arbitrary-code': { line: 'The command allowlist no longer accepts bare interpreters' },
    // One line covers the per-run policy snapshot and the in-run integrity check.
    'backlog.fix.run-command-policy-snapshot-per-run': { line: 'The command policy is read once per run' },
    'backlog.fix.command-policy-integrity-across-runs': { line: 'a policy change during a run stops the run and rolls it back' },
    'backlog.fix.run-command-honest-and-usable': { line: 'A plan command that rks did not run' },
    'backlog.fix.exec-commit-set-protected-paths': { line: "A build never commits rks's own governance files" },
    'backlog.fix.precommands-arch-digest-binding': { line: "Changing a story's `preCommands` after ARCH approval now counts as changing the story" },
    'backlog.fix.exec-pending-ship-reported-when-commit-failed': { line: 'A build whose commit was rejected' },
    // One line covers the three exec cleanup fixes (mid-apply stop, gitignored backup, abort).
    'backlog.fix.exec-apply-stop-restores-base-branch-and-backup': { line: 'When a build stops partway, rks now cleans up the way it says it does' },
    'backlog.fix.exec-backup-stash-fails-when-protected-path-gitignored': { line: 'including when `.rks/` is gitignored' },
    'backlog.fix.exec-abort-cleanup-observed': { line: '`rks_exec_abort` actually carries out the cleanup it reports' },
    'backlog.fix.cleanup-feature-branch-unmerged-guard': { line: 'rks no longer force-deletes a build branch that holds commits not yet merged' },
  },
  '0.86.0': {
    // One line covers both provenance-trailer stories (first sites and remaining sites).
    'backlog.feat.commit-provenance-trailer': { line: 'Commits that rks makes now carry an `Rks-Provenance` trailer' },
    'backlog.feat.commit-provenance-trailer-remaining-sites': { line: 'Commits that rks makes now carry an `Rks-Provenance` trailer' },
    'backlog.feat.commit-provenance-ci-verifier': { line: '`routekit verify-provenance` checks a range of commits' },
    'backlog.feat.commit-provenance-since-baseline': {
      omitted: "sets this repository's own commitProvenance.since baseline in its project config (and a publish-profile exclude for its test); no product behaviour changes, and the starting-commit setting itself is described in the verify-provenance line",
    },
    'backlog.feat.server-lane-policy': { line: 'Per-project lanes let a project make some ways of reaching rks' },
    'backlog.feat.routekit-dispatch-headless': { line: '`routekit dispatch` runs the full rks Dispatcher headlessly' },
    'backlog.feat.token-gate-bypass-visible': { line: 'A disabled token gate is now reported, never silent' },
    // One line covers both dispatch self-approval fixes (release tools and PO confirmation).
    'backlog.fix.dispatch-fresh-run-never-release': { line: 'Release tools are admitted only when the user answers a checkpoint in a run the user started' },
    'backlog.fix.dispatch-fresh-run-release-test-backfill': {
      omitted: 'test-only: adds the unwritten tests for backlog.fix.dispatch-fresh-run-never-release; no behaviour change',
    },
    'backlog.fix.dispatch-reserve-po-confirmation-by-default': { line: 'confirming new PO stories is reserved for the user by default' },
    'backlog.fix.invalid-token-autoroutes-release-to-ship': { line: 'An invalid or outdated governor token is now refused' },
    // One line covers the exec coverage gate and the archive-time coverage check.
    'backlog.fix.exec-test-requirements-coverage-gate': { line: 'A build now counts as executed only when every test requirement maps to a test that was seen passing' },
    'backlog.fix.ship-archive-requires-exec-coverage-record': { line: 'a story cannot be archived without that record' },
    'backlog.fix.offrail-ship-advances-on-truncated-review': { line: 'Off-rail ship no longer marks a story integrated when the reviewer saw only part of the diff' },
    'backlog.fix.target-extraction-prose-bullets-read-as-paths': { line: 'The planner no longer mistakes prose bullets under `## Target Files` for file paths' },
    'backlog.fix.governor-end-dispatch-ended-count-deterministic': { line: 'Telemetry events emitted during a write are no longer lost' },
    'backlog.fix.upgrade-provenance-test-hermetic-git-identity': {
      omitted: 'test-only: gives one unit test a hermetic git identity so staging CI is green; no behaviour change',
    },
  },
  '0.85.0': {
    // One line covers the call runner and its throw-path session-end fix.
    'backlog.feat.cli-call-batch-runner': { line: '`routekit call --project <id>` lets an external agent or script run rks tool calls' },
    'backlog.fix.cli-call-throw-path-session-end-report': { line: 'always closed and reported, even when a step fails' },
    'backlog.feat.governor-session-end': { line: 'Governors now end their own sessions when they finish (`rks_governor_end`)' },
    'backlog.feat.project-lease-actor-attribution': { line: 'The server now enforces which Governors may run together on a project' },
    // One line covers both project-lease reliability fixes.
    'backlog.fix.project-lease-executing-holder-and-offrail-retry': { line: 'A session that is busy in another process keeps its lease, retrying guardrails-off no longer drops it' },
    'backlog.fix.project-lease-post-init-verification-and-conversion-window': { line: 'a session that lost its lease is told who holds the project' },
    'backlog.feat.dendron-rename-note-wikilinks': { line: '`dendron_rename_note` renames or moves a note and updates every link to it' },
    // One line covers the multi-field tool and the child-permission fix for it.
    'backlog.feat.dendron-update-fields-multi-field': { line: '`dendron_update_fields` sets several frontmatter fields in one write and one commit' },
    'backlog.fix.child-permissions-classify-dendron-update-fields': { line: 'Child projects allow it without a prompt' },
    'backlog.fix.autoroute-untokened-dendron-update-field': { line: 'An untokened `dendron_update_field` is refused with a clear message' },
    // One line covers both git-agent honesty fixes.
    'backlog.fix.git-agent-max-turns-verified-final-state': { line: 'no longer says a successful commit failed because it ran out of turns' },
    'backlog.fix.git-agent-state-evidence-bound': { line: 'its status answers are checked against the real git state' },
    // One line covers the complete file list and the state-allowlist gap.
    'backlog.fix.git-state-complete-file-list': { line: '`rks_git_state` lists every changed file instead of silently stopping at 20' },
    'backlog.fix.governor-state-allowlist-gaps': { line: 'the Ship Governor no longer fails with `chain_violation` when it checks git state' },
    'backlog.fix.governor-token-project-root-at-boot': { line: 'A governor token created by one rks process now works in a fresh process' },
    'backlog.fix.mcp-boot-dotenv-bypass-vars': { line: 'A `.env` file can no longer switch governance off' },
    'backlog.fix.yaml-frontmatter-quoting': { line: 'Frontmatter list entries that begin with a quote' },
    'backlog.fix.skill-distribution-allowlist-release-line-drift': {
      omitted: 'test-only: re-pins three line numbers in the skill-distribution invariant test allowlist; no behaviour change',
    },
  },
};

function compareVersion(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

function sections(lines) {
  // returns [{ version, headingIndex, body: string[] }] where body is the lines strictly
  // between a `## [x.y.z] - date` heading and the next `## [` heading (or EOF)
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = HEADING_RE.exec(lines[i]);
    if (!m) continue;
    let j = i + 1;
    while (j < lines.length && !lines[j].startsWith('## [')) j++;
    out.push({ version: `${m[1]}.${m[2]}.${m[3]}`, headingIndex: i, body: lines.slice(i + 1, j) });
  }
  return out;
}

function normalizeId(id) {
  return id.replace(/(^|\.)z_implemented\./, '$1');
}

function frontmatterOf(text) {
  const lines = text.split('\n');
  if (lines[0].trim() !== '---') return null;
  const end = lines.indexOf('---', 1);
  if (end < 0) return null;
  return lines.slice(1, end);
}

let releasedCache = null;
function releasedStories(version) {
  // reads notes/*.md, parses ONLY the frontmatter block between the opening and closing `---`,
  // returns normalized ids whose `releasedIn` equals `version`
  if (!releasedCache) {
    releasedCache = [];
    for (const name of fs.readdirSync(NOTES_DIR)) {
      if (!name.endsWith('.md')) continue;
      const full = path.join(NOTES_DIR, name);
      if (!fs.statSync(full).isFile()) continue;
      const fm = frontmatterOf(fs.readFileSync(full, 'utf8'));
      if (!fm) continue;
      for (const line of fm) {
        const m = /^releasedIn:\s*["']?([^"'\s]+)["']?\s*$/.exec(line);
        if (m) {
          releasedCache.push({ id: normalizeId(name.slice(0, -'.md'.length)), releasedIn: m[1] });
          break;
        }
      }
    }
  }
  return new Set(releasedCache.filter((r) => r.releasedIn === version).map((r) => r.id));
}

const SECTIONS = sections(CHANGELOG);
const bodyOf = (version) => {
  const s = SECTIONS.find((x) => x.version === version);
  if (!s) throw new Error(`no CHANGELOG section for ${version}`);
  return s.body;
};

describe('CHANGELOG 0.85.0+ headings', () => {
  const PINNED = [
    '## [0.87.0] - 2026-11-07',
    '## [0.86.0] - 2026-11-03',
    '## [0.85.0] - 2026-11-01',
    '## [0.84.0] - 2026-10-25',
  ];

  it('contains each pinned heading exactly once, in order, with no other heading between consecutive ones', () => {
    const indices = PINNED.map((h) => {
      const hits = CHANGELOG.reduce((acc, l, i) => (l === h ? [...acc, i] : acc), []);
      expect(hits, h).toHaveLength(1);
      return hits[0];
    });
    for (let k = 1; k < indices.length; k++) {
      expect(indices[k]).toBeGreaterThan(indices[k - 1]);
      const between = CHANGELOG.slice(indices[k - 1] + 1, indices[k]).filter((l) => l.startsWith('## ['));
      expect(between, `${PINNED[k - 1]} .. ${PINNED[k]}`).toEqual([]);
    }
  });

  it('lists every release heading from 0.85.0 to the highest IN_SCOPE version in IN_SCOPE', () => {
    const highest = [...IN_SCOPE].sort(compareVersion).at(-1);
    const inRange = SECTIONS.map((s) => s.version).filter(
      (v) => compareVersion(v, '0.85.0') >= 0 && compareVersion(v, highest) <= 0,
    );
    expect(inRange.length).toBeGreaterThan(0);
    for (const v of inRange) expect(IN_SCOPE, v).toContain(v);
    expect(Object.keys(COVERAGE).sort()).toEqual([...IN_SCOPE].sort());
  });
});

describe('CHANGELOG 0.85.0+ bodies are user-facing', () => {
  for (const version of IN_SCOPE) {
    it(`${version}: body starts and ends with exactly one blank line and has content`, () => {
      const body = bodyOf(version);
      expect(body.length).toBeGreaterThanOrEqual(3);
      expect(body[0]).toBe('');
      expect(body[1]).not.toBe('');
      expect(body.at(-1)).toBe('');
      expect(body.at(-2)).not.toBe('');
      expect(body.filter((l) => l.trim() !== '').length).toBeGreaterThan(0);
    });

    it(`${version}: no body line is a conventional-commit subject`, () => {
      const offenders = bodyOf(version).filter((l) => COMMIT_SUBJECT_RE.test(l));
      expect(offenders).toEqual([]);
    });

    it(`${version}: every non-blank body line is a New/Fix/Changed entry`, () => {
      const offenders = bodyOf(version).filter((l) => l.trim() !== '' && !ENTRY_RE.test(l));
      expect(offenders).toEqual([]);
    });
  }
});

describe('CHANGELOG 0.85.0+ story coverage', () => {
  for (const version of IN_SCOPE) {
    it(`${version}: COVERAGE keys equal the stories whose frontmatter releasedIn is ${version}`, () => {
      const released = [...releasedStories(version)].sort();
      expect(released.length).toBeGreaterThan(0);
      expect(Object.keys(COVERAGE[version]).sort()).toEqual(released);
    });

    it(`${version}: every covered story's line is in the body and every omission has a reason`, () => {
      const lines = bodyOf(version).filter((l) => l.trim() !== '');
      for (const [id, entry] of Object.entries(COVERAGE[version])) {
        if ('line' in entry) {
          expect(typeof entry.line, id).toBe('string');
          expect(entry.line.length, id).toBeGreaterThan(0);
          expect(lines.some((l) => l.includes(entry.line)), `${id}: ${entry.line}`).toBe(true);
        } else {
          expect(typeof entry.omitted, id).toBe('string');
          expect(entry.omitted.trim().length, id).toBeGreaterThan(0);
        }
      }
    });
  }
});
