import assert from 'node:assert';
import { describe, it } from 'node:test';

// Helper to build a mock fetch that returns the given check-runs data
function mockFetch(responses) {
  let callIndex = 0;
  const fn = async () => {
    const data = typeof responses === 'function' ? responses(callIndex) : responses;
    callIndex++;
    return { ok: true, json: async () => data };
  };
  fn.callCount = () => callIndex;
  return fn;
}

function mockFetchError(status) {
  return async () => ({ ok: false, status, json: async () => ({}) });
}

describe('pollCiStatus', () => {
  // Fresh import per test to avoid module cache issues with mocks
  async function loadModule() {
    // Dynamic import with cache-bust to get fresh module
    const mod = await import('../src/server/ci-polling.mjs');
    return mod.pollCiStatus;
  }

  it('returns pass when all check-runs succeed', async () => {
    const pollCiStatus = await loadModule();
    const fetch = mockFetch({
      total_count: 2,
      check_runs: [
        { name: 'build', status: 'completed', conclusion: 'success', html_url: 'https://github.com/test/run/1' },
        { name: 'lint', status: 'completed', conclusion: 'success', html_url: 'https://github.com/test/run/2' },
      ],
    });

    const result = await pollCiStatus('owner', 'repo', 'abc123', 'token', {
      fetch,
      pollIntervalMs: 1,
      timeoutMs: 1000,
    });

    assert.strictEqual(result.status, 'pass');
    assert.strictEqual(result.conclusion, 'success');
    assert.strictEqual(result.url, 'https://github.com/test/run/1');
  });

  it('returns pass when checks are success or skipped', async () => {
    const pollCiStatus = await loadModule();
    const fetch = mockFetch({
      total_count: 2,
      check_runs: [
        { name: 'build', status: 'completed', conclusion: 'success', html_url: 'https://github.com/test/run/1' },
        { name: 'optional', status: 'completed', conclusion: 'skipped', html_url: 'https://github.com/test/run/2' },
      ],
    });

    const result = await pollCiStatus('owner', 'repo', 'abc123', 'token', {
      fetch,
      pollIntervalMs: 1,
      timeoutMs: 1000,
    });

    assert.strictEqual(result.status, 'pass');
  });

  it('returns fail when a check-run fails', async () => {
    const pollCiStatus = await loadModule();
    const fetch = mockFetch({
      total_count: 2,
      check_runs: [
        { name: 'build', status: 'completed', conclusion: 'success', html_url: 'https://github.com/test/run/1' },
        { name: 'tests', status: 'completed', conclusion: 'failure', html_url: 'https://github.com/test/run/2' },
      ],
    });

    const result = await pollCiStatus('owner', 'repo', 'abc123', 'token', {
      fetch,
      pollIntervalMs: 1,
      timeoutMs: 1000,
    });

    assert.strictEqual(result.status, 'fail');
    assert.strictEqual(result.conclusion, 'failure');
    assert.strictEqual(result.name, 'tests');
    assert.strictEqual(result.url, 'https://github.com/test/run/2');
  });

  it('polls until checks complete', async () => {
    const pollCiStatus = await loadModule();
    let callCount = 0;
    const fetch = mockFetch((index) => {
      callCount = index + 1;
      if (index < 2) {
        return {
          total_count: 1,
          check_runs: [{ name: 'ci', status: 'in_progress', conclusion: null }],
        };
      }
      return {
        total_count: 1,
        check_runs: [{ name: 'ci', status: 'completed', conclusion: 'success', html_url: 'https://github.com/test/run/3' }],
      };
    });

    const result = await pollCiStatus('owner', 'repo', 'abc123', 'token', {
      fetch,
      pollIntervalMs: 1,
      timeoutMs: 5000,
    });

    assert.strictEqual(result.status, 'pass');
    assert(callCount >= 3, `Expected at least 3 polls, got ${callCount}`);
  });

  it('returns pending on timeout', async () => {
    const pollCiStatus = await loadModule();
    const fetch = mockFetch({
      total_count: 1,
      check_runs: [{ name: 'ci', status: 'in_progress', conclusion: null }],
    });

    const result = await pollCiStatus('owner', 'repo', 'abc123', 'token', {
      fetch,
      pollIntervalMs: 10,
      timeoutMs: 30,
    });

    assert.strictEqual(result.status, 'pending');
    assert.strictEqual(result.conclusion, null);
  });

  it('waits when no checks registered yet', async () => {
    const pollCiStatus = await loadModule();
    let callCount = 0;
    const fetch = mockFetch((index) => {
      callCount = index + 1;
      if (index === 0) {
        return { total_count: 0, check_runs: [] };
      }
      return {
        total_count: 1,
        check_runs: [{ name: 'ci', status: 'completed', conclusion: 'success', html_url: 'url' }],
      };
    });

    const result = await pollCiStatus('owner', 'repo', 'abc123', 'token', {
      fetch,
      pollIntervalMs: 1,
      timeoutMs: 5000,
    });

    assert.strictEqual(result.status, 'pass');
    assert(callCount >= 2, 'Should have polled at least twice');
  });

  it('returns fail on API error', async () => {
    const pollCiStatus = await loadModule();
    const fetch = mockFetchError(403);

    const result = await pollCiStatus('owner', 'repo', 'abc123', 'token', {
      fetch,
      pollIntervalMs: 1,
      timeoutMs: 1000,
    });

    assert.strictEqual(result.status, 'fail');
    assert.strictEqual(result.conclusion, 'api_error_403');
  });
});
