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

function installSpawn({ gh, diff, remote } = {}) {
  spawnSync.mockImplementation((cmd, args) => {
    ledger.push({ cmd, args: args || [] });
    if (cmd === 'git' && args[0] === 'remote') {
      return remote || { stdout: 'origin\thttps://github.com/ux287/routekit-shell-core.git (fetch)\n', stderr: '', status: 0 };
    }
    if (cmd === 'git' && args[0] === 'status') return { stdout: '', stderr: '', status: 0 };
    if (cmd === 'git' && args[0] === 'rev-list' && args.includes('--left-right')) {
      return { stdout: '0\t0', stderr: '', status: 0 };
    }
    if (cmd === 'git' && args[0] === 'diff' && args.includes('--name-only')) {
      return diff || { stdout: '', stderr: '', status: 0 };
    }
    if (cmd === 'gh' && args[0] === 'run') {
      return gh || ghRuns([{ databaseId: 1, url: 'u', status: 'completed', conclusion: 'success', headSha: HEAD_SHA }]);
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

  it('HOLE 4 — no run exists for the branch', async () => {
    installSpawn({ gh: ghRuns([]) });
    const r = await release();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no ci run found/i);
    expectNoMutation();
  });

  it('HOLE 5 — the green run is for an OLDER commit and real code changed since', async () => {
    installSpawn({
      gh: ghRuns([{ databaseId: 1, url: 'u', status: 'completed', conclusion: 'success', headSha: OLD_SHA }]),
      diff: { stdout: 'packages/mcp-rks/src/server/exec.mjs\n', stderr: '', status: 0 },
    });
    const r = await release();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/ci-relevant file/i);
    expectNoMutation();
  });
});

describe('CLAUSE (a) — a stale run must ALSO be completed and successful', () => {
  // The previous form of these cases drove runRelease with a CI-ignored diff
  // fixture that was NEVER CONSUMED: `status !== "completed"` and
  // `conclusion !== "success"` both return before the sha comparison and the
  // diff. They passed, but not for the reason they claimed, and survived both
  // "reorder the checks after the diff branch" and "delete the diff branch".
  // These drive evaluateCiGate DIRECTLY and witness ordering via the ledger.
  const GH_REMOTE = { stdout: 'origin\thttps://github.com/ux287/routekit-shell-core.git (fetch)\n', stderr: '', status: 0 };

  function directGate(runFields, { diffOut = 'notes/backlog.feat.x.md\n' } = {}) {
    const calls = [];
    const r = evaluateCiGate({
      projectRoot: FAKE_ROOT,
      integration: 'staging',
      revParse: () => HEAD_SHA,
      spawn: (cmd, args) => {
        calls.push({ cmd, args: args || [] });
        if (cmd === 'git' && args[0] === 'remote') return GH_REMOTE;
        if (cmd === 'git' && args[0] === 'diff') return { stdout: diffOut, stderr: '', status: 0 };
        return ghRuns([{ databaseId: 1, url: 'u', headSha: OLD_SHA, ...runFields }]);
      },
    });
    const diffed = calls.some(c => c.cmd === 'git' && c.args[0] === 'diff' && c.args.includes('--name-only'));
    return { r, diffed, calls };
  }

  it('a RED base run blocks on the CI-failed verdict and never reaches the diff', () => {
    const { r, diffed } = directGate({ status: 'completed', conclusion: 'failure' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/ci failed/i);
    expect(r.error).not.toMatch(/ci-relevant file/i);
    // Ordering witnessed directly: if the checks were reordered after the diff
    // branch, the CI-ignored tail would have produced ok:true instead.
    expect(diffed, 'a red base run must not reach the range diff').toBe(false);
  });

  it('an IN-PROGRESS base run blocks and never reaches the diff', () => {
    const { r, diffed } = directGate({ status: 'in_progress', conclusion: null });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/in progress/i);
    expect(r.error).not.toMatch(/ci-relevant file/i);
    expect(diffed, 'an in-progress base run must not reach the range diff').toBe(false);
  });

  it('D4c — a GREEN base run with the SAME fixture DOES reach the diff and passes', () => {
    // The discriminator. Without this, "delete the diff branch" reds nothing:
    // no non-green case can witness a branch it never reaches. This is also the
    // positive control whose absence made the originals vacuous.
    const { r, diffed, calls } = directGate({ status: 'completed', conclusion: 'success' });
    expect(r.ok).toBe(true);
    expect(diffed, 'a green stale run MUST evaluate the range diff').toBe(true);
    const diffCall = calls.find(c => c.cmd === 'git' && c.args[0] === 'diff');
    expect(diffCall.args.join(' ')).toContain(`${OLD_SHA}..${HEAD_SHA}`);
  });
});
describe('RUN ORDERING — gh run list does not reliably return the newest run first', () => {
  // Not contrived: `gh run list --branch staging --limit 1` returned run
  // 28633725588 (headSha 7d36404c, months old) while --limit 5 returned
  // 32750063582 (headSha 455cf396, current) as its FIRST element. Same branch,
  // same query, different answer. Every fixture here puts a stale run at an
  // index the old `runs[0]` would have trusted.
  const GH_REMOTE = { stdout: 'origin\thttps://github.com/ux287/routekit-shell-core.git (fetch)\n', stderr: '', status: 0 };
  const STALE_GREEN = { databaseId: 1, url: 'u', status: 'completed', conclusion: 'success', headSha: OLD_SHA, createdAt: '2026-01-01T00:00:00Z' };
  const NEW_RED = { databaseId: 2, url: 'u2', status: 'completed', conclusion: 'failure', headSha: HEAD_SHA, createdAt: '2026-08-24T16:18:28Z' };
  const NEW_GREEN = { databaseId: 2, url: 'u2', status: 'completed', conclusion: 'success', headSha: HEAD_SHA, createdAt: '2026-08-24T16:18:28Z' };

  // Same shape as directGate above, but the caller supplies the whole runs ARRAY —
  // the ordering defect is invisible to any single-run fixture.
  function directGateRuns(runs, { diffOut = 'notes/backlog.feat.x.md\n' } = {}) {
    const calls = [];
    const r = evaluateCiGate({
      projectRoot: FAKE_ROOT,
      integration: 'staging',
      revParse: () => HEAD_SHA,
      spawn: (cmd, args) => {
        calls.push({ cmd, args: args || [] });
        if (cmd === 'git' && args[0] === 'remote') return GH_REMOTE;
        if (cmd === 'git' && args[0] === 'diff') return { stdout: diffOut, stderr: '', status: 0 };
        return ghRuns(runs);
      },
    });
    const diffed = calls.some(c => c.cmd === 'git' && c.args[0] === 'diff' && c.args.includes('--name-only'));
    return { r, diffed, calls };
  }

  it('selects the newest run even when gh returns a stale one first', () => {
    // CI-relevant tail, so trusting runs[0] blocks. Selecting correctly makes the
    // run sha EQUAL head, which returns before the diff is ever consulted.
    const { r, diffed } = directGateRuns([STALE_GREEN, NEW_GREEN], { diffOut: 'packages/mcp-rks/src/server/exec.mjs\n' });
    expect(r.ok, 'the newest run is green for HEAD — a stale run at index 0 must not decide this').toBe(true);
    expect(diffed, 'a run sha equal to HEAD must not reach the range diff').toBe(false);
  });

  it('THE FAIL-OPEN — a stale GREEN run must not mask a newer RED one', () => {
    // The dangerous face. Trusting runs[0] takes the stale GREEN verdict, finds a
    // CI-ignored tail, and PASSES — releasing on top of a red CI. v0.39.0 exactly.
    const { r, diffed } = directGateRuns([STALE_GREEN, NEW_RED]);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/ci failed/i);
    expect(r.error).not.toMatch(/ci-relevant file/i);
    expect(diffed, 'a red newest run must not reach the range diff').toBe(false);
  });

  it('does not merely take the LAST element — newest at index 0 still wins', () => {
    // Vacuity guard on the reducer: an off-by-one that always took the final
    // element would pass both cases above for entirely the wrong reason.
    const { r, diffed } = directGateRuns([NEW_RED, STALE_GREEN]);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/ci failed/i);
    expect(diffed).toBe(false);
  });

  it('refuses when the runs cannot be ordered at all', () => {
    // Falling back to runs[0] here would silently reinstate the bug.
    const { r, diffed } = directGateRuns([
      { databaseId: 1, url: 'u', status: 'completed', conclusion: 'success', headSha: OLD_SHA },
      { databaseId: 2, url: 'u2', status: 'completed', conclusion: 'success', headSha: HEAD_SHA },
    ]);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/refusing to release without a verdict/i);
    expect(diffed, 'an unorderable set must refuse before consulting the diff').toBe(false);
  });
});

describe('THE RANGE ANCHOR — asserted on argv, not on outcome', () => {
  // The blocking cases above stay green under ALL THREE candidate anchors, so
  // they structurally cannot witness this choice. Only inspecting argv can.
  it('anchors the diff at the verified run sha, never at production or a tag', async () => {
    installSpawn({
      gh: ghRuns([{ databaseId: 1, url: 'u', status: 'completed', conclusion: 'success', headSha: OLD_SHA }]),
      diff: { stdout: 'notes/backlog.feat.x.md\n', stderr: '', status: 0 },
    });
    await release();

    const diffCall = ledger.find(c => c.cmd === 'git' && c.args[0] === 'diff' && c.args.includes('--name-only'));
    expect(diffCall, 'the gate must diff the range').toBeTruthy();
    const range = diffCall.args.join(' ');
    expect(range).toContain(OLD_SHA);
    expect(range).toContain(HEAD_SHA);
    expect(range).not.toMatch(/origin\//);
    expect(range).not.toMatch(/\bv\d+\.\d+\.\d+/);
  });
});

describe('ORDINARY RELEASE — the everyday case must still work', () => {
  it('passes when the tail since the verified run is CI-ignored, and DOES mutate', async () => {
    installSpawn({
      gh: ghRuns([{ databaseId: 1, url: 'u', status: 'completed', conclusion: 'success', headSha: OLD_SHA }]),
      diff: { stdout: 'notes/backlog.feat.x.md\n.rks/project.json\n', stderr: '', status: 0 },
    });
    const r = await release();

    // POSITIVE CONTROL for every expectNoMutation() above: those would pass
    // vacuously if the harness stopped driving runRelease.
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

describe('D1 — an unresolvable sha must BLOCK, not pass', () => {
  // The defect this story exists to fix: `if (!headSha || !runSha || runSha ===
  // headSha) return { ok: true }` treated an unobtainable answer as permission
  // — the exact shape of the original release-gate bug, written into its repair.
  // ONLY the equality case may pass.
  const GH_REMOTE = { stdout: 'origin\thttps://github.com/ux287/routekit-shell-core.git (fetch)\n', stderr: '', status: 0 };

  function gateWith({ revParse, runHeadSha = HEAD_SHA }) {
    return evaluateCiGate({
      projectRoot: FAKE_ROOT,
      integration: 'staging',
      revParse,
      spawn: (cmd, args) => {
        if (cmd === 'git' && args[0] === 'remote') return GH_REMOTE;
        if (cmd === 'git' && args[0] === 'diff') return { stdout: '', stderr: '', status: 0 };
        return ghRuns([{ databaseId: 1, url: 'u', status: 'completed', conclusion: 'success', headSha: runHeadSha }]);
      },
    });
  }

  it('blocks when integration HEAD cannot be resolved', () => {
    const r = gateWith({ revParse: () => '' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/could not resolve/i);
    expect(r.error).toMatch(/staging/);
  });

  it('blocks when the CI run carries no headSha', () => {
    const r = gateWith({ revParse: () => HEAD_SHA, runHeadSha: '' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/could not resolve/i);
  });

  it('D2 — a THROWING revParse blocks with the caught-crash verdict, not a raw exception', () => {
    // evaluateCiGate is a named export; its fail-closed contract must hold when
    // called directly, not merely because one caller wraps it in try/catch.
    // The two verdicts must be DISTINCT strings — a merged wording reds this.
    let r;
    expect(() => { r = gateWith({ revParse: () => { throw new TypeError('boom'); } }); }).not.toThrow();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/CI status could not be determined/i);
    expect(r.error).not.toMatch(/TypeError|Cannot read properties/);
  });

  it('still passes when the run sha EQUALS integration HEAD', () => {
    const r = gateWith({ revParse: () => HEAD_SHA });
    expect(r.ok).toBe(true);
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

describe('evaluateCiGate — the extracted helper, driven directly', () => {
  const gate = (opts) => evaluateCiGate({
    projectRoot: FAKE_ROOT,
    integration: 'staging',
    revParse: () => HEAD_SHA,
    ...opts,
  });

  const GH_REMOTE = { stdout: 'origin\thttps://github.com/ux287/routekit-shell-core.git (fetch)\n', stderr: '', status: 0 };

  it('returns ok when the run is green for the exact HEAD', () => {
    const r = gate({
      spawn: (cmd, args) => {
        if (cmd === 'git' && args[0] === 'remote') return GH_REMOTE;
        return ghRuns([{ databaseId: 1, url: 'u', status: 'completed', conclusion: 'success', headSha: HEAD_SHA }]);
      },
    });
    expect(r.ok).toBe(true);
  });

  it('blocks when the intervening diff itself cannot be read', () => {
    const r = gate({
      spawn: (cmd, args) => {
        if (cmd === 'git' && args[0] === 'remote') return GH_REMOTE;
        if (cmd === 'gh') return ghRuns([{ databaseId: 1, url: 'u', status: 'completed', conclusion: 'success', headSha: OLD_SHA }]);
        return { stdout: '', stderr: 'fatal: bad object', status: 128 };
      },
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/could not be read/i);
  });
});
