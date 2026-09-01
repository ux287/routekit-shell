/**
 * Tests for backlog.fix.endsession-stash-autopop-unawaited.
 *
 * endSession fired the stash auto-pop as a floating promise:
 *
 *   Promise.resolve(cleanupFn()).catch(e => { console.error(...); });
 *
 * The return value was dropped, and `_pendingStashCleanup.delete(token)` plus
 * `governorSessions.delete(token)` both ran before the pop could settle. A process
 * exiting straight after endSession therefore lost the restore, with the user's
 * work still stashed and nothing having reported a failure — stderr was the only
 * record, and unlike the guardrails half of the same teardown there is no
 * next-session recovery for a stash.
 *
 * WHY THESE TESTS DO NOT POLL. The two pre-existing suites that touch this path
 * COMPENSATE for the defect rather than catch it:
 *   tests/integration/stash-create-containment.test.mjs:137
 *     await new Promise((r) => setImmediate(r));
 *   tests/unit/exec-no-actions-state-rollback.test.mjs:125,138
 *     await new Promise(resolve => setTimeout(resolve, 0));
 * Each is a scheduler yield standing in for the missing await, which is why those
 * assertions passed against the broken code. Production has no yield.
 *
 * So the witness here waits with the ARTIFACT THE FIX PRODUCES, never with the
 * scheduler: a cleanup gated on a REAL 50ms timer — a boundary no microtask drain
 * and no setImmediate can cross — plus a thenable check that fails today with no
 * timing dependency at all.
 *
 * This file must contain no spawn-family call (unit-tier purity guard).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getTelemetryCollector } from '@routekit/telemetry';

import {
  createSession,
  endSession,
  flushPendingStashPops,
  setPendingStash,
} from '../../packages/mcp-rks/src/shared/governor-token.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const TOKEN_SRC = fs.readFileSync(
  path.join(REPO_ROOT, 'packages/mcp-rks/src/shared/governor-token.mjs'),
  'utf8',
);

/** A cleanup that cannot possibly complete within a microtask drain. */
const slowCleanup = (ms, record, onRun = () => {}) => () =>
  new Promise((resolve) => {
    setTimeout(() => {
      record.done = true;
      onRun();
      resolve();
    }, ms);
  });

/** setPendingStash takes the cleanup fn directly and flips session.pendingStash. */
function startSession(cleanupFn, projectId = 'routekit-shell-core') {
  const { token } = createSession({ projectId, flowType: 'open' });
  setPendingStash(token, cleanupFn);
  return token;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('endSession retains the stash pop instead of dropping it', () => {
  it('returns a thenable from flushPendingStashPops — no timing involved', async () => {
    // Fails against the pre-fix code for a reason that has nothing to do with
    // scheduling: the export did not exist and the promise was never retained.
    expect(typeof flushPendingStashPops).toBe('function');
    await expect(flushPendingStashPops()).resolves.toBeInstanceOf(Array);
  });

  it('resolves to [] when nothing is pending, without hanging', async () => {
    await expect(flushPendingStashPops()).resolves.toEqual([]);
  });

  it('AWAITS A REAL 50ms POP — the boundary a scheduler yield cannot cross', async () => {
    const record = { done: false };
    const token = startSession(slowCleanup(50, record));

    endSession(token);

    // ANTI-VACUITY CONTROL. If this were already true the assertion after the
    // flush would prove nothing — it would pass whether or not anything was
    // awaited. A 50ms timer guarantees it is false here.
    expect(record.done).toBe(false);

    // Nothing between the await and the expect. Only a genuine await of the
    // retained promise can satisfy this; setImmediate and a microtask drain both
    // return long before a 50ms timer fires.
    await flushPendingStashPops();
    expect(record.done).toBe(true);
  });

  it('reports how the pop SETTLED, not merely that it was fired', async () => {
    const token = startSession(slowCleanup(20, {}));

    endSession(token);
    const outcomes = await flushPendingStashPops();

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].token).toBe(token);
    expect(outcomes[0].ok).toBe(true);
    expect(outcomes[0].error).toBeNull();
  });

  it('surfaces a FAILED pop as an outcome rather than only on stderr', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const token = startSession(() =>
      new Promise((_resolve, reject) => {
        setTimeout(() => reject(new Error('git stash pop failed: conflict')), 20);
      }),
    );

    endSession(token);
    const outcomes = await flushPendingStashPops();

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].ok).toBe(false);
    expect(outcomes[0].error).toContain('conflict');
    // A rejected pop must never reject the flush — the wire layer awaits this in
    // a `finally` and must not have the tool result replaced by a stash error.
    expect(Array.isArray(outcomes)).toBe(true);
  });

  it('carries projectId, captured while the session was still live', async () => {
    // governorSessions.delete(token) runs before the pop settles, so a flush-time
    // getSession(token) is empty; and the module-level _projectRoot is a singleton
    // reflecting the LAST setProjectRoot call, not this session's project.
    const tokenA = startSession(slowCleanup(10, {}), 'project-alpha');
    const tokenB = startSession(slowCleanup(10, {}), 'project-beta');

    endSession(tokenA);
    endSession(tokenB);
    const outcomes = await flushPendingStashPops();

    // TWO-PROJECT ANTI-VACUITY CONTROL: a single project would pass even if the
    // implementation read the _projectRoot global instead of the session.
    const byToken = Object.fromEntries(outcomes.map((o) => [o.token, o.projectId]));
    expect(byToken[tokenA]).toBe('project-alpha');
    expect(byToken[tokenB]).toBe('project-beta');
  });

  // TELEMETRY, added by backlog.fix.post-ship-review-findings-batch (Finding 2).
  //
  // Two acceptance criteria of the shipped story asserted that the pop outcome
  // reaches telemetry. Neither had a test: `governor.stash_pop` returned ZERO
  // matches across tests/ (positive control: `governor.init`, same scope, 10).
  // The outcome ARRAY was covered; the emit was not, so the field an operator
  // would actually look at was unwitnessed.
  //
  // Captured by wrapping collector.emit rather than reading emit.mock.calls:
  // under the global stub in tests/setup.mjs, resetTelemetryCollector is itself a
  // no-op vi.fn(), so call history is NOT cleared between tests and .mock.calls
  // would carry emissions from every earlier test in the shard. The wrapper is
  // restored in a finally so the shared stub is left unmutated for other files.
  async function captureEmits(run) {
    const collector = getTelemetryCollector();
    const seen = [];
    const orig = collector.emit.bind(collector);
    collector.emit = (type, projectId, payload) => {
      seen.push({ type, projectId, payload });
      return orig(type, projectId, payload);
    };
    try {
      await run();
    } finally {
      collector.emit = orig;
    }
    return seen;
  }

  const popsIn = (seen) => seen.filter((e) => e.type === 'governor.stash_pop');

  it('EMITS governor.stash_pop with ok: true after a successful pop', async () => {
    let token;
    const seen = await captureEmits(async () => {
      token = startSession(slowCleanup(10, {}), 'project-emit-ok');
      endSession(token);
      await flushPendingStashPops();
    });

    // ANTI-VACUITY: the wrapper really was installed and really saw traffic. If
    // capture silently failed, popsIn() would be empty and the length assertion
    // below would read as "no pop emitted" rather than "nothing was captured".
    expect(seen.length).toBeGreaterThan(0);

    const pops = popsIn(seen);
    expect(pops).toHaveLength(1);
    expect(pops[0].payload.ok).toBe(true);
    expect(pops[0].payload.token).toBe(token);
    // projectId is the second positional, captured while the session was live.
    expect(pops[0].projectId).toBe('project-emit-ok');
  });

  it('EMITS governor.stash_pop with ok: false and the error, and neither call throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let token;
    let threw = null;
    const seen = await captureEmits(async () => {
      token = startSession(
        () => new Promise((_resolve, reject) => {
          setTimeout(() => reject(new Error('git stash pop failed: conflict')), 10);
        }),
        'project-emit-fail',
      );
      try {
        endSession(token);
        await flushPendingStashPops();
      } catch (e) {
        threw = e;
      }
    });

    // A failed restore must be REPORTED, not thrown: the wire layer awaits the
    // flush in a finally, and a throw there would replace the tool's own result.
    expect(threw).toBeNull();

    const pops = popsIn(seen);
    expect(pops).toHaveLength(1);
    expect(pops[0].payload.ok).toBe(false);
    expect(pops[0].payload.error).toContain('conflict');
    expect(pops[0].payload.token).toBe(token);
  });

  it('the two polarities are DISTINGUISHABLE — same event, opposite ok', async () => {
    // Guards against an implementation that emits a constant. Without this, both
    // tests above would pass against a hardcoded ok on either branch, since each
    // only ever observes one polarity.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const seen = await captureEmits(async () => {
      const good = startSession(slowCleanup(5, {}));
      const bad = startSession(() => Promise.reject(new Error('boom')));
      endSession(good);
      endSession(bad);
      await flushPendingStashPops();
    });

    const flags = popsIn(seen).map((e) => e.payload.ok).sort();
    expect(flags).toEqual([false, true]);
  });

  it('drains the registry — a second flush does not re-run a settled pop', async () => {
    const record = { done: false };
    let runs = 0;
    const token = startSession(slowCleanup(10, record, () => { runs += 1; }));

    endSession(token);
    await flushPendingStashPops();
    expect(runs).toBe(1);
    await expect(flushPendingStashPops()).resolves.toEqual([]);
    expect(runs).toBe(1);
  });
});

describe('placement guard — the widened delimiter is not the whole protection', () => {
  // Two suites this story does NOT edit bound a source window over
  // governor-token.mjs with the narrow `"\nexport function"` delimiter, spanning
  // checkAllowedTool → advanceState:
  //   tests/unit/research-agent-self-bootstrap.test.mjs:85,92,104
  //   tests/unit/wire-classify-chain-refusal.test.mjs:199
  // `export async function` is invisible to that delimiter, so a declaration
  // placed inside that span would silently over-extend both windows. Widening the
  // delimiter in ONE suite does not protect the other two — placement does.

  const idxOf = (needle) => TOKEN_SRC.indexOf(needle);

  it('FIXTURE PRECONDITION — every needle resolves', () => {
    // F8. Without this the between-check below passes VACUOUSLY when a needle is
    // missing, because -1 does not fall between two positive indices — the exact
    // failure mode this guard exists to prevent, reproduced inside the guard.
    for (const needle of [
      '\nexport async function flushPendingStashPops',
      '\nexport function checkAllowedTool',
      '\nexport function advanceState',
      '\nexport function endSession',
    ]) {
      expect(idxOf(needle), `needle not found: ${needle}`).toBeGreaterThan(-1);
    }
  });

  it('flushPendingStashPops is declared OUTSIDE the checkAllowedTool→advanceState span', () => {
    const flushIdx = idxOf('\nexport async function flushPendingStashPops');
    const checkIdx = idxOf('\nexport function checkAllowedTool');
    const advanceIdx = idxOf('\nexport function advanceState');

    expect(flushIdx).toBeGreaterThan(-1);
    expect(checkIdx).toBeGreaterThan(-1);
    expect(advanceIdx).toBeGreaterThan(-1);
    expect(checkIdx).toBeLessThan(advanceIdx);

    const insideSlicedSpan = flushIdx > checkIdx && flushIdx < advanceIdx;
    expect(
      insideSlicedSpan,
      'flushPendingStashPops must not sit between checkAllowedTool and advanceState — '
        + 'two unrepaired suites slice that span with a delimiter blind to `export async function`',
    ).toBe(false);
  });

  it('THE COMPENSATION CANNOT SILENTLY RETURN — no scheduler yields in either suite', () => {
    // Both suites previously waited on the scheduler instead of on the pop, which
    // is why they passed against the floating-promise defect. If a future edit
    // reintroduces a yield, the assertion it guards goes back to proving nothing —
    // and nothing would go red. This is what makes that loud.
    const suites = [
      'tests/integration/stash-create-containment.test.mjs',
      'tests/unit/exec-no-actions-state-rollback.test.mjs',
    ];
    for (const rel of suites) {
      const body = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
      // Strip line comments: the replacement comments NAME the removed pattern.
      const code = body
        .split('\n')
        .map((l) => {
          const i = l.indexOf('//');
          return i === -1 ? l : l.slice(0, i);
        })
        .join('\n');
      expect(code, `${rel} reintroduced a setImmediate yield`).not.toMatch(/setImmediate\s*\(/);
      expect(code, `${rel} reintroduced a zero-delay setTimeout yield`)
        .not.toMatch(/setTimeout\s*\(\s*[^,]+,\s*0\s*\)/);
      // Anti-vacuity: the file was actually read and is the one we think.
      expect(code).toContain('flushPendingStashPops');
    }
  });

  it('is declared immediately after endSession', () => {
    const endIdx = idxOf('\nexport function endSession');
    const flushIdx = idxOf('\nexport async function flushPendingStashPops');
    const guardIdx = idxOf('\nexport function setGuardrailsDisabled');
    expect(endIdx).toBeLessThan(flushIdx);
    expect(flushIdx).toBeLessThan(guardIdx);
  });
});
