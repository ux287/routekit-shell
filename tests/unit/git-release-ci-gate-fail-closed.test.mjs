/**
 * backlog.fix.release-preflight-fails-open
 *
 * THE DEFECT: the CI gate in runRelease() sat inside `if (ciCheck.status === 0)`
 * with no `else`, and its parse inside a catch that proceeded. A red result WAS
 * gated when reached — the defect was REACHABILITY. Any failure to obtain a
 * verdict fell through to the version bump and the ff-merge.
 *
 * THIS HAPPENED. On 2026-08-17 the local `gh` returned HTTP 404 while staging CI
 * was red (run 32008434128, job `unit-tests (2)`, exit code 1). rks_release
 * returned ok:true and cut v0.39.0 onto `main`.
 *
 * WHY EVERY CASE ASSERTS A LEDGER AND NOT JUST `ok: false`: for a reachability
 * defect a blocking verdict is not the property under test — the gate can return
 * false while the release proceeds anyway. Each blocking case asserts NO mutation
 * was attempted. Those absence assertions would pass vacuously if the harness
 * stopped driving runRelease, so the ordinary-release case asserts the same
 * ledger DOES record a mutation when a release is permitted.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import { ensureTelemetryStorage } from '@routekit/telemetry';

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, spawnSync: vi.fn(() => ({ stdout: '', stderr: '', status: 0 })) };
});

vi.mock('../../packages/mcp-rks/src/server/git/git-utils.mjs', () => ({
  runGit: vi.fn(),
  getCurrentBranch: vi.fn(() => 'staging'),
  isProductionBranch: vi.fn(() => false),
}));

vi.mock('../../packages/mcp-rks/src/server/guardrails-audit.mjs', () => ({
  isGuardrailsOffSession: vi.fn(() => true),
}));

const { spawnSync } = await import('child_process');
const { runGit } = await import('../../packages/mcp-rks/src/server/git/git-utils.mjs');
const { runRelease, evaluateCiGate } = await import('../../packages/mcp-rks/src/server/git/git-release.mjs');

const FAKE_ROOT = '/tmp/fake-project-ci-gate';
const HEAD_SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OLD_SHA = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

let ledger;

function ghRuns(runs) {
  return { stdout: JSON.stringify(runs), stderr: '', status: 0 };
}

// backlog.feat.release-skip-stale-ci — a run only counts when it is the CI workflow's run for a
// candidate commit, so the default fixture carries that identity.
const CI_RUN = (over = {}) => ({
  databaseId: 1, url: 'u', status: 'completed', conclusion: 'success', headSha: HEAD_SHA,
  createdAt: '2026-09-29T00:00:00Z', workflowName: 'CI', event: 'push', ...over,
});

function installSpawn({ gh, diff, remote, ancestry } = {}) {
  spawnSync.mockImplementation((cmd, args) => {
    ledger.push({ cmd, args: args || [] });
    if (cmd === 'git' && args[0] === 'remote') {
      return remote || { stdout: 'origin\thttps://github.com/ux287/routekit-shell-core.git (fetch)\n', stderr: '', status: 0 };
    }
    if (cmd === 'git' && args[0] === 'status') return { stdout: '', stderr: '', status: 0 };
    if (cmd === 'git' && args[0] === 'rev-list' && args.includes('--left-right')) {
      return { stdout: '0\t0', stderr: '', status: 0 };
    }
    if (cmd === 'git' && args[0] === 'rev-list' && args.includes('--first-parent')) {
      return { stdout: (ancestry || [HEAD_SHA]).join('\n') + '\n', stderr: '', status: 0 };
    }
    if (cmd === 'git' && args[0] === 'diff' && args.includes('--name-only')) {
      return diff || { stdout: '', stderr: '', status: 0 };
    }
    if (cmd === 'gh' && args[0] === 'run') {
      if (typeof gh === 'function') return gh(args);
      return gh || ghRuns([CI_RUN()]);
    }
    return { stdout: '', stderr: '', status: 0 };
  });
}

/** Structured, not string-flattened — the ledger records cmd and argv separately. */
function mutated() {
  const isGit = (c, verb) => c.cmd === 'git' && c.args[0] === verb;
  return {
    committed: ledger.some(c => isGit(c, 'commit') && c.args.some(a => String(a).includes('chore(release)'))),
    merged: ledger.some(c => isGit(c, 'merge') && c.args.includes('--ff-only')),
    tagged: ledger.some(c => isGit(c, 'tag')),
    pushed: ledger.some(c => isGit(c, 'push')),
  };
}

function expectNoMutation() {
  const m = mutated();
  expect(m.committed, 'a blocked release must not create the bump commit').toBe(false);
  expect(m.merged, 'a blocked release must not ff-merge').toBe(false);
  expect(m.tagged, 'a blocked release must not tag').toBe(false);
  expect(m.pushed, 'a blocked release must not publish').toBe(false);
}

beforeEach(() => {
  vi.clearAllMocks();
  ledger = [];
  fs.mkdirSync(FAKE_ROOT, { recursive: true });
  fs.mkdirSync(`${FAKE_ROOT}/notes`, { recursive: true });
  fs.writeFileSync(`${FAKE_ROOT}/package.json`, JSON.stringify({ name: 't', version: '1.0.0' }, null, 2));
  // All refs resolve to the same sha and merge-bases agree, so every check
  // AFTER the CI gate passes cleanly. This test file is about the gate; a
  // fixture that trips a later guard would prove nothing either way.
  runGit.mockImplementation((root, args) => {
    if (args[0] === 'rev-parse') return HEAD_SHA;
    if (args[0] === 'merge-base') return HEAD_SHA;
    if (args[0] === 'branch') return 'staging';
    if (args[0] === 'tag') return '';
    if (args[0] === 'log') return '';
    return '';
  });
  installSpawn();
});

const release = () => runRelease({ projectRoot: FAKE_ROOT, version: 'patch', projectId: 'test' });

describe('the gate FAILS CLOSED — five reachability holes, one fixture each', () => {
  it('HOLE 1 — gh exits non-zero (the 404 that shipped v0.39.0)', async () => {
    installSpawn({ gh: { stdout: '', stderr: 'HTTP 404: Not Found', status: 1 } });
    const r = await release();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/could not determine ci status/i);
    expectNoMutation();
  });

  it('HOLE 2 — gh times out (status null, not merely non-zero)', async () => {
    installSpawn({ gh: { stdout: '', stderr: '', status: null } });
    const r = await release();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/could not determine ci status/i);
    expectNoMutation();
  });

  it('HOLE 3 — gh returns unparseable output', async () => {
    installSpawn({ gh: { stdout: 'not json at all', stderr: '', status: 0 } });
    const r = await release();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/could not parse ci status/i);
    expectNoMutation();
  });

  it('HOLE 4 — no CI-workflow run exists for any candidate', async () => {
    installSpawn({ gh: ghRuns([]) });
    const r = await release();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no ci-workflow run was found/i);
    expectNoMutation();
  });

  it('HOLE 5 — the only green run is for an OLDER commit and real code changed since', async () => {
    // Candidate model: OLD_SHA is not a candidate because its diff to HEAD is CI-relevant,
    // so its green run can never decide the verdict.
    installSpawn({
      ancestry: [HEAD_SHA, OLD_SHA],
      diff: { stdout: 'packages/mcp-rks/src/server/exec.mjs\n', stderr: '', status: 0 },
      gh: (args) => ghRuns(args[args.indexOf('--commit') + 1] === OLD_SHA ? [CI_RUN({ headSha: OLD_SHA })] : []),
    });
    const r = await release();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no ci-workflow run was found/i);
    expectNoMutation();
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// backlog.feat.release-skip-stale-ci — the CANDIDATE MODEL, driven directly.
// A commit is a candidate when it is HEAD, or a first-parent ancestor that differs from HEAD only
// on CI-ignored paths. The first candidate (newest first) with a CI-workflow run decides.
// ─────────────────────────────────────────────────────────────────────────────────────────────
const P1 = 'cccccccccccccccccccccccccccccccccccccccc';
const P2 = 'dddddddddddddddddddddddddddddddddddddddd';
const GH_REMOTE = { stdout: 'origin\thttps://github.com/ux287/routekit-shell-core.git (fetch)\n', stderr: '', status: 0 };

/**
 * @param {object} o
 * @param {string[]} [o.ancestry] first-parent shas from HEAD
 * @param {Record<string,string|object>} [o.diffs] sha -> `git diff --name-only sha..HEAD` stdout (or a raw result)
 * @param {Record<string,object[]|object>} [o.runs] sha -> runs returned for `--commit sha` (or a raw result)
 */
function sim({ ancestry = [HEAD_SHA], diffs = {}, runs = {}, revParse = () => HEAD_SHA, ciWorkflow, ghAll } = {}) {
  const calls = [];
  const r = evaluateCiGate({
    projectRoot: FAKE_ROOT,
    integration: 'staging',
    revParse,
    ...(ciWorkflow === undefined ? {} : { ciWorkflow }),
    spawn: (cmd, args) => {
      calls.push({ cmd, args: args || [] });
      if (cmd === 'git' && args[0] === 'remote') return GH_REMOTE;
      if (cmd === 'git' && args[0] === 'rev-list') return { stdout: ancestry.join('\n') + '\n', stderr: '', status: 0 };
      if (cmd === 'git' && args[0] === 'diff') {
        const from = String(args[args.length - 1]).split('..')[0];
        const d = diffs[from];
        if (d && typeof d === 'object') return d;
        return { stdout: d ?? '', stderr: '', status: 0 };
      }
      if (cmd === 'gh') {
        if (ghAll) return ghAll(args);
        const sha = args[args.indexOf('--commit') + 1];
        const v = runs[sha];
        if (v && !Array.isArray(v)) return v;
        return ghRuns(v || []);
      }
      return { stdout: '', stderr: '', status: 0 };
    },
  });
  const ghCalls = calls.filter((c) => c.cmd === 'gh');
  return { r, calls, ghCalls };
}

describe('AC1 — only the CI workflow, only this branch', () => {
  it('every gh run list argv carries --workflow CI and --branch staging by default, and --workflow Build when injected', () => {
    const a = sim({ runs: { [HEAD_SHA]: [CI_RUN()] } });
    expect(a.ghCalls.length).toBeGreaterThan(0);
    for (const c of a.ghCalls) {
      expect(c.args[c.args.indexOf('--workflow') + 1]).toBe('CI');
      expect(c.args[c.args.indexOf('--branch') + 1]).toBe('staging');
    }
    const b = sim({ ciWorkflow: 'Build', runs: { [HEAD_SHA]: [CI_RUN({ workflowName: 'Build' })] } });
    for (const c of b.ghCalls) expect(c.args[c.args.indexOf('--workflow') + 1]).toBe('Build');
    expect(b.r.ok).toBe(true);
  });

  it('a run from another workflow is discarded client-side even when gh ignores --workflow', () => {
    const { r } = sim({ runs: { [HEAD_SHA]: [CI_RUN({ workflowName: 'Check licenses' })] } });
    expect(r.ok).toBe(false);
  });
});

describe('AC2 — a foreign workflow for a non-candidate never decides', () => {
  it('a newer green Check licenses run for a non-candidate sha does not pass, and its sha is not quoted', () => {
    const FOREIGN = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
    const { r } = sim({
      ghAll: () => ghRuns([CI_RUN({ headSha: FOREIGN, workflowName: 'Check licenses', createdAt: '2026-09-30T00:00:00Z' })]),
    });
    expect(r.ok).toBe(false);
    expect(r.error).not.toContain(FOREIGN.slice(0, 8));
  });
});

describe('AC3-AC5 — HEAD decides when HEAD has a run', () => {
  it('AC3 — HEAD green passes and reports that run; no diff against an arbitrary run sha', () => {
    const { r, calls } = sim({ runs: { [HEAD_SHA]: [CI_RUN({ databaseId: 7 })] } });
    expect(r.ok).toBe(true);
    expect(r.run.databaseId).toBe(7);
    expect(r.run.headSha).toBe(HEAD_SHA);
    expect(calls.some((c) => c.cmd === 'git' && c.args[0] === 'diff')).toBe(false);
  });

  for (const status of ['in_progress', 'queued']) {
    it(`AC4 — HEAD ${status} refuses even with a green CI-ignored-only parent, naming HEAD's run`, () => {
      const { r } = sim({
        ancestry: [HEAD_SHA, P1],
        diffs: { [P1]: 'notes/backlog.x.md\n' },
        runs: { [HEAD_SHA]: [CI_RUN({ databaseId: 9, url: 'https://gh/run/9', status, conclusion: null })], [P1]: [CI_RUN({ headSha: P1 })] },
      });
      expect(r.ok).toBe(false);
      expect(r.error.startsWith('CI in progress at https://gh/run/9')).toBe(true);
      expect(r.run.databaseId).toBe(9);
      expect(r.candidate).toBe(HEAD_SHA);
    });
  }

  it('AC5 — HEAD red refuses with diagnostics even when the parent is green', () => {
    const { r } = sim({
      ancestry: [HEAD_SHA, P1],
      diffs: { [P1]: 'notes/backlog.x.md\n' },
      runs: { [HEAD_SHA]: [CI_RUN({ conclusion: 'failure' })], [P1]: [CI_RUN({ headSha: P1 })] },
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/ci failed/i);
    expect(r).toHaveProperty('diagnostics');
  });
});

describe('AC6-AC8 — the candidate walk', () => {
  it('AC6 — a notes-only HEAD with no run passes on its green parent (the cd505502-on-5a20c9f0 case)', () => {
    const { r } = sim({
      ancestry: [HEAD_SHA, P1],
      diffs: { [P1]: 'notes/backlog.x.md\n' },
      runs: { [P1]: [CI_RUN({ headSha: P1 })] },
    });
    expect(r.ok).toBe(true);
    expect(r.candidate).toBe(P1);
    expect(r.candidateCount).toBe(2);
  });

  it('AC6 — the walk diff is anchored at the ancestor..HEAD, never at production or a tag', () => {
    const { calls } = sim({
      ancestry: [HEAD_SHA, P1],
      diffs: { [P1]: 'notes/backlog.x.md\n' },
      runs: { [P1]: [CI_RUN({ headSha: P1 })] },
    });
    const range = calls.find((c) => c.cmd === 'git' && c.args[0] === 'diff').args.join(' ');
    expect(range).toContain(`${P1}..${HEAD_SHA}`);
    expect(range).not.toMatch(/origin\//);
    expect(range).not.toMatch(/\bv\d+\.\d+\.\d+/);
  });

  it('AC7 — no candidate has a CI run: refuse naming HEAD and the oldest candidate', () => {
    const { r } = sim({
      ancestry: [HEAD_SHA, P1, P2],
      diffs: { [P1]: 'notes/backlog.a.md\n', [P2]: 'packages/mcp-rks/src/server/exec.mjs\n' },
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain(HEAD_SHA.slice(0, 8));
    expect(r.error).toContain(P1.slice(0, 8));
    expect(r.error).toMatch(/no ci-workflow run was found/i);
  });

  it('AC8 — a green run only for a commit whose diff is CI-relevant is never the verdict', () => {
    const { r } = sim({
      ancestry: [HEAD_SHA, P1],
      diffs: { [P1]: 'packages/mcp-rks/src/server/exec.mjs\n' },
      runs: { [P1]: [CI_RUN({ headSha: P1 })] },
    });
    expect(r.ok).toBe(false);
    expect(r.run).toBeNull();
  });

  it('a run whose headSha is not the queried candidate is discarded', () => {
    const { r } = sim({ runs: { [HEAD_SHA]: [CI_RUN({ headSha: OLD_SHA })] } });
    expect(r.ok).toBe(false);
  });
});

describe('RUN ORDERING — newest by createdAt within one candidate, in either array order', () => {
  const OLD_GREEN = CI_RUN({ databaseId: 1, createdAt: '2026-01-01T00:00:00Z' });
  const NEW_RED = CI_RUN({ databaseId: 2, conclusion: 'failure', createdAt: '2026-09-29T12:00:00Z' });
  it('a stale green never masks a newer red — supplied first', () => {
    expect(sim({ runs: { [HEAD_SHA]: [OLD_GREEN, NEW_RED] } }).r.ok).toBe(false);
  });
  it('a stale green never masks a newer red — supplied last', () => {
    expect(sim({ runs: { [HEAD_SHA]: [NEW_RED, OLD_GREEN] } }).r.ok).toBe(false);
  });
  it("refuses when a candidate's runs cannot be ordered (missing createdAt)", () => {
    const { r } = sim({ runs: { [HEAD_SHA]: [CI_RUN({ createdAt: '' }), CI_RUN({ databaseId: 3 })] } });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no createdAt/i);
  });
});

describe('AC9 — every way of not obtaining a verdict refuses, each with a distinct error', () => {
  it('nine refusals, pairwise distinct', () => {
    const errs = [
      sim({ runs: { [HEAD_SHA]: { stdout: '', stderr: 'HTTP 404', status: 1 } } }).r,
      sim({ runs: { [HEAD_SHA]: { stdout: '', stderr: '', status: null } } }).r,
      sim({ runs: { [HEAD_SHA]: { stdout: 'not json', stderr: '', status: 0 } } }).r,
      sim({ runs: { [HEAD_SHA]: [CI_RUN({ createdAt: '' }), CI_RUN({ databaseId: 3 })] } }).r,
      sim({ revParse: () => '' }).r,
      sim({ revParse: () => { throw new TypeError('boom'); } }).r,
      sim({ ancestry: [HEAD_SHA, P1], diffs: { [P1]: { stdout: '', stderr: 'fatal: bad object', status: 128 } } }).r,
      sim({ ancestry: [HEAD_SHA, ...Array.from({ length: 40 }, (_, i) => String(i).padStart(40, 'f'))] }).r,
      sim({ ciWorkflow: '' }).r,
    ];
    for (const e of errs) expect(e.ok).toBe(false);
    expect(new Set(errs.map((e) => e.error)).size).toBe(errs.length);
  });

  it('a throwing revParse is caught, never a raw exception', () => {
    let r;
    expect(() => { r = sim({ revParse: () => { throw new TypeError('boom'); } }).r; }).not.toThrow();
    expect(r.error).toMatch(/CI status could not be determined/i);
  });
});

describe('AC10 — every verdict names its run and candidate', () => {
  it('the pass and a run-based refusal expose run identity, candidate and count; the no-run refusal says so', () => {
    const pass = sim({ runs: { [HEAD_SHA]: [CI_RUN()] } }).r;
    const red = sim({ runs: { [HEAD_SHA]: [CI_RUN({ conclusion: 'failure' })] } }).r;
    for (const v of [pass, red]) {
      expect(Object.keys(v.run).sort()).toEqual(['createdAt', 'databaseId', 'event', 'headSha', 'workflowName']);
      expect(v.candidate).toBe(HEAD_SHA);
      expect(v.candidateCount).toBe(1);
    }
    const none = sim().r;
    expect(none.error).toMatch(/no ci-workflow run was found/i);
  });
});

describe('AC13 — ciWorkflow comes from .rks/project.json', () => {
  it('omitted behaves exactly like "CI"', () => {
    const a = sim({ runs: { [HEAD_SHA]: [CI_RUN()] } });
    const b = sim({ ciWorkflow: 'CI', runs: { [HEAD_SHA]: [CI_RUN()] } });
    expect(a.r).toEqual(b.r);
  });

  for (const bad of ['', '   ', 42, null, ['CI'], { name: 'CI' }]) {
    it(`a malformed ciWorkflow (${JSON.stringify(bad)}) refuses before any gh run list`, () => {
      const { r, ghCalls } = sim({ ciWorkflow: bad });
      expect(r.ok).toBe(false);
      expect(r.error).toContain('ciWorkflow');
      expect(r.error).toContain('.rks/project.json');
      expect(ghCalls.length).toBe(0);
    });
  }

  it('runRelease passes projectJson.ciWorkflow through, and defaults to CI', async () => {
    const workflowsSeen = () => ledger.filter((c) => c.cmd === 'gh' && c.args[0] === 'run' && c.args[1] === 'list').map((c) => c.args[c.args.indexOf('--workflow') + 1]);
    installSpawn({ gh: ghRuns([CI_RUN({ workflowName: 'Build' })]) });
    await runRelease({ projectRoot: FAKE_ROOT, version: 'patch', projectId: 'test', projectJson: { ciWorkflow: 'Build' } });
    expect(workflowsSeen().length).toBeGreaterThan(0);
    expect(new Set(workflowsSeen())).toEqual(new Set(['Build']));

    for (const projectJson of [null, {}]) {
      ledger = [];
      installSpawn();
      await runRelease({ projectRoot: FAKE_ROOT, version: 'patch', projectId: 'test', projectJson });
      expect(workflowsSeen().length).toBeGreaterThan(0);
      expect(new Set(workflowsSeen())).toEqual(new Set(['CI']));
    }
  });
});

describe('ORDINARY RELEASE — the everyday case must still work', () => {
  it('passes on a notes-only tail over a green CI-relevant parent, and DOES mutate', async () => {
    installSpawn({
      ancestry: [HEAD_SHA, OLD_SHA],
      diff: { stdout: 'notes/backlog.feat.x.md\n.rks/project.json\n', stderr: '', status: 0 },
      gh: (args) => ghRuns(args[args.indexOf('--commit') + 1] === OLD_SHA ? [CI_RUN({ headSha: OLD_SHA })] : []),
    });
    const r = await release();
    // POSITIVE CONTROL for every expectNoMutation() above.
    const m = mutated();
    expect(m.committed && m.merged, 'a permitted release must commit AND merge').toBe(true);
    expect(r.ok).toBe(true);
  });
});

describe('APPLICABILITY — the no-GitHub-remote carve-out must not become a bypass', () => {
  it('passes when the project genuinely has no GitHub remote (CI cannot exist)', async () => {
    // Requiring a verdict here would block every release in every non-GitHub
    // project — the same unusable-gate failure as blocking a notes-only tail.
    installSpawn({
      remote: { stdout: 'origin\tgit@gitlab.com:acme/thing.git (fetch)\n', stderr: '', status: 0 },
      gh: { stdout: '', stderr: 'no gh here', status: 1 },
    });
    const r = await release();
    expect(r.ok).not.toBe(false);
  });

  it('still BLOCKS when a GitHub remote exists and gh is unreachable', async () => {
    // The carve-out is applicability, not permission.
    installSpawn({ gh: { stdout: '', stderr: 'HTTP 404', status: 1 } });
    const r = await release();
    expect(r.ok).toBe(false);
    expectNoMutation();
  });

  it('BLOCKS when applicability itself cannot be determined', async () => {
    // An unobtainable answer must not read as permission — that is the original
    // defect in a different coat.
    installSpawn({ remote: { stdout: '', stderr: 'fatal: not a git repository', status: 128 } });
    const r = await release();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/could not determine whether/i);
    expectNoMutation();
  });
});

describe('THE OVERRIDE — deliberate, reasoned, and never silent', () => {
  const OVERRIDE = { enabled: true, reason: 'CI unreachable during incident 2026-08-17; verified locally' };

  function events(type) {
    const collector = ensureTelemetryStorage(FAKE_ROOT);
    return ((collector.emit?.mock?.calls) || [])
      .filter(([t]) => t === type)
      .map(([, , payload]) => payload || {});
  }

  it('permits the release past a blocking verdict when a reason is supplied', async () => {
    installSpawn({ gh: { stdout: '', stderr: 'HTTP 404', status: 1 } });
    const r = await runRelease({
      projectRoot: FAKE_ROOT, version: 'patch', projectId: 'test', enforcementOverride: OVERRIDE,
    });
    expect(r.ok).toBe(true);
    const m = mutated();
    expect(m.committed && m.merged, 'an overridden release must actually proceed').toBe(true);
  });

  it('an applied override is NEVER silent — the reason reaches telemetry', async () => {
    installSpawn({ gh: { stdout: '', stderr: 'HTTP 404', status: 1 } });
    await runRelease({
      projectRoot: FAKE_ROOT, version: 'patch', projectId: 'test', enforcementOverride: OVERRIDE,
    });
    // Read off the recording seat. An override that leaves no trace is
    // indistinguishable from the fail-open this gate exists to prevent.
    const complete = events('release.complete');
    expect(complete.length).toBeGreaterThan(0);
    expect(complete[complete.length - 1].ciGateOverridden).toBe(true);
    expect(complete[complete.length - 1].overrideReason).toContain('CI unreachable');
  });

  it('does NOT mark itself applied when the gate is not blocking', async () => {
    // The conjunction must be standalone. If overrideApplied were folded into
    // the blocking branch, an override supplied on a green release would claim
    // credit it did not earn — and the audit trail would lie in the other
    // direction.
    installSpawn();
    await runRelease({
      projectRoot: FAKE_ROOT, version: 'patch', projectId: 'test', enforcementOverride: OVERRIDE,
    });
    const complete = events('release.complete');
    expect(complete.length).toBeGreaterThan(0);
    expect(complete[complete.length - 1].ciGateOverridden).toBeUndefined();
  });

  it('a blocked release without an override emits release.failed', async () => {
    // This return previously emitted nothing; the only path to release.failed
    // was throwing into the outer catch, which the D2 fix removes.
    installSpawn({ gh: { stdout: '', stderr: 'HTTP 404', status: 1 } });
    const r = await release();
    expect(r.ok).toBe(false);
    const failed = events('release.failed');
    expect(failed.length).toBeGreaterThan(0);
    expect(failed[failed.length - 1].reason).toBe('ci_gate_blocked');
  });
});
