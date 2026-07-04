/**
 * Tests for backlog.fix.pay-down-hotfix-skip-debt (B4-core).
 *
 * Enforces that every unconditional `describe.skip(` and `it.skip(` in tests/
 * is either (a) on the hardcoded allowlist below, or (b) accompanied by a
 * `// skip-debt-tracked-in: <storyId>` comment within 3 lines.
 *
 * RATIONALE: skip flags lose regression coverage silently. Every skip should
 * either be retired (test removed entirely) OR tracked to a story that will
 * resolve it. The meta-test catches drift — a developer can no longer add a
 * `describe.skip` to keep CI green without leaving a paper trail.
 *
 * SCOPE — B4-core only:
 *   This story (B4-core) ships only the meta-test infrastructure with a
 *   comprehensive allowlist of every skip currently on disk. Source code
 *   re-enables are deferred to child stories B4A/B4B/B4C/B4D, one per
 *   root-cause bucket:
 *
 *   - B4A — planner.mjs import overhead (planner-context...live-read)
 *   - B4B — gh CLI subprocess cost in preflight (preflight-rks-version)
 *   - B4C — node CLI cold-start cost (cli-cold-start)
 *   - B4D — git-release subprocess family (git-release.gh-release,
 *           git-release-ff-fail-rollback, git-release.integration,
 *           git-release-publish, + vitest.config.unit.mjs exclude of
 *           git-release.test.mjs)
 *
 *   Pre-existing skips (project-bootstrap, project-registry,
 *   redirect-github-tools-to-governor, etc.) are also allowlisted here as
 *   "B4-followup: pre-existing skip debt". Each will be paid down in time.
 *
 * EXCLUSIONS — what's NOT a skip-debt finding:
 *   - Conditional skips: `.skipIf(<expr>)` is a runtime decision, not silent
 *     debt. The test still represents intent — it just won't run under certain
 *     conditions. Examples: skipIf(!!process.env.CI), skipIf(!hooksLive).
 *   - Variable aliases: `const describeOrSkip = shouldSkip ? describe.skip : describe`
 *     is a callsite-level conditional, not the bare `describe.skip` form.
 *   - Operational `it.skip` blocks with a documenting rationale: these are
 *     allowlisted by file:line below with the rationale "OPERATIONAL: ..."
 *
 * OPT-OUT FORMAT (for new skips post-B4-core):
 *   `// skip-debt-tracked-in: <storyId>` on the line immediately above the
 *   skip call. The storyId must be non-empty.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { globby } from 'globby';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');

// Detect unconditional skip calls: describe.skip( and it.skip(.
// Does NOT match describe.skipIf( or it.skipIf( or describeOrSkip (variable).
const SKIP_RE = /(?<![\w.])(describe|it)\.skip\s*\(/g;

// Allowlist of all currently-present skip-debt items. Each entry:
//   filepath, line, reason
// When a child story pays down a row, the row is REMOVED from this list.
// Adding a NEW entry requires a story reference in the reason.
const ALLOWLIST = [
  // === Bucket A — planner.mjs import overhead (B4A) ===
  { file: 'tests/unit/planner-context.gatherTargetContext.live-read-integration.test.mjs', line: 131, reason: 'B4A: planner.mjs import overhead — Hotfix #7/#9' },

  // === Bucket B — gh CLI subprocess cost in preflight (B4B) ===
  { file: 'tests/unit/preflight-rks-version.test.mjs', line: 27, reason: 'B4B: gh CLI subprocess cost per test — Hotfix #8' },

  // === Bucket C — node CLI cold-start cost (B4C) ===
  { file: 'tests/unit/cli-cold-start.test.mjs', line: 27, reason: 'B4C: node CLI cold-start cost compounded — Hotfix #7/#9' },

  // === Bucket D — git-release subprocess family (B4D) ===
  { file: 'tests/unit/git-release.gh-release.test.mjs', line: 86, reason: 'B4D: git-release subprocess family — predates B4 (pre-existing)' },
  { file: 'tests/unit/git-release-ff-fail-rollback.test.mjs', line: 103, reason: 'B4D: git-release subprocess family — Hotfix #7/#9' },
  { file: 'tests/unit/git-release-publish.test.mjs', line: 70, reason: 'B4D: git-release subprocess family — Hotfix #7/#9' },
  // Tier-2 (backlog.feat.test-suite-tier-2-unit-tier-bloat-audit): git-release.integration
  // moved tests/unit/ → tests/integration/. The describe.skip persists and the
  // B4D follow-up still owns it; the path simply updated to the integration tier.
  { file: 'tests/integration/git-release.integration.test.mjs', line: 50, reason: 'B4D: git-release subprocess family — Hotfix #7/#9 (moved to tests/integration/ by Tier-2)' },

  // === Operational it.skip blocks (documented post-merge verification) ===
  { file: 'tests/unit/ci-sha-guard.test.mjs', line: 327, reason: 'OPERATIONAL: A5 next-ff-merge-skips-unit-tests — verified by human post-merge' },
  { file: 'tests/unit/ci-skips-docs-and-config-commits.test.mjs', line: 214, reason: 'OPERATIONAL: A2 docs/config commits skip CI — verified by human post-merge' },
  { file: 'tests/unit/release-bump-skip-ci.test.mjs', line: 184, reason: 'OPERATIONAL: A1 bump-push to staging skips CI — verified by human post-merge' },
  { file: 'tests/unit/release-bump-skip-ci.test.mjs', line: 191, reason: 'OPERATIONAL: A1 main ff-merge skips CI — verified by human post-merge' },

  // === Pre-existing skips (B4-followup, not motivated by hotfixes) ===
  // The tests/project-bootstrap.test.mjs skips are tracked by inline
  // `// skip-debt-tracked-in: backlog.fix.slow-subprocess-test-pattern` comments
  // instead of file:line allowlist entries — the line-number entries drifted when
  // backlog.feat.template-vitest-config-target edited that file, so they were
  // replaced with comment trackers (immune to line shifts). See
  // notes/research.2026.06.28.uat-findings.md.
  { file: 'tests/integration/project-registry.test.mjs', line: 35, reason: 'B4-followup: pre-existing skip (project registry inspection)' },
  { file: 'tests/unit/redirect-github-tools-to-governor.test.mjs', line: 36, reason: 'B4-followup: pre-existing redirect-github-tools skips' },
  { file: 'tests/unit/redirect-github-tools-to-governor.test.mjs', line: 43, reason: 'B4-followup: pre-existing redirect-github-tools skips' },
  { file: 'tests/unit/redirect-github-tools-to-governor.test.mjs', line: 50, reason: 'B4-followup: pre-existing redirect-github-tools skips' },
  { file: 'tests/unit/redirect-github-tools-to-governor.test.mjs', line: 56, reason: 'B4-followup: pre-existing redirect-github-tools skips' },
  { file: 'tests/unit/redirect-github-tools-to-governor.test.mjs', line: 62, reason: 'B4-followup: pre-existing redirect-github-tools skips' },
      { file: 'tests/unit/redirect-github-tools-to-governor.test.mjs', line: 68, reason: 'B4-followup: pre-existing redirect-github-tools skips' },
      { file: 'tests/unit/research-agent-read-git.test.mjs', line: 28, reason: 'B4-followup: pre-existing skip (research.mjs export)' },
    ];

// Index allowlist by "file:line" for O(1) lookup. Line numbers can drift; the
// hygiene test below flags entries where the line no longer points at a skip.
const ALLOWLIST_INDEX = new Set(ALLOWLIST.map((e) => `${e.file}:${e.line}`));

/**
 * Find unconditional skip calls in a file. Each match is {line, kind} where
 * kind is "describe" or "it".
 * Filters out matches inside string literals and line comments.
 */
function findSkips(src) {
  const lines = src.split('\n');

  // Strip line comments for matching.
  const stripped = lines.map((l) => {
    const idx = l.indexOf('//');
    return idx === -1 ? l : l.slice(0, idx);
  });

  const skips = [];

  for (let i = 0; i < stripped.length; i++) {
    const line = stripped[i];
    const matches = [...line.matchAll(SKIP_RE)];
    for (const m of matches) {
      // Skip matches inside an unclosed string literal on the same line.
      const before = line.slice(0, m.index);
      const dq = (before.match(/"/g) || []).length;
      const sq = (before.match(/'/g) || []).length;
      const bq = (before.match(/`/g) || []).length;
      if (dq % 2 === 1 || sq % 2 === 1 || bq % 2 === 1) continue;

      skips.push({ line: i + 1, kind: m[1] });
    }
  }

  return skips;
}

/**
 * Check whether a skip at file:line has a tracker comment on the line
 * immediately above. (Strict: not 2 or 3 lines up. The tracker must be the
 * comment directly preceding the skip call for the linkage to be obvious to
 * a future reader.)
 */
function hasTrackerComment(lines, skipLine) {
  const trackerRe = /\/\/\s*skip-debt-tracked-in:\s*(\S.*)/;
  // skipLine is 1-based; lines is 0-indexed. Line immediately above is index skipLine-2.
  return trackerRe.test(lines[skipLine - 2] || '');
}

let scanResult = new Map();

beforeAll(async () => {
  const files = await globby(['tests/**/*.test.mjs', 'tests/**/*.test.js'], { cwd: REPO_ROOT });
  for (const f of files.sort()) {
    const src = fs.readFileSync(path.join(REPO_ROOT, f), 'utf8');
    const skips = findSkips(src);
    if (skips.length > 0) scanResult.set(f, { src, skips });
  }
}, 30_000);

describe('skip-debt audit — scan setup', () => {
  it('scan produces a usable result map', () => {
    expect(scanResult).toBeInstanceOf(Map);
  });
});

describe('AC5 — no untracked, unallowlisted skips in tests/', () => {
  it('every describe.skip / it.skip is either allowlisted or carries a // skip-debt-tracked-in: comment', () => {
    const violations = [];
    for (const [file, { src, skips }] of scanResult) {
      const lines = src.split('\n');
      for (const s of skips) {
        const key = `${file}:${s.line}`;
        if (ALLOWLIST_INDEX.has(key)) continue;
        if (hasTrackerComment(lines, s.line)) continue;
        violations.push(`${key} — ${s.kind}.skip — no allowlist entry and no // skip-debt-tracked-in: comment within 3 lines above`);
      }
    }
    expect(
      violations,
      `New untracked skips detected:\n${violations.join('\n')}\n\n` +
        `Either add a // skip-debt-tracked-in: <storyId> comment within 3 lines above the skip call, ` +
        `OR add an entry to ALLOWLIST in tests/unit/skip-debt-audit.test.mjs.`,
    ).toEqual([]);
  });
});

describe('Allowlist hygiene', () => {
  it('every allowlist entry points at a file that exists', () => {
    const stale = [];
    for (const e of ALLOWLIST) {
      if (!fs.existsSync(path.join(REPO_ROOT, e.file))) {
        stale.push(`${e.file} (file does not exist — was the skip removed without removing this allowlist entry?)`);
      }
    }
    expect(stale, `Stale allowlist entries:\n${stale.join('\n')}`).toEqual([]);
  });

  it('every allowlist entry has a non-empty reason', () => {
    for (const e of ALLOWLIST) {
      expect(e.reason.length, `allowlist entry for ${e.file}:${e.line} has empty reason`).toBeGreaterThan(5);
    }
  });

  it('every allowlist entry actually points at a real skip (not stale line numbers)', () => {
    const stale = [];
    for (const e of ALLOWLIST) {
      const fileData = scanResult.get(e.file);
      if (!fileData) {
        stale.push(`${e.file}:${e.line} — file has no skips at all (entry is stale)`);
        continue;
      }
      const matchingSkip = fileData.skips.find((s) => s.line === e.line);
      if (!matchingSkip) {
        const nearby = fileData.skips.map((s) => `${s.line}(${s.kind})`).join(', ');
        stale.push(`${e.file}:${e.line} — no skip at this exact line. Skips in file: [${nearby}]`);
      }
    }
    expect(stale, `Allowlist entries with drifted line numbers:\n${stale.join('\n')}`).toEqual([]);
  });
});

describe('AC2 — git-release.test.mjs has graduated to integration tier', () => {
  // Tier-2 audit (backlog.feat.test-suite-tier-2-unit-tier-bloat-audit): the
  // git-release.test.mjs file moved from tests/unit/ to tests/integration/.
  // The vitest.config.unit.mjs exclude entry was removed in the same commit;
  // the legacy B4-D allowlist entry was likewise dropped. Assert the move took
  // hold so a future regression cannot silently re-create the unit-tier path.
  it('tests/integration/git-release.test.mjs exists on disk', () => {
    const p = path.join(REPO_ROOT, 'tests/integration/git-release.test.mjs');
    expect(fs.existsSync(p), 'tests/integration/git-release.test.mjs missing after Tier-2 move').toBe(true);
  });

  it('tests/unit/git-release.test.mjs no longer exists on disk', () => {
    const p = path.join(REPO_ROOT, 'tests/unit/git-release.test.mjs');
    expect(fs.existsSync(p), 'tests/unit/git-release.test.mjs still present — Tier-2 move incomplete').toBe(false);
  });

  it('vitest.config.unit.mjs no longer references the moved file in its exclude array', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'vitest.config.unit.mjs'), 'utf8');
    expect(src).not.toContain('tests/unit/git-release.test.mjs');
  });
});

describe('Tracker comment format (opt-out for new skips)', () => {
  // Self-test: verify the tracker regex accepts valid forms and rejects invalid ones.
  const fakeSrc = [
    "// skip-debt-tracked-in: backlog.fix.example",
    "describe.skip('valid', () => {});",                    // line 2 — allowed
    "// not-a-tracker-comment",
    "describe.skip('no tracker', () => {});",               // line 4 — should be flagged
    "// skip-debt-tracked-in:",                             // empty storyId
    "it.skip('empty tracker', () => {});",                  // line 6 — should be flagged
  ].join('\n');
  const fakeLines = fakeSrc.split('\n');

  it('accepts tracker with non-empty storyId on the line above', () => {
    expect(hasTrackerComment(fakeLines, 2)).toBe(true);
  });

  it('rejects skip with no tracker comment', () => {
    expect(hasTrackerComment(fakeLines, 4)).toBe(false);
  });

  it('rejects tracker with empty storyId', () => {
    expect(hasTrackerComment(fakeLines, 6)).toBe(false);
  });
});

// AUDIT (2026-06-10, B4-core ship):
//   - 28 total describe.skip / it.skip occurrences across tests/ (excluding skipIf / variable forms)
//   - 7 hotfix-introduced (Buckets A/B/C/D)
//   - 4 operational (documented A1/A2/A5 post-merge checks)
//   - 17 pre-existing (project-bootstrap=8, redirect-github-tools=6, project-registry=1, research-agent-read-git=1, init-telemetry=1)
//   - 1 config exclude (vitest.config.unit.mjs:11 → tests/unit/git-release.test.mjs)
//
//   Follow-up child stories:
//     B4A — planner.mjs import overhead (1 skip)
//     B4B — gh CLI subprocess cost (1 skip)
//     B4C — node CLI cold-start (1 skip)
//     B4D — git-release subprocess family (4 skips + 1 config exclude)
//     B4-followup — pre-existing skips (17 entries, not motivated by hotfixes)
