/**
 * Tests for backlog.fix.ci-skips-release-bump-commits.
 *
 * Pin: rks_release's version-bump commit message includes `[skip ci]` AND
 * .github/workflows/ci.yml has paths-ignore for the bump-only file set
 * (package.json, CHANGELOG.md, notes/research.public.**). Together these
 * eliminate the 2-3 redundant ~50min CI runs we paid per release on
 * identical content.
 *
 * AC1, AC6: source-grep pin for `[skip ci]` in git-release.mjs
 * AC2: ci.yml paths-ignore presence + membership (workflow YAML structure)
 * AC3, AC4: bump-only-skips + bump+other-files-runs (negation/positive sanity)
 * AC5: check-hooks-drift.yml unchanged (paths-based trigger)
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const GIT_RELEASE_SRC = fs.readFileSync(
  path.join(REPO_ROOT, 'packages/mcp-rks/src/server/git/git-release.mjs'),
  'utf8',
);
const CI_YML = fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8');
const CI_CONFIG = parseYaml(CI_YML);

describe('Source-grep pins: AC1 + AC6 — [skip ci] in rks_release bump commit', () => {
  it('git-release.mjs contains the literal `[skip ci]` substring', () => {
    expect(GIT_RELEASE_SRC).toContain('[skip ci]');
  });

  it('the `[skip ci]` literal is passed as a -m argument to the version-bump commit', () => {
    // Pin the specific structure: a spawnSync git commit call with two -m flags,
    // the second being the literal "[skip ci]". This guards against accidental
    // removal during refactors. Anchored on the stable `pkg.version = newVersion`
    // bump marker (not the exact `git add` arg list, which lockstep-bump made dynamic).
    const bumpCommitBlock = GIT_RELEASE_SRC.slice(
      GIT_RELEASE_SRC.indexOf('pkg.version = newVersion'),
      GIT_RELEASE_SRC.indexOf('Failed to commit version bump'),
    );
    expect(bumpCommitBlock).toMatch(/spawnSync\("git",\s*\["commit"/);
    expect(bumpCommitBlock).toMatch(/"-m",\s*"\[skip ci\]"/);
  });

  it('the bump commit subject remains `chore(release): X.Y.Z` (idempotence checks depend on it)', () => {
    // git-release.mjs has three places that compare the subject via
    // `git log --format=%s` to `chore(release): ${newVersion}`. The
    // [skip ci] addition MUST be in the body (second -m), not embedded in
    // the subject — otherwise the idempotence checks at lines ~218, 255, 272
    // would silently break and rks_release would re-commit on retry.
    expect(GIT_RELEASE_SRC).toMatch(/`chore\(release\): \$\{newVersion\}`/);
    const subjectMatches = GIT_RELEASE_SRC.match(/`chore\(release\): \$\{newVersion\}`/g) || [];
    expect(subjectMatches.length).toBeGreaterThanOrEqual(3);
  });
});

describe('CI workflow YAML structure: AC2 — paths-ignore filter present and well-formed', () => {
  it('on.push has a paths-ignore array', () => {
    const pushFilter = CI_CONFIG?.on?.push ?? CI_CONFIG?.on?.['push'];
    expect(pushFilter).toBeDefined();
    expect(Array.isArray(pushFilter['paths-ignore'])).toBe(true);
    expect(pushFilter['paths-ignore'].length).toBeGreaterThan(0);
  });

  it('on.push.paths-ignore includes package.json', () => {
    expect(CI_CONFIG.on.push['paths-ignore']).toContain('package.json');
  });

  it('on.push.paths-ignore includes CHANGELOG.md', () => {
    expect(CI_CONFIG.on.push['paths-ignore']).toContain('CHANGELOG.md');
  });

  it('on.push.paths-ignore includes notes/research.public.** glob', () => {
    expect(CI_CONFIG.on.push['paths-ignore']).toContain('notes/research.public.**');
  });

  it('pull_request also has matching paths-ignore (symmetry — PRs of the same content should skip too)', () => {
    const prFilter = CI_CONFIG?.on?.pull_request ?? CI_CONFIG?.on?.['pull_request'];
    expect(prFilter).toBeDefined();
    expect(Array.isArray(prFilter['paths-ignore'])).toBe(true);
    expect(prFilter['paths-ignore']).toContain('package.json');
    expect(prFilter['paths-ignore']).toContain('CHANGELOG.md');
    expect(prFilter['paths-ignore']).toContain('notes/research.public.**');
  });

  it('on.push.branches still includes main and staging (the only trigger surface change is paths-ignore)', () => {
    expect(CI_CONFIG.on.push.branches).toContain('main');
    expect(CI_CONFIG.on.push.branches).toContain('staging');
  });

  it('workflow_dispatch and schedule triggers preserved (not accidentally removed)', () => {
    expect(CI_CONFIG.on).toHaveProperty('workflow_dispatch');
    expect(CI_CONFIG.on).toHaveProperty('schedule');
  });
});

describe('Path-filter negation sanity: AC3 + AC4', () => {
  // GitHub Actions paths-ignore is an "ignore if ALL changed files match" filter.
  // A commit that touches ONLY paths-ignore'd files skips the workflow.
  // A commit that touches paths-ignore'd files AND at least one other file runs the workflow.
  //
  // We can't run real GitHub Actions in a unit test, but we can verify the filter
  // is structured correctly such that the matching logic produces the right outcome
  // for representative commit shapes.

  const IGNORE_PATTERNS = CI_CONFIG.on.push['paths-ignore'];

  function matchesIgnore(filePath) {
    return IGNORE_PATTERNS.some((pattern) => {
      // Convert minimatch-style glob to a simple regex for testing.
      // GitHub Actions uses minimatch with `**` = anything including /, `*` = anything except /.
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

  it('bump-only commit (package.json only) is fully ignore-matched → CI skips', () => {
    expect(allFilesIgnored(['package.json'])).toBe(true);
  });

  it('bump-only commit (package.json + CHANGELOG.md) is fully ignore-matched → CI skips', () => {
    expect(allFilesIgnored(['package.json', 'CHANGELOG.md'])).toBe(true);
  });

  it('bump-only commit including a notes/research.public.* file → CI skips', () => {
    expect(allFilesIgnored(['package.json', 'CHANGELOG.md', 'notes/research.public.2026.06.foo.md'])).toBe(true);
  });

  it('bump+code commit (package.json + src code change) → CI runs', () => {
    expect(allFilesIgnored(['package.json', 'packages/mcp-rks/src/foo.mjs'])).toBe(false);
  });

  it('bump+test commit (CHANGELOG.md + a test file) → CI runs', () => {
    expect(allFilesIgnored(['CHANGELOG.md', 'tests/unit/foo.test.mjs'])).toBe(false);
  });

  it('code-only commit → CI runs', () => {
    expect(allFilesIgnored(['packages/mcp-rks/src/server/foo.mjs'])).toBe(false);
  });
});

describe('AC5 — check-hooks-drift workflow trigger unchanged', () => {
  const checkHooksDriftPath = path.join(REPO_ROOT, '.github/workflows/check-hooks-drift.yml');

  it('check-hooks-drift.yml exists', () => {
    expect(fs.existsSync(checkHooksDriftPath)).toBe(true);
  });

  it('check-hooks-drift.yml triggers on paths under packages/hooks/** or .routekit/hooks/** (not on tag push)', () => {
    // The QA pass corrected the original brief: check-hooks-drift.yml uses a
    // paths-based push trigger, not a tag push trigger. Pin the actual structure
    // so a future edit doesn't accidentally drop it.
    const driftYml = fs.readFileSync(checkHooksDriftPath, 'utf8');
    const driftConfig = parseYaml(driftYml);
    const pushFilter = driftConfig?.on?.push ?? driftConfig?.on?.['push'];
    expect(pushFilter).toBeDefined();
    expect(Array.isArray(pushFilter.paths)).toBe(true);
    const hasHooksPath = pushFilter.paths.some((p) =>
      p === 'packages/hooks/**' || p === '.routekit/hooks/**' || p.startsWith('packages/hooks/') || p.startsWith('.routekit/hooks/'),
    );
    expect(hasHooksPath).toBe(true);
  });
});

describe('AC3 + AC4 — operational verification (post-merge, human-observed)', () => {
  // These ACs are functionally about observing GitHub Actions behavior after
  // the next release. They are not directly testable as unit code without an
  // end-to-end harness against the real GitHub Actions runner. Documented here
  // so anyone reading the test file knows where the gap is.
  it.skip('OPERATIONAL: next release after this story ships should NOT trigger CI on staging-bump-push', () => {
    // Verification: after rks_release v0.20.16+ runs, observe GH Actions logs.
    // The chore(release): 0.20.16 commit's push to staging should NOT trigger
    // a new workflow run (the [skip ci] in the body + the paths-ignore should
    // BOTH cause the runner to skip).
  });

  it.skip('OPERATIONAL: next release main ff-merge should NOT trigger CI', () => {
    // Same content as the staging bump (the ff-merge is a pointer move), same
    // skip behavior expected.
  });
});
