/**
 * Tests for backlog.fix.ci-skips-docs-and-config-only-commits.
 *
 * Sibling of Story A1 (backlog.fix.ci-skips-release-bump-commits). A1 added
 * paths-ignore for the version-bump commit case (package.json, CHANGELOG.md,
 * notes/research.public.**). A2 (this story) extends the filter to cover
 * docs-only writes by PO/QA/ARCH (notes/backlog.**, notes/research.**, etc.)
 * and meta/config tweaks (.rks/project.json, .rks/active-scope.json).
 *
 * Without A2, every PO/QA/ARCH cycle in chunks B-F would trigger a ~50min CI
 * run from frontmatter writes with zero signal value — ~30-40 redundant
 * cycles across the remaining backlog work.
 *
 * AC1, AC2: paths-ignore array membership on on.push and on.pull_request
 * AC3: A1's existing entries preserved
 * AC4: path-filter negation sanity (commits with only ignored paths skip; mixed commits run)
 * AC6: other workflow files unchanged
 * AC7: workflow_dispatch and schedule triggers preserved
 *
 * AC5 is operational (post-merge GH Actions observation) — documented as it.skip below.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const CI_YML_PATH = path.join(REPO_ROOT, '.github/workflows/ci.yml');
const CI_YML = fs.readFileSync(CI_YML_PATH, 'utf8');
const CI_CONFIG = parseYaml(CI_YML);

const A2_NEW_ENTRIES = [
  'notes/backlog.**',
  'notes/research.**',
  'notes/canon.**',
  'notes/how-to.**',
  'notes/scratch.**',
  '.rks/project.json',
  '.rks/active-scope.json',
];

const A1_PRESERVED_ENTRIES = [
  'package.json',
  'CHANGELOG.md',
  'notes/research.public.**',
];

describe('AC1 — on.push.paths-ignore includes all A2 docs/config entries', () => {
  for (const entry of A2_NEW_ENTRIES) {
    it(`on.push.paths-ignore contains '${entry}'`, () => {
      expect(CI_CONFIG.on.push['paths-ignore']).toContain(entry);
    });
  }
});

describe('AC2 — on.pull_request.paths-ignore mirrors on.push (symmetry)', () => {
  for (const entry of A2_NEW_ENTRIES) {
    it(`on.pull_request.paths-ignore contains '${entry}'`, () => {
      expect(CI_CONFIG.on.pull_request['paths-ignore']).toContain(entry);
    });
  }
});

describe('AC3 — Story A1 entries preserved (no regression)', () => {
  for (const entry of A1_PRESERVED_ENTRIES) {
    it(`on.push.paths-ignore still contains A1 entry '${entry}'`, () => {
      expect(CI_CONFIG.on.push['paths-ignore']).toContain(entry);
    });
    it(`on.pull_request.paths-ignore still contains A1 entry '${entry}'`, () => {
      expect(CI_CONFIG.on.pull_request['paths-ignore']).toContain(entry);
    });
  }
});

describe('AC4 — path-filter negation sanity', () => {
  // Replicate GitHub Actions paths-ignore behavior: a commit is ignored
  // when ALL changed files match at least one ignore pattern.
  const IGNORE_PATTERNS = CI_CONFIG.on.push['paths-ignore'];

  function matchesIgnore(filePath) {
    return IGNORE_PATTERNS.some((pattern) => {
      // Minimatch-style: `**` = anything including `/`, `*` = anything except `/`.
      const re = new RegExp(
        '^' +
          pattern
            .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
            .replace(/\*\*/g, '___DOUBLESTAR___')
            .replace(/\*/g, '[^/]*')
            .replace(/___DOUBLESTAR___/g, '.*') +
          '$',
      );
      return re.test(filePath);
    });
  }

  function allFilesIgnored(files) {
    return files.length > 0 && files.every(matchesIgnore);
  }

  it('commit touching ONLY notes/backlog.foo.md → CI skips', () => {
    expect(allFilesIgnored(['notes/backlog.foo.md'])).toBe(true);
  });

  it('commit touching notes/backlog.foo.md + packages/mcp-rks/src/bar.mjs → CI runs', () => {
    expect(allFilesIgnored(['notes/backlog.foo.md', 'packages/mcp-rks/src/bar.mjs'])).toBe(false);
  });

  it('commit touching ONLY .rks/project.json → CI skips', () => {
    expect(allFilesIgnored(['.rks/project.json'])).toBe(true);
  });

  it('commit touching .rks/project.json + tests/unit/baz.test.mjs → CI runs', () => {
    expect(allFilesIgnored(['.rks/project.json', 'tests/unit/baz.test.mjs'])).toBe(false);
  });

  it('commit touching notes/canon.foo.md + notes/scratch.bar.md → CI skips (mixed docs-only)', () => {
    expect(allFilesIgnored(['notes/canon.foo.md', 'notes/scratch.bar.md'])).toBe(true);
  });

  it('commit touching notes/backlog.foo.md + scripts/rag/embed.mjs → CI runs', () => {
    expect(allFilesIgnored(['notes/backlog.foo.md', 'scripts/rag/embed.mjs'])).toBe(false);
  });

  it('commit touching notes/research.foo.md (without .public) → CI skips', () => {
    expect(allFilesIgnored(['notes/research.2026.06.foo.md'])).toBe(true);
  });

  it('commit touching notes/how-to.update-fixtures.md → CI skips', () => {
    expect(allFilesIgnored(['notes/how-to.update-fixtures.md'])).toBe(true);
  });

  it('commit touching notes/backlog.foo.md + .github/workflows/ci.yml → CI runs (workflow edits must always be verified)', () => {
    expect(allFilesIgnored(['notes/backlog.foo.md', '.github/workflows/ci.yml'])).toBe(false);
  });
});

describe('AC6 — other workflow files unchanged by this story', () => {
  // ARCH's ask: pin via literal-string snapshot of trigger-config substrings,
  // not deep-equal of full YAML (would false-positive on benign reformatting).
  const checkHooksDriftPath = path.join(REPO_ROOT, '.github/workflows/check-hooks-drift.yml');

  it('check-hooks-drift.yml exists', () => {
    expect(fs.existsSync(checkHooksDriftPath)).toBe(true);
  });

  it('check-hooks-drift.yml trigger config (paths-based) is unchanged', () => {
    const src = fs.readFileSync(checkHooksDriftPath, 'utf8');
    // The trigger is paths-based; pin that the literal `paths:` block exists with
    // hooks-relevant entries. A future story that wants to alter this workflow
    // MUST update this assertion intentionally.
    expect(src).toMatch(/^on:/m);
    expect(src).toMatch(/push:/);
    // At least one of the hooks paths must still be present.
    const hooksPathPresent = /packages\/hooks\//.test(src) || /\.routekit\/hooks\//.test(src);
    expect(hooksPathPresent).toBe(true);
  });
});

describe('AC7 — workflow_dispatch and schedule triggers preserved', () => {
  it('on has workflow_dispatch trigger', () => {
    expect(CI_CONFIG.on).toHaveProperty('workflow_dispatch');
  });

  it('on has schedule trigger', () => {
    expect(CI_CONFIG.on).toHaveProperty('schedule');
  });

  it('schedule cron is preserved', () => {
    // Pin that the daily schedule didn't accidentally get removed.
    expect(Array.isArray(CI_CONFIG.on.schedule)).toBe(true);
    expect(CI_CONFIG.on.schedule.length).toBeGreaterThan(0);
    expect(CI_CONFIG.on.schedule[0]).toHaveProperty('cron');
  });

  it('on.push.branches still includes main and staging (paths-ignore is the only trigger surface change)', () => {
    expect(CI_CONFIG.on.push.branches).toContain('main');
    expect(CI_CONFIG.on.push.branches).toContain('staging');
  });
});

describe('Story A1 regression guard (do not break A1)', () => {
  it("git-release.mjs still contains the literal '[skip ci]' substring from A1", () => {
    const gitReleaseSrc = fs.readFileSync(
      path.join(REPO_ROOT, 'packages/mcp-rks/src/server/git/git-release.mjs'),
      'utf8',
    );
    expect(gitReleaseSrc).toContain('[skip ci]');
  });
});

describe('No duplicate entries in paths-ignore arrays', () => {
  // ARCH probe 3 + defensive: paths-ignore is order-independent in matching,
  // but duplicate entries waste maintenance. Catch accidental copy-paste during
  // edits via Set-size comparison.
  it('on.push.paths-ignore has no duplicates', () => {
    const arr = CI_CONFIG.on.push['paths-ignore'];
    expect(new Set(arr).size).toBe(arr.length);
  });

  it('on.pull_request.paths-ignore has no duplicates', () => {
    const arr = CI_CONFIG.on.pull_request['paths-ignore'];
    expect(new Set(arr).size).toBe(arr.length);
  });
});

describe('AC5 — operational verification (post-merge, human-observed)', () => {
  // This is intentionally `it.skip` — there is no in-suite way to assert that
  // the next PO/QA/ARCH cycle skips CI on its dendron_update_field auto-commits.
  // The verification surface is the GitHub Actions UI after the next chunk's
  // PO+QA+ARCH cycle runs. If you see CI runs triggered by docs(backlog)
  // commits on notes/backlog.*.md AFTER this story ships, this story regressed.
  it.skip('OPERATIONAL: post-merge, PO/QA/ARCH dendron writes to notes/backlog.*.md do NOT trigger CI', () => {
    // Verification: open https://github.com/<owner>/<repo>/actions after the
    // first PO/QA/ARCH cycle that runs against the version of ci.yml shipped
    // by this story. Commits with `docs(backlog):` subjects touching only
    // notes/backlog.*.md should show NO new workflow run.
  });
});

// Subprocess timeout rule: N/A — no spawnSync/exec calls in this test file.
// (Pinned per QA's standard subprocess-timeout testReq to document why.)
