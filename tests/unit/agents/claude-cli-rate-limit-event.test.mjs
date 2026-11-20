/**
 * backlog.feat.claude-cli-rate-limit-event: rate_limit_event parsing, sanitizing, classification,
 * resetsAt propagation and telemetry in packages/mcp-rks/src/agents/executors/claude-cli.mjs.
 *
 * DETERMINISM. No real claude binary is started and no subscription is needed. The child process
 * is a scripted EventEmitter returned by an INJECTED spawn implementation (deps.spawn); env,
 * tmpdir, probeResult and the telemetry collector are injected as well. No subprocess is created,
 * so the subprocess-timeout convention is satisfied vacuously. The file quotes no telemetry-package
 * specifier.
 *
 * SHAPES.
 * - OBSERVED: OBSERVED_INFO is the rate_limit_info of one real claude 2.1.302 stream-json line.
 *   The capture elided its uuid / session_id; the values here are sentinels so a leak is detectable.
 * - ASSUMED (third-party-reported, not observed locally): the statuses "allowed_warning" and "rejected".
 *   Sources, not Anthropic docs: vercel/ai #22219, ClaudeCode hexdocs v0.36.5 RateLimitEvent,
 *   kpenfound/busybees #174, croffasia/itsaplan #432 (research telemetryId
 *   0dd8a93b-25e4-4902-986a-f31eef50c228). "allowed_warning" is reported at >= 90% utilization while
 *   requests still succeed, so it is NOT limited. Only "rejected" is limited. LIMITED_INFO ("rejected")
 *   and WARNING_INFO ("allowed_warning") pin the story's design, not observed CLI behaviour.
 * - ASSUMED: system/init, api_retry and result lines (docs-derived, as in claude-cli-executor.test.mjs).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { z } from 'zod';
import {
  runClaudeCliAgent,
  parseStreamJson,
  classifyCliFailure,
  summarizeRateLimit,
  isRateLimited,
} from '../../../packages/mcp-rks/src/agents/executors/claude-cli.mjs';

// ---------------------------------------------------------------------------
// rate_limit_event fixtures
// ---------------------------------------------------------------------------

const EVENT_UUID = 'rle-uuid-SENTINEL-4b7e';
const EVENT_SESSION = 'rle-session-SENTINEL-9c1d';
const RESETS_AT = 1792355400; // epoch seconds: five_hour resetsAt of the observed line
const SEVEN_DAY_RESETS_AT = 1792526400;

// OBSERVED SHAPE (claude 2.1.302).
const OBSERVED_INFO = Object.freeze({
  status: 'allowed',
  resetsAt: RESETS_AT,
  rateLimitType: 'five_hour',
  overageStatus: 'rejected',
  overageDisabledReason: 'out_of_credits',
  isUsingOverage: false,
  unifiedWindows: {
    five_hour: { utilization: 0.01, resetsAt: RESETS_AT },
    seven_day: { utilization: 0.27, resetsAt: SEVEN_DAY_RESETS_AT },
  },
});

// ASSUMED SHAPE: the limited state. "rejected" is third-party-reported; only "allowed" is observed locally.
const LIMITED_INFO = Object.freeze({ ...OBSERVED_INFO, status: 'rejected' });
// ASSUMED SHAPE: the third-party-reported warning state (>= 90% utilization, requests still succeed). Not limited.
const WARNING_INFO = Object.freeze({ ...OBSERVED_INFO, status: 'allowed_warning' });
const UNKNOWN_STATUS_INFO = Object.freeze({ ...OBSERVED_INFO, status: 'some_future_status' });

const rateLimitLine = (info) => ({ type: 'rate_limit_event', rate_limit_info: info, uuid: EVENT_UUID, session_id: EVENT_SESSION });

const WHITELIST = ['status', 'rateLimitType', 'resetsAt', 'fiveHourUtilization', 'sevenDayUtilization'];
const OBSERVED_SUMMARY = Object.freeze({
  status: 'allowed', rateLimitType: 'five_hour', resetsAt: RESETS_AT, fiveHourUtilization: 0.01, sevenDayUtilization: 0.27,
});
const LIMITED_SUMMARY = Object.freeze({ ...OBSERVED_SUMMARY, status: 'rejected' });
const LEAK_SENTINELS = [EVENT_UUID, EVENT_SESSION, 'out_of_credits', 'overageDisabledReason'];

// ---------------------------------------------------------------------------
// Other stream-json fixtures. ASSUMED SHAPES (docs-derived).
// ---------------------------------------------------------------------------

const READY_PROBE = Object.freeze({
  ready: true, authMethod: 'claude.ai', version: '2.1.302', binary: 'claude', reason: null, strippedEnvKeys: [],
});
const TEST_ENV = Object.freeze({ PATH: '/usr/bin:/bin', HOME: '/home/tester' });
const CLEAN_META = Object.freeze({ malformedLines: 0, jsonSchemaDropped: false });

const initLine = () => ({
  type: 'system', subtype: 'init', session_id: 'sess-1', mcp_servers: [{ name: 'rks-agent-tools', status: 'connected' }],
});
const retryLine = (error) => ({ type: 'system', subtype: 'api_retry', attempt: 1, error });
const resultLine = (over = {}) => ({
  type: 'result',
  subtype: 'success',
  is_error: false,
  num_turns: 3,
  session_id: 'sess-1',
  total_cost_usd: 0.0123,
  duration_api_ms: 4567,
  result: '',
  modelUsage: { 'model-a': { inputTokens: 10, outputTokens: 2, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } },
  ...over,
});
const okResult = () => resultLine({ structured_output: { ok: true, answer: 'hi' } });
// 'request failed' matches none of the rate-limit result-text regex alternatives.
const errResult = (over = {}) => resultLine({
  is_error: true, subtype: 'error_during_execution', result: 'request failed', modelUsage: {}, ...over,
});
const toStdout = (lines) => lines.map((l) => JSON.stringify(l)).join('\n');

const OutputZ = z.object({ ok: z.boolean(), answer: z.string() });

function baseConfig(over = {}) {
  return {
    name: 'research',
    userMessage: 'What does module X do?',
    inputSchema: z.object({ query: z.string() }),
    rawInput: { query: 'What does module X do?' },
    outputSchema: OutputZ,
    model: 'claude-test-model-id',
    maxTurns: 7,
    projectId: 'proj-rl',
    projectRoot: '/nonexistent/proj-root',
    systemText: 'SYSTEM PROMPT UNDER TEST',
    ...over,
  };
}

// Injected child-process double: replays `lines` on stdout, then closes with `code`. Never starts a process.
function scriptedChild({ lines = [], code = 0, onCall = null } = {}) {
  return vi.fn((binary, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end: vi.fn() };
    child.kill = vi.fn(() => true);
    if (onCall) onCall({ binary, args, opts });
    setImmediate(() => {
      for (const l of lines) child.stdout.emit('data', `${typeof l === 'string' ? l : JSON.stringify(l)}\n`);
      child.emit('close', code, null);
    });
    return child;
  });
}

let base;
let collector;

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'rks-cli-rle-test-'));
  collector = { emit: vi.fn(), flush: vi.fn(async () => {}) };
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

const makeDeps = (impl, over = {}) => ({ probeResult: READY_PROBE, spawn: impl, env: TEST_ENV, tmpdir: base, collector, ...over });
const eventData = (suffix) => {
  const call = collector.emit.mock.calls.find(([type]) => type === `agent.research.${suffix}`);
  return call ? call[2] : undefined;
};
const streamOf = (over = {}) => ({ init: null, retries: [], result: null, rateLimit: null, malformedLines: 0, ...over });
const classify = (stream, exitCode) =>
  classifyCliFailure({ spawnError: null, timedOut: false, exitCode, stream, maxTurns: 7, timeoutMs: 10 });
const expectNoLeak = (value) => {
  const text = JSON.stringify(value);
  for (const s of LEAK_SENTINELS) expect(text, s).not.toContain(s);
};

// ---------------------------------------------------------------------------

describe('parseStreamJson: rate_limit_event', () => {
  it('rateLimit is null when no rate_limit_event line is present', () => {
    const out = parseStreamJson(toStdout([initLine(), okResult()]));
    expect(out.rateLimit).toBeNull();
    expect(out.result.type).toBe('result');
  });

  it('parseStreamJson(undefined) is exactly the five-key empty parse with rateLimit null', () => {
    expect(parseStreamJson(undefined)).toEqual({ init: null, retries: [], result: null, rateLimit: null, malformedLines: 0 });
  });

  it('stores the rate_limit_info of the observed 2.1.302 line and still captures init and result', () => {
    const out = parseStreamJson(toStdout([initLine(), rateLimitLine(OBSERVED_INFO), okResult()]));
    expect(out.rateLimit).toEqual(OBSERVED_INFO);
    expect(out.init.subtype).toBe('init');
    expect(out.result.type).toBe('result');
    expect(out.malformedLines).toBe(0);
  });

  it('the LAST rate_limit_event line wins', () => {
    const out = parseStreamJson(toStdout([rateLimitLine(OBSERVED_INFO), initLine(), rateLimitLine(LIMITED_INFO), okResult()]));
    expect(out.rateLimit).toEqual(LIMITED_INFO);
  });

  it('a rate_limit_event with missing, null or non-object rate_limit_info sets nothing and is not malformed', () => {
    const bad = [
      { type: 'rate_limit_event' },
      { type: 'rate_limit_event', rate_limit_info: null },
      { type: 'rate_limit_event', rate_limit_info: 'rejected' },
    ];
    const alone = parseStreamJson(toStdout(bad));
    expect(alone.rateLimit).toBeNull();
    expect(alone.malformedLines).toBe(0);
    expect(parseStreamJson(toStdout([rateLimitLine(OBSERVED_INFO), ...bad])).rateLimit).toEqual(OBSERVED_INFO);
  });
});

describe('summarizeRateLimit (whitelist projection)', () => {
  it('the observed 2.1.302 rate_limit_info projects to exactly the five whitelisted fields', () => {
    expect(summarizeRateLimit(OBSERVED_INFO)).toEqual(OBSERVED_SUMMARY);
  });

  it('injected identifiers and unknown fields never survive, at top level or inside unifiedWindows', () => {
    const info = {
      ...OBSERVED_INFO,
      uuid: EVENT_UUID,
      session_id: EVENT_SESSION,
      accountEmail: 'someone@example.invalid',
      organizationUuid: 'org-SENTINEL-77aa',
      unifiedWindows: {
        five_hour: { ...OBSERVED_INFO.unifiedWindows.five_hour, accountId: 'acct-SENTINEL-1f2e' },
        seven_day: OBSERVED_INFO.unifiedWindows.seven_day,
      },
    };
    const out = summarizeRateLimit(info);
    expect(out).toEqual(OBSERVED_SUMMARY);
    for (const key of Object.keys(out)) expect(WHITELIST).toContain(key);
    const text = JSON.stringify(out);
    const forbidden = [...LEAK_SENTINELS, 'someone@example.invalid', 'org-SENTINEL-77aa', 'acct-SENTINEL-1f2e', 'overageStatus', 'isUsingOverage'];
    for (const s of forbidden) expect(text, s).not.toContain(s);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'allowed'],
    ['a number', 42],
    ['a boolean', true],
  ])('%s returns null', (_label, info) => {
    expect(summarizeRateLimit(info)).toBeNull();
  });

  it('returns null when no whitelisted field has the right type', () => {
    expect(summarizeRateLimit({})).toBeNull();
    expect(summarizeRateLimit({
      status: 5,
      rateLimitType: null,
      resetsAt: '1792355400',
      unifiedWindows: { five_hour: { utilization: '0.5' }, seven_day: null },
    })).toBeNull();
  });

  it('drops non-finite numbers and tolerates a missing unifiedWindows', () => {
    expect(summarizeRateLimit({ status: 'allowed', resetsAt: Number.NaN, unifiedWindows: { five_hour: { utilization: Infinity } } }))
      .toEqual({ status: 'allowed' });
    expect(summarizeRateLimit({ status: 'allowed', resetsAt: RESETS_AT })).toEqual({ status: 'allowed', resetsAt: RESETS_AT });
  });
});

describe('isRateLimited', () => {
  it('is false for the observed "allowed" status', () => {
    expect(isRateLimited(OBSERVED_INFO)).toBe(false);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'rejected'],
    ['a number', 0],
    ['no status', {}],
    ['a numeric status', { status: 1 }],
    ['a null status', { status: null }],
  ])('%s is false', (_label, info) => {
    expect(isRateLimited(info)).toBe(false);
  });

  // ASSUMED SHAPE: allowed_warning is third-party-reported; it is a warning, not a limit.
  it('ASSUMED: status allowed_warning is false', () => {
    expect(isRateLimited(WARNING_INFO)).toBe(false);
    expect(isRateLimited({ status: 'allowed_warning' })).toBe(false);
  });

  it('an unknown string status is false', () => {
    expect(isRateLimited(UNKNOWN_STATUS_INFO)).toBe(false);
    expect(isRateLimited({ status: '' })).toBe(false);
  });

  // ASSUMED SHAPE: rejected is third-party-reported; not observed locally.
  it('ASSUMED: status rejected is true', () => {
    expect(isRateLimited(LIMITED_INFO)).toBe(true);
    expect(isRateLimited({ status: 'rejected' })).toBe(true);
  });
});

describe('classifyCliFailure with rate_limit_info', () => {
  it('ASSUMED limited status on a non-zero exit is rate_limit with resetsAt, with no api_retry line and non-matching text', () => {
    const f = classify(streamOf({ result: errResult(), rateLimit: LIMITED_INFO }), 1);
    expect(f.reason).toBe('rate_limit');
    expect(f.resetsAt).toBe(RESETS_AT);
    expect(f.error.startsWith('claude-cli rate_limit')).toBe(true);
    expect(f.capability).toBeUndefined();
  });

  it('ASSUMED limited status with is_error true at exit 0, and with no result line, is rate_limit with resetsAt', () => {
    expect(classify(streamOf({ result: errResult(), rateLimit: LIMITED_INFO }), 0)).toMatchObject({ reason: 'rate_limit', resetsAt: RESETS_AT });
    expect(classify(streamOf({ rateLimit: LIMITED_INFO }), 1)).toMatchObject({ reason: 'rate_limit', resetsAt: RESETS_AT });
  });

  it('ASSUMED limited status without a finite resetsAt is rate_limit with no resetsAt key', () => {
    const { resetsAt: _omitted, ...noReset } = LIMITED_INFO;
    for (const info of [noReset, { ...LIMITED_INFO, resetsAt: '1792355400' }, { ...LIMITED_INFO, resetsAt: Number.NaN }]) {
      const f = classify(streamOf({ result: errResult(), rateLimit: info }), 1);
      expect(f.reason).toBe('rate_limit');
      expect('resetsAt' in f).toBe(false);
    }
  });

  it('a limited status is evaluated before the auth and overload retry checks', () => {
    expect(classify(streamOf({ result: errResult(), retries: [retryLine('authentication_failed')], rateLimit: LIMITED_INFO }), 1).reason)
      .toBe('rate_limit');
    expect(classify(streamOf({ result: errResult(), retries: [retryLine('overloaded')], rateLimit: LIMITED_INFO }), 1).reason)
      .toBe('rate_limit');
  });

  it('an "allowed" status on a failed run does not make it rate_limit', () => {
    const f = classify(streamOf({ result: errResult(), rateLimit: OBSERVED_INFO }), 1);
    expect(f.reason).toBe('cli_error');
    expect('resetsAt' in f).toBe(false);
  });

  it('ASSUMED allowed_warning on a failed run stays cli_error, auth or overloaded, with no resetsAt', () => {
    const plain = classify(streamOf({ result: errResult(), rateLimit: WARNING_INFO }), 1);
    expect(plain.reason).toBe('cli_error');
    expect('resetsAt' in plain).toBe(false);
    const noResult = classify(streamOf({ rateLimit: WARNING_INFO }), 1);
    expect(noResult.reason).toBe('cli_error');
    expect('resetsAt' in noResult).toBe(false);
    const auth = classify(streamOf({ result: errResult(), retries: [retryLine('authentication_failed')], rateLimit: WARNING_INFO }), 1);
    expect(auth.reason).toBe('auth');
    expect('resetsAt' in auth).toBe(false);
    const overloaded = classify(streamOf({ result: errResult(), retries: [retryLine('overloaded')], rateLimit: WARNING_INFO }), 1);
    expect(overloaded.reason).toBe('overloaded');
    expect('resetsAt' in overloaded).toBe(false);
  });

  it('an unknown status on a failed run stays cli_error with no resetsAt', () => {
    const f = classify(streamOf({ result: errResult(), rateLimit: UNKNOWN_STATUS_INFO }), 1);
    expect(f.reason).toBe('cli_error');
    expect('resetsAt' in f).toBe(false);
  });

  it('a successful run is never reclassified, whatever the status or utilization', () => {
    const highUse = {
      ...OBSERVED_INFO,
      unifiedWindows: {
        five_hour: { utilization: 0.99, resetsAt: RESETS_AT },
        seven_day: { utilization: 0.99, resetsAt: SEVEN_DAY_RESETS_AT },
      },
    };
    expect(classify(streamOf({ result: resultLine(), rateLimit: highUse }), 0)).toBeNull();
    expect(classify(streamOf({ result: resultLine(), rateLimit: LIMITED_INFO }), 0)).toBeNull();
  });

  it('error_max_turns stays a capability failure even with a limited status', () => {
    const f = classify(streamOf({ result: errResult({ subtype: 'error_max_turns' }), rateLimit: LIMITED_INFO }), 1);
    expect(f).toMatchObject({ reason: 'max_turns', capability: true });
  });

  it('existing triggers still classify rate_limit and carry no resetsAt without a limited rate_limit_info', () => {
    const viaRetry = classify(streamOf({ result: errResult(), retries: [retryLine('rate_limit')] }), 1);
    expect(viaRetry.reason).toBe('rate_limit');
    expect('resetsAt' in viaRetry).toBe(false);
    const viaRetryAllowed = classify(streamOf({ result: errResult(), retries: [retryLine('rate_limit')], rateLimit: OBSERVED_INFO }), 1);
    expect(viaRetryAllowed.reason).toBe('rate_limit');
    expect('resetsAt' in viaRetryAllowed).toBe(false);
    const viaText = classify(streamOf({ result: errResult({ result: 'You have hit your usage limit' }) }), 1);
    expect(viaText.reason).toBe('rate_limit');
    expect('resetsAt' in viaText).toBe(false);
  });
});

describe('runClaudeCliAgent: resetsAt propagation and sanitized rateLimit telemetry', () => {
  it('ASSUMED limited failure returns backendFailure reason + resetsAt and a sanitized rateLimit on the failed event', async () => {
    const impl = scriptedChild({ lines: [initLine(), rateLimitLine(LIMITED_INFO), errResult()], code: 1 });
    const res = await runClaudeCliAgent(baseConfig(), makeDeps(impl));
    expect(res.ok).toBe(false);
    expect(res.backendFailure).toEqual({ reason: 'rate_limit', resetsAt: RESETS_AT });
    expect(res.backendMeta).toEqual(CLEAN_META);
    const failed = eventData('failed');
    expect(failed.error).toBe('rate_limit');
    expect(failed.rateLimit).toEqual(LIMITED_SUMMARY);
    expectNoLeak(failed);
    expectNoLeak(res);
    expect(fs.readdirSync(base)).toEqual([]);
  });

  it('a successful run with the observed line keeps clean backendMeta and records the sanitized rateLimit on complete', async () => {
    const impl = scriptedChild({ lines: [initLine(), rateLimitLine(OBSERVED_INFO), okResult()] });
    const res = await runClaudeCliAgent(baseConfig(), makeDeps(impl));
    expect(res).toMatchObject({ ok: true, answer: 'hi' });
    expect(res.backendFailure).toBeUndefined();
    expect(res.backendMeta).toEqual(CLEAN_META);
    const complete = eventData('complete');
    expect(complete.rateLimit).toEqual(OBSERVED_SUMMARY);
    // Pre-existing field from the result line (out of scope here), not the rate_limit_event's session_id.
    expect(complete.sessionId).toBe('sess-1');
    expectNoLeak(complete);
    expectNoLeak(res);
    expect('rateLimit' in eventData('started')).toBe(false);
  });

  it('ASSUMED limited status on a successful run is not a failure', async () => {
    const impl = scriptedChild({ lines: [initLine(), rateLimitLine(LIMITED_INFO), okResult()] });
    const res = await runClaudeCliAgent(baseConfig(), makeDeps(impl));
    expect(res).toMatchObject({ ok: true, answer: 'hi' });
    expect(res.backendFailure).toBeUndefined();
    expect(eventData('failed')).toBeUndefined();
  });

  it('ASSUMED allowed_warning failure returns backendFailure cli_error with no resetsAt', async () => {
    const impl = scriptedChild({ lines: [initLine(), rateLimitLine(WARNING_INFO), errResult()], code: 1 });
    const res = await runClaudeCliAgent(baseConfig(), makeDeps(impl));
    expect(res.ok).toBe(false);
    expect(res.backendFailure).toEqual({ reason: 'cli_error' });
    expect('resetsAt' in res.backendFailure).toBe(false);
    expect(res.backendMeta).toEqual(CLEAN_META);
    const failed = eventData('failed');
    expect(failed.error).toBe('cli_error');
    expect(failed.rateLimit).toEqual({ ...OBSERVED_SUMMARY, status: 'allowed_warning' });
    expectNoLeak(failed);
    expectNoLeak(res);
  });

  it('with no rate_limit_event the rateLimit key is omitted from complete and failed', async () => {
    const ok = scriptedChild({ lines: [initLine(), okResult()] });
    await runClaudeCliAgent(baseConfig(), makeDeps(ok));
    expect('rateLimit' in eventData('complete')).toBe(false);

    collector.emit.mockClear();
    const limited = scriptedChild({ lines: [initLine(), retryLine('rate_limit'), errResult()], code: 1 });
    const res = await runClaudeCliAgent(baseConfig(), makeDeps(limited));
    expect(res.backendFailure).toEqual({ reason: 'rate_limit' });
    expect('rateLimit' in eventData('failed')).toBe(false);
  });

  it('the unavailable and executor_error backendFailure shapes are unchanged with a rate_limit_event on the stream', async () => {
    const refused = scriptedChild({ lines: [rateLimitLine(LIMITED_INFO)] });
    const r1 = await runClaudeCliAgent(baseConfig(), makeDeps(refused, { probeResult: undefined }));
    expect(r1.backendFailure).toEqual({ reason: 'unavailable' });
    expect(refused).not.toHaveBeenCalled();

    const writeOutcome = ({ opts }) => {
      const cfg = JSON.parse(fs.readFileSync(path.join(opts.cwd, 'mcp-config.json'), 'utf8'));
      const serverArgs = cfg.mcpServers['rks-agent-tools'].args;
      fs.writeFileSync(serverArgs[serverArgs.indexOf('--outcomes-file') + 1], '{"outcome":"healthy"}\n');
    };
    const throwing = scriptedChild({ lines: [initLine(), rateLimitLine(OBSERVED_INFO), okResult()], onCall: writeOutcome });
    const config = baseConfig({ _retrieval: { record: () => { throw new Error('record exploded'); } } });
    const r2 = await runClaudeCliAgent(config, makeDeps(throwing));
    expect(r2.backendFailure).toEqual({ reason: 'executor_error' });
    expect(r2.backendMeta).toEqual(CLEAN_META);
  });
});
