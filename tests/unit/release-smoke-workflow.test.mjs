/**
 * Tests for backlog.feat.post-release-smoke-verification — workflow YAML
 * structure assertions. These run in the unit tier so the workflow contract
 * is verified on every PR, not only on release-tag pushes.
 *
 * Maps to testRequirements:
 *   - Workflow file structurally valid (AC1)
 *   - Trigger pin: tags v*.*.* only, no branches/PR (AC2)
 *   - Fixture vault structural sanity (AC3)
 *   - Failure-comment endpoint source-grep pin (AC6)
 *   - ci.yml regression check (AC8)
 *   - Documentation present (AC7)
 *   - node scripts/rag/embed.mjs literal pin
 *   - Workflow timeout-minutes <= 15
 *   - ARCH: ROUTEKIT_PROJECT_ROOT set explicitly
 *   - ARCH: ROUTEKIT_RAG_EMBEDDINGS_MODE=model
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const SMOKE_YML_PATH = path.join(REPO_ROOT, '.github/workflows/release-smoke.yml');
const SMOKE_YML_SRC = fs.readFileSync(SMOKE_YML_PATH, 'utf8');
const SMOKE_CONFIG = parseYaml(SMOKE_YML_SRC);

const CI_YML_PATH = path.join(REPO_ROOT, '.github/workflows/ci.yml');
const CI_YML_SRC = fs.readFileSync(CI_YML_PATH, 'utf8');
const CI_CONFIG = parseYaml(CI_YML_SRC);

const FIXTURE_VAULT = path.join(REPO_ROOT, 'tests/integration/fixtures/release-smoke-vault');

describe('AC1 — workflow file structurally valid', () => {
  it('release-smoke.yml exists at .github/workflows/release-smoke.yml', () => {
    expect(fs.existsSync(SMOKE_YML_PATH)).toBe(true);
  });

  it('parses as valid YAML with top-level on and jobs keys', () => {
    expect(SMOKE_CONFIG).toBeDefined();
    expect(SMOKE_CONFIG).toHaveProperty('on');
    expect(SMOKE_CONFIG).toHaveProperty('jobs');
  });

  it('declares a smoke job', () => {
    expect(SMOKE_CONFIG.jobs).toHaveProperty('smoke');
    expect(SMOKE_CONFIG.jobs.smoke).toHaveProperty('runs-on');
  });
});

describe('AC2 — trigger pin: tag push v*.*.* ONLY', () => {
  it('on.push.tags equals ["v*.*.*"]', () => {
    expect(SMOKE_CONFIG.on).toHaveProperty('push');
    expect(SMOKE_CONFIG.on.push).toHaveProperty('tags');
    expect(SMOKE_CONFIG.on.push.tags).toEqual(['v*.*.*']);
  });

  it('on.push.branches is NOT present (would trigger on every push)', () => {
    expect(SMOKE_CONFIG.on.push.branches).toBeUndefined();
  });

  it('on.pull_request is NOT present (would trigger on every PR push)', () => {
    expect(SMOKE_CONFIG.on.pull_request).toBeUndefined();
  });

  it('on.schedule is NOT present (smoke is tag-driven only)', () => {
    expect(SMOKE_CONFIG.on.schedule).toBeUndefined();
  });
});

describe('AC3 — fixture vault structural sanity', () => {
  it('fixture vault directory exists', () => {
    expect(fs.existsSync(FIXTURE_VAULT)).toBe(true);
    expect(fs.statSync(FIXTURE_VAULT).isDirectory()).toBe(true);
  });

  it('fixture vault has a notes/ subdirectory', () => {
    const notesDir = path.join(FIXTURE_VAULT, 'notes');
    expect(fs.existsSync(notesDir)).toBe(true);
    expect(fs.statSync(notesDir).isDirectory()).toBe(true);
  });

  it('notes/ has at least 5 .md files', () => {
    const notesDir = path.join(FIXTURE_VAULT, 'notes');
    const mdFiles = fs.readdirSync(notesDir).filter((f) => f.endsWith('.md'));
    expect(mdFiles.length, 'release-smoke fixture needs >=5 notes to make row-count sanity meaningful').toBeGreaterThanOrEqual(5);
  });

  it('notes/ includes at least one backlog.*.md (content_type=backlog)', () => {
    const notesDir = path.join(FIXTURE_VAULT, 'notes');
    const files = fs.readdirSync(notesDir);
    const backlog = files.filter((f) => /^backlog\.(feat|fix|chore|task)\./.test(f));
    expect(backlog.length).toBeGreaterThanOrEqual(1);
  });

  it('notes/ includes at least one backlog.z_implemented.*.md (content_type=implemented)', () => {
    const notesDir = path.join(FIXTURE_VAULT, 'notes');
    const files = fs.readdirSync(notesDir);
    const implemented = files.filter((f) => f.startsWith('backlog.z_implemented.'));
    expect(implemented.length).toBeGreaterThanOrEqual(1);
  });

  it('notes/ includes at least one generic note prefix (research/canon/how-to/scratch) for content_type=note', () => {
    const notesDir = path.join(FIXTURE_VAULT, 'notes');
    const files = fs.readdirSync(notesDir);
    const notes = files.filter((f) => /^(research|canon|how-to|scratch)\./.test(f));
    expect(notes.length).toBeGreaterThanOrEqual(1);
  });

  it('fixture vault has at least one source file for content_type=code', () => {
    const candidates = [
      path.join(FIXTURE_VAULT, 'src'),
      path.join(FIXTURE_VAULT, 'scripts'),
      path.join(FIXTURE_VAULT, 'packages'),
    ];
    const anyHasCode = candidates.some((dir) => {
      if (!fs.existsSync(dir)) return false;
      return fs
        .readdirSync(dir)
        .some((f) => /\.(mjs|js|ts|cjs)$/.test(f));
    });
    expect(anyHasCode, 'release-smoke fixture needs at least one .mjs/.js/.ts file under src/, scripts/, or packages/ for content_type=code').toBe(true);
  });

  it('fixture vault has .rks/project.json so embed.mjs can resolve project metadata', () => {
    expect(fs.existsSync(path.join(FIXTURE_VAULT, '.rks/project.json'))).toBe(true);
  });
});

describe('AC6 — failure-comment posts to commit (gh api repos/.../commits/{sha}/comments)', () => {
  it('workflow YAML source contains the gh-api commit-comments endpoint literal', () => {
    // Pin BOTH the gh CLI form AND the API path so a refactor to actions/github-script
    // is forced to update this test. Per ARCH: AC6 must specifically post to
    // commits/{sha}/comments, not to release notes or an issue.
    const hasGhCli = SMOKE_YML_SRC.includes('gh api') && SMOKE_YML_SRC.includes('commits/');
    const hasGithubScriptForm = SMOKE_YML_SRC.includes('createCommitComment');
    expect(hasGhCli || hasGithubScriptForm, 'release-smoke.yml must post to the commit-comments endpoint via either gh api repos/.../commits/{sha}/comments or actions/github-script createCommitComment').toBe(true);
  });

  it('the failure-comment step is gated by `if: failure()`', () => {
    expect(SMOKE_YML_SRC).toMatch(/if:\s*failure\(\)/);
  });

  it('endpoint path contains the {sha} placeholder, not a hardcoded SHA', () => {
    // Multiple `commits/<x>/comments` substrings appear in the YAML (one in a
    // doc comment, one in the actual gh api call). Find ALL matches; at least
    // one must be a substituted form (TAG_SHA, github.sha, etc.) — not a
    // hardcoded 40-hex SHA.
    const matches = [...SMOKE_YML_SRC.matchAll(/commits\/([^/'"`\s]+)\/comments/g)];
    expect(matches.length).toBeGreaterThan(0);
    const captures = matches.map((m) => m[1]);
    // None may be a hardcoded SHA.
    for (const c of captures) {
      expect(c, `commits/<x>/comments saw hardcoded SHA: ${c}`).not.toMatch(/^[0-9a-f]{40}$/);
    }
    // At least one must use templating ($ or {{ }} form).
    const hasTemplated = captures.some((c) => /\$|\{\{|sha/i.test(c));
    expect(hasTemplated, 'release-smoke.yml must substitute the SHA — saw only literal placeholders').toBe(true);
  });
});

describe('AC7 — documentation present', () => {
  it('notes/how-to.release-smoke-verification.md exists', () => {
    const docPath = path.join(REPO_ROOT, 'notes/how-to.release-smoke-verification.md');
    expect(fs.existsSync(docPath)).toBe(true);
  });

  it('how-to references the workflow file path and the fixture vault path', () => {
    const docPath = path.join(REPO_ROOT, 'notes/how-to.release-smoke-verification.md');
    const src = fs.readFileSync(docPath, 'utf8');
    expect(src).toContain('.github/workflows/release-smoke.yml');
    expect(src).toContain('tests/integration/fixtures/release-smoke-vault');
  });
});

describe('AC8 — ci.yml unchanged by this story', () => {
  it('ci.yml still triggers on push and pull_request to main/staging', () => {
    expect(CI_CONFIG.on.push.branches).toContain('main');
    expect(CI_CONFIG.on.push.branches).toContain('staging');
    expect(CI_CONFIG.on.pull_request.branches).toContain('main');
    expect(CI_CONFIG.on.pull_request.branches).toContain('staging');
  });

  it('ci.yml has no tags filter (release-smoke owns tag pushes)', () => {
    expect(CI_CONFIG.on.push.tags).toBeUndefined();
  });
});

describe('Production embed reuse — workflow invokes scripts/rag/embed.mjs (not a duplicate)', () => {
  it('workflow YAML contains the literal `node scripts/rag/embed.mjs`', () => {
    expect(SMOKE_YML_SRC).toContain('node scripts/rag/embed.mjs');
  });
});

describe('ARCH-pinned env wiring', () => {
  it('jobs.smoke.env.ROUTEKIT_PROJECT_ROOT is set explicitly to the fixture vault path', () => {
    const env = SMOKE_CONFIG.jobs.smoke.env;
    expect(env).toBeDefined();
    expect(env).toHaveProperty('ROUTEKIT_PROJECT_ROOT');
    // Must include the fixture-vault path; the github.workspace prefix lands as a templated expression.
    expect(env.ROUTEKIT_PROJECT_ROOT).toContain('tests/integration/fixtures/release-smoke-vault');
  });

  it('jobs.smoke.env.ROUTEKIT_RAG_EMBEDDINGS_MODE = "model" (production parity)', () => {
    const env = SMOKE_CONFIG.jobs.smoke.env;
    expect(env).toHaveProperty('ROUTEKIT_RAG_EMBEDDINGS_MODE');
    expect(env.ROUTEKIT_RAG_EMBEDDINGS_MODE).toBe('model');
  });

  it('jobs.smoke.env.RKS_RELEASE_SMOKE_REQUIRE_DB = "1" (forces hard-fail in workflow context)', () => {
    // The integration test self-skips when the fixture LanceDB is absent so the
    // regular test:mock CI integration suite passes (it doesn't run embed first).
    // The release-smoke workflow DOES run embed first, so it MUST go red if for
    // any reason the DB is still missing — RKS_RELEASE_SMOKE_REQUIRE_DB=1 forces
    // that hard-fail and prevents a silently-empty embed from green-lighting a
    // release.
    const env = SMOKE_CONFIG.jobs.smoke.env;
    expect(env).toHaveProperty('RKS_RELEASE_SMOKE_REQUIRE_DB');
    expect(String(env.RKS_RELEASE_SMOKE_REQUIRE_DB)).toBe('1');
  });
});

describe('Self-skip wiring in tests/integration/release-smoke.workflow.test.mjs (regression guard)', () => {
  const SMOKE_TEST_PATH = path.join(REPO_ROOT, 'tests/integration/release-smoke.workflow.test.mjs');
  const SMOKE_TEST_SRC = fs.readFileSync(SMOKE_TEST_PATH, 'utf8');

  it('integration test exists', () => {
    expect(fs.existsSync(SMOKE_TEST_PATH)).toBe(true);
  });

  it('integration test source references RKS_RELEASE_SMOKE_REQUIRE_DB env var', () => {
    // The skip-unless-required guard MUST check this env var, or the workflow's
    // safety net (env: RKS_RELEASE_SMOKE_REQUIRE_DB=1) is useless.
    expect(SMOKE_TEST_SRC).toContain('RKS_RELEASE_SMOKE_REQUIRE_DB');
  });

  it('integration test uses describe.skip (or describeOrSkip variant) to skip cleanly', () => {
    // Pin the skip mechanism — either describe.skip, .skipIf, or a describeOrSkip
    // alias must appear in source. A bare `if (!dbExists) return;` at top-level
    // is NOT sufficient because vitest still reports zero tests, which the
    // integration suite might consider a failure.
    const hasSkipForm =
      /describe\.skip\b/.test(SMOKE_TEST_SRC) ||
      /describe\.skipIf\b/.test(SMOKE_TEST_SRC) ||
      /describeOrSkip\b/.test(SMOKE_TEST_SRC);
    expect(hasSkipForm, 'integration test must use describe.skip / describe.skipIf / describeOrSkip').toBe(true);
  });
});

describe('Workflow timeout cap (ARCH ask)', () => {
  it('jobs.smoke.timeout-minutes <= 15', () => {
    const t = SMOKE_CONFIG.jobs.smoke['timeout-minutes'];
    expect(t).toBeDefined();
    expect(typeof t).toBe('number');
    expect(t).toBeLessThanOrEqual(15);
  });
});

// Subprocess timeout rule: N/A — this file parses YAML and reads markdown,
// no spawn calls. The integration test (tests/integration/release-smoke.workflow.test.mjs)
// carries the 120_000ms beforeAll timeout per ARCH's testReq 12.
