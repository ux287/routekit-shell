/**
 * Pins the user-facing release notes for v0.88.0 in CHANGELOG.md.
 * (backlog.docs.release-notes-rewrite-0-88-0)
 *
 * Static doc-content test: reads CHANGELOG.md and the story notes' frontmatter,
 * no fixtures, no subprocesses.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CHANGELOG = fs.readFileSync(path.resolve('CHANGELOG.md'), 'utf8').split('\n');
const NOTES_DIR = path.resolve('notes');

const VERSION = '0.88.0';
const HEADING = '## [0.88.0] - 2026-11-11';
const NEXT_HEADING = '## [0.87.0] - 2026-11-07';
const GROUPS = ['Added', 'Changed', 'Fixed', 'Security', 'Removed', 'Internal'];
const RESTART_LINE = 'Restart the MCP server after upgrading so it loads the new code.';

const HEADING_RE = /^## \[(\d+)\.(\d+)\.(\d+)\] - \d{4}-\d{2}-\d{2}$/;
const COMMIT_SUBJECT_RE = /^- (feat|fix|docs|chore|refactor|test|ci|build|perf|style|revert)(\([^)]*\))?!?: /;
const GROUP_RE = /^### (\S+)$/;
const BULLET_RE = /^- \S/;
// The private contributor's names are built from character codes at runtime so that
// this file's own source never spells either of them (tests/** reaches the public mirror).
const PRIVATE_NAME_RE = new RegExp(
  [[115, 105, 109, 111, 110], [119, 101, 110, 109, 111, 117, 116, 104]]
    .map((c) => String.fromCharCode(...c))
    .join('|'),
  'i',
);
const SELF_SOURCE = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');

// normalizedStoryId -> { line: '<durable substring of its body line>' } | { omitted: '<reason>' }
// normalizedStoryId strips a 'z_implemented.' segment so archival renames do not break the map.
const COVERAGE = {
  // Added
  'backlog.feat.remote-surface-lane': { line: 'Remote lane for single-owner surface clients' },
  'backlog.feat.remote-surface-http-entry': { line: 'a Streamable-HTTP entry for the remote lane' },
  'backlog.feat.remote-http-entry-multi-session': { line: 'serves several clients at once' },
  'backlog.feat.http-entry-held-stream-bound': { line: 'sends SSE heartbeats' },
  'backlog.feat.preflight-secret-scan-posture': { line: 'reports a `secret_scan` check' },
  'backlog.feat.eval-suite-skeleton': { line: 'Eval suite: a new `evals/` directory' },
  'backlog.feat.eval-rag-retrieval-runner': { line: '`npm run eval:rag` runs' },
  'backlog.fix.rag-query-ranked-telemetry': { line: 'per-note semantic candidates' },
  // Changed
  'backlog.feat.release-write-release-notes': { line: '`rks_release` requires written release notes' },
  'backlog.feat.restrict-ship-to-ship-governor': { line: 'require a live Governor token' },
  'backlog.fix.rag-embed-lock-never-acquired-in-process': { line: 'hold the embed lock for their whole run' },
  'backlog.fix.concurrent-sessions-counts-returned-governors': { line: 'says what its concurrency count measures' },
  'backlog.fix.governor-requirement-coverage-frontmatter-write': { line: "The QA Governor writes a story's `requirementCoverage` map" },
  'backlog.docs.release-notes-backfill-0-85-0-onward': { line: 'The 0.85.0, 0.86.0 and 0.87.0 release notes were rewritten' },
  'backlog.fix.public-canon-what-is-rks-current-model': { line: 'the public "What is rks" page' },
  'backlog.fix.public-getting-started-credentials-and-phase': { line: 'the public getting-started guide' },
  // Fixed
  'backlog.fix.exec-refuse-plan-without-requirement-coverage-map': { line: 'refuses a plan with no complete `requirementCoverage` map before applying it' },
  'backlog.fix.reviewer-mode-plan-drops-requirement-coverage': { line: 'Reviewer-mode planning no longer drops' },
  'backlog.fix.exec-coverage-gate-behavioral-test-gaps': { line: 'is reported as `incomplete`, not `absent`' },
  'backlog.fix.exec-rollback-orphans-created-files': { line: 'A rolled-back build reverts the files its own plan wrote' },
  'backlog.fix.exec-write-record-attempt-scope': { line: 'now covers one `rks_exec` attempt' },
  'backlog.fix.exec-write-record-hardening': { line: 'Plan and fix-plan targets that resolve outside the project root are refused' },
  'backlog.fix.exec-write-record-revert-and-containment-followups': { line: 'Containment is checked for every plan step' },
  'backlog.fix.exec-write-record-attempt-retention': { line: 'no longer grows without limit' },
  'backlog.fix.exec-write-record-rotation-failure-diagnostics': { line: 'When rotating the write record fails' },
  'backlog.fix.exec-rollback-nothing-to-restore-log': { line: 'Rollback no longer logs `Rollback failed`' },
  'backlog.fix.exec-tests-exhausted-steps-applied-length': { line: 'ran out of test retries' },
  'backlog.fix.plan-review-cross-story-bleed-and-silent-transition': { line: '`rks_plan_review` called with neither' },
  'backlog.fix.governor-session-records-never-swept': { line: 'removes dead Governor session records' },
  'backlog.fix.offrail-ship-and-phase-repair-skip-archive': { line: 'Off-rail auto-ship (`rks_guardrails_on`) and `rks_phase_repair` archive' },
  'backlog.fix.dendron-update-field-id-write-silently-discarded': { line: 'refuses a write to `id`' },
  'backlog.fix.note-commit-multipath-drops-archived-note': { line: "pushes both the old note's deletion and its archived copy" },
  'backlog.fix.rks-init-post-attach-commit-refused-by-gitleaks-gate': { line: '`rks_init` no longer loses its initial commit' },
  'backlog.fix.preflight-secret-scan-hook-file-armed': { line: 'when the hook file `.routekit/git-hooks/pre-commit` is missing' },
  'backlog.fix.remote-lane-tools-list-advertises-refused-tools': { line: '`tools/list` advertises only the five tools' },
  'backlog.fix.remote-lane-init-capabilities-overstate-admission': { line: 'blocked by the lane (`remote_lane`)' },
  'backlog.fix.remote-rag-query-inline-full-index-build': { line: 'returns `rag_index_unavailable`' },
  'backlog.fix.http-entry-idle-eviction-inflight': { line: 'no longer evicts a session that has a request in flight' },
  'backlog.fix.http-entry-handle-failure-headers-sent': { line: 'fails after headers were sent' },
  'backlog.fix.rag-embed-lock-stale-reclaim-integrity': { line: 'Stale embed-lock recovery removes only the lock record it inspected' },
  'backlog.fix.rag-embed-lock-liveness-eperm-alive': { line: 'held by a live process of another user' },
  'backlog.fix.rag-embed-no-change-return-orphans-stale-rows': { line: 'An embed with no changes deletes index rows' },
  'backlog.fix.rag-embed-result-file-outcomes-unbounded': { line: '`rks_rag_embed` results are bounded' },
  // Security
  'backlog.security.gitleaks-gate-arming': { line: 'The gitleaks pre-commit gate is armed by default' },
  'backlog.security.ci-secret-scan-workflow': { line: 'A CI workflow scans every push and pull request' },
  'backlog.security.secret-scan-config-from-base-ref': { line: 'from the base commit' },
  'backlog.fix.secret-scan-gitleaks-download-retry': { line: 'retries a transient failure to download gitleaks' },
  'backlog.security.publish-mirror-secret-scan': { line: 'secret-scans the assembled public mirror' },
  'backlog.security.publish-mirror-gitleaksignore-refusal': { line: 'root `.gitleaksignore`' },
  'backlog.feat.remote-surface-lane-isolation': { line: 'Remote lane isolation' },
  'backlog.fix.remote-http-entry-env-leaks': { line: 'keeps its bearer secret out of `process.env`' },
  // Removed
  'backlog.chore.retire-legacy-rag-benchmark': { line: 'The legacy synthetic RAG benchmark' },
  // Internal
  'backlog.fix.test-suite-deletes-live-governor-sessions': { line: "delete the live project's Governor session or lease records" },
  'backlog.fix.test-suite-mutates-live-project-registry': { line: 'change the live project registry' },
  'backlog.fix.session-sweep-refuse-live-root-under-test': { line: 'let the session sweep delete live records' },
  'backlog.fix.live-root-guard-test-vitest-unset-targets-live-root': { line: 'the live-root guard test' },
  'backlog.fix.session-sweep-guard-state-polarity-inverted': { line: 'guardrails check was corrected before release' },
  'backlog.fix.story-ship-chain-result-test-leaks-session-records': { line: 'no longer leaks session records' },
  'backlog.fix.story-ship-chain-result-test-ci-root-unpinned': { line: 'passes on a fresh CI checkout' },
  'backlog.fix.telemetry-triage-verdict-server-start-transport': { line: 'telemetry-mock triage entry' },
  'backlog.fix.offrail-roots-count-pins-31': { line: 're-baselined to 31' },
  'backlog.fix.http-entry-reservation-race-test': { line: 'session-slot reservation' },
  'backlog.fix.http-entry-test-stale-single-session-comment': { line: 'stale one-session comment' },
  'backlog.fix.exec-write-record-wrong-shape-regression-pin': { line: 'wrong-shape write records' },
  'backlog.fix.find-latest-run-dir-doc-and-ordering-invariant': { line: 'run-folder name ordering' },
  'backlog.test.rag-embed-above-cap-all-healthy-projection': { line: 'bounded embed results past the cap' },
  'backlog.feat.offrail-roots-evals': { line: '`evals/` added to the off-rail roots' },
  'backlog.feat.fetch-allowlist-grok-bot-docs': { line: '`docs.x.ai` and `cursor.com`' },
  'backlog.feat.shell-bash-allow-gh-run-watch': { line: '`gh run watch <run-id>`' },
  'backlog.chore.archive-prototyping-era-notes': { line: 'prototyping-era context notes were archived' },
};

function sections(lines) {
  // [{ version, headingIndex, body }] where body is the lines strictly between a
  // `## [x.y.z] - date` heading and the next `## [` heading (or EOF)
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

function releasedStories(version) {
  // frontmatter-only: a `releasedIn` mention in a note's prose does not count
  const ids = [];
  for (const name of fs.readdirSync(NOTES_DIR)) {
    if (!name.endsWith('.md')) continue;
    const full = path.join(NOTES_DIR, name);
    if (!fs.statSync(full).isFile()) continue;
    const fm = frontmatterOf(fs.readFileSync(full, 'utf8'));
    if (!fm) continue;
    for (const line of fm) {
      const m = /^releasedIn:\s*["']?([^"'\s]+)["']?\s*$/.exec(line);
      if (m) {
        if (m[1] === version) ids.push(normalizeId(name.slice(0, -'.md'.length)));
        break;
      }
    }
  }
  return ids;
}

const SECTIONS = sections(CHANGELOG);
const SECTION = SECTIONS.find((s) => s.version === VERSION);
const body = () => {
  if (!SECTION) throw new Error(`no CHANGELOG section for ${VERSION}`);
  return SECTION.body;
};
const nonBlank = () => body().filter((l) => l.trim() !== '');

describe('CHANGELOG 0.88.0 heading', () => {
  it('the 0.88.0 heading appears exactly once, is the first release heading, and the next heading is 0.87.0', () => {
    expect(CHANGELOG.filter((l) => l === HEADING)).toHaveLength(1);
    expect(SECTIONS.length).toBeGreaterThan(1);
    expect(CHANGELOG[SECTIONS[0].headingIndex]).toBe(HEADING);
    expect(CHANGELOG[SECTIONS[1].headingIndex]).toBe(NEXT_HEADING);
  });
});

describe('CHANGELOG 0.88.0 body shape', () => {
  it('body starts and ends with exactly one blank line and has content', () => {
    const b = body();
    expect(b.length).toBeGreaterThanOrEqual(3);
    expect(b[0]).toBe('');
    expect(b[1]).not.toBe('');
    expect(b.at(-1)).toBe('');
    expect(b.at(-2)).not.toBe('');
  });

  it('every non-blank body line is a group heading, a bullet, or the restart line', () => {
    const offenders = nonBlank().filter((l) => !GROUP_RE.test(l) && !BULLET_RE.test(l) && l !== RESTART_LINE);
    expect(offenders).toEqual([]);
  });

  it('group headings come from the allowed set, appear at most once each and in order, and each has a bullet', () => {
    const lines = nonBlank();
    const groups = lines.map((l) => GROUP_RE.exec(l)).filter(Boolean).map((m) => m[1]);
    expect(groups.length).toBeGreaterThan(0);
    for (const g of groups) expect(GROUPS, g).toContain(g);
    expect(new Set(groups).size).toBe(groups.length);
    const order = groups.map((g) => GROUPS.indexOf(g));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // the first non-blank line is a group heading, and every group heading is followed by a bullet
    expect(GROUP_RE.test(lines[0])).toBe(true);
    lines.forEach((l, i) => {
      if (GROUP_RE.test(l)) expect(BULLET_RE.test(lines[i + 1] ?? ''), l).toBe(true);
    });
  });

  it('no body line is a conventional-commit subject', () => {
    expect(body().filter((l) => COMMIT_SUBJECT_RE.test(l))).toEqual([]);
  });

  it('no body line names the private contributor in any case', () => {
    expect(body().filter((l) => PRIVATE_NAME_RE.test(l))).toEqual([]);
  });

  it("this test file's own source does not name the private contributor in any case", () => {
    expect(SELF_SOURCE.length).toBeGreaterThan(0);
    expect(SELF_SOURCE.split('\n').filter((l) => PRIVATE_NAME_RE.test(l))).toEqual([]);
  });
});

describe('CHANGELOG 0.88.0 story coverage', () => {
  it('COVERAGE keys equal the stories whose frontmatter releasedIn is 0.88.0', () => {
    const released = releasedStories(VERSION).sort();
    expect(released.length).toBeGreaterThan(0);
    expect(Object.keys(COVERAGE).sort()).toEqual(released);
  });

  it("every covered story's line is in the body and every omission has a reason", () => {
    const lines = nonBlank();
    for (const [id, entry] of Object.entries(COVERAGE)) {
      if ('line' in entry) {
        expect(typeof entry.line, id).toBe('string');
        expect(entry.line.length, id).toBeGreaterThan(0);
        expect(lines.some((l) => BULLET_RE.test(l) && l.includes(entry.line)), `${id}: ${entry.line}`).toBe(true);
      } else {
        expect(typeof entry.omitted, id).toBe('string');
        expect(entry.omitted.trim().length, id).toBeGreaterThan(0);
      }
    }
  });

  it('every bullet line is claimed by at least one COVERAGE entry', () => {
    const claims = Object.values(COVERAGE).filter((e) => 'line' in e).map((e) => e.line);
    const orphans = nonBlank().filter((l) => BULLET_RE.test(l) && !claims.some((c) => l.includes(c)));
    expect(orphans).toEqual([]);
  });
});
