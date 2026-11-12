/**
 * CI Polling Utility
 *
 * Polls GitHub Actions check-runs for a given commit SHA until all checks
 * complete (pass/fail) or a timeout is reached.
 *
 * Uses the GitHub REST API: GET /repos/{owner}/{repo}/commits/{ref}/check-runs
 * Accepts an injectable `fetch` for testing.
 */

const DEFAULT_POLL_INTERVAL_MS = 10_000; // 10 seconds
const DEFAULT_TIMEOUT_MS = 300_000;      // 5 minutes

/**
 * @param {string} owner - GitHub repo owner
 * @param {string} repo  - GitHub repo name
 * @param {string} sha   - Commit SHA to check
 * @param {string} token - GitHub token (PAT or installation token)
 * @param {object} [opts]
 * @param {function} [opts.fetch]           - Injectable fetch (defaults to global fetch)
 * @param {number}   [opts.pollIntervalMs]  - Polling interval (default 10s)
 * @param {number}   [opts.timeoutMs]       - Timeout (default 5min)
 * @returns {Promise<{ status: 'pass'|'fail'|'pending', conclusion: string|null, url: string|null, name: string|null }>}
 */
export async function pollCiStatus(owner, repo, sha, token, opts = {}) {
  const fetchFn = opts.fetch || globalThis.fetch;
  const pollInterval = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const url = `https://api.github.com/repos/${owner}/${repo}/commits/${sha}/check-runs`;
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
  };

  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const res = await fetchFn(url, { headers });

    if (!res.ok) {
      return {
        status: 'fail',
        conclusion: `api_error_${res.status}`,
        url: null,
        name: null,
      };
    }

    const data = await res.json();
    const runs = data.check_runs || [];

    if (runs.length === 0) {
      // No checks registered yet — wait and retry
      await sleep(pollInterval);
      continue;
    }

    // Check if all runs are completed
    const allCompleted = runs.every(r => r.status === 'completed');

    if (allCompleted) {
      // Find the first failure, or report overall success
      const failed = runs.find(r => r.conclusion !== 'success' && r.conclusion !== 'skipped');
      if (failed) {
        return {
          status: 'fail',
          conclusion: failed.conclusion,
          url: failed.html_url || null,
          name: failed.name || null,
        };
      }
      // All passed or skipped
      const first = runs[0];
      return {
        status: 'pass',
        conclusion: 'success',
        url: first.html_url || null,
        name: first.name || null,
      };
    }

    // Still in progress — wait and poll again
    await sleep(pollInterval);
  }

  // Timeout reached
  return {
    status: 'pending',
    conclusion: null,
    url: null,
    name: null,
  };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
