/**
 * claude CLI readiness probe (backlog.feat.agent-backend-selection-research; filed originally as
 * backlog.feat.claude-cli-probe, absorbed 2026-10-17)
 *
 * Answers one question before rks spawns `claude -p` on the user's subscription: will that child
 * bill the Claude subscription and not the Anthropic API?
 *
 * Claude Code ranks cloud-provider flags, ANTHROPIC_AUTH_TOKEN, ANTHROPIC_API_KEY, apiKeyHelper,
 * CLAUDE_CODE_OAUTH_TOKEN and Anthropic profile/federation credentials ABOVE the subscription
 * /login credential (code.claude.com/docs/en/authentication, "Authentication precedence"), and in
 * -p mode an ANTHROPIC_API_KEY "is always used when present". The rks MCP server holds
 * ANTHROPIC_API_KEY, so a child spawned with the inherited environment would bill the API.
 * buildSubscriptionEnv() removes every environment credential source; probeClaudeCli() then asks
 * the binary itself (`claude auth status`, same stripped environment) which credential it would
 * use, and reports ready only for authMethod "claude.ai". apiKeyHelper lives in a settings file,
 * not the environment, so only the authMethod check can catch it.
 */
import os from 'os';
import { execFile } from 'child_process';

export const MIN_CLAUDE_VERSION = '2.1.259'; // --permission-prompts floor (cli-reference)
export const SUBSCRIPTION_AUTH_METHODS = Object.freeze(['claude.ai']);
export const STRIPPED_ENV_PREFIXES = Object.freeze(['ANTHROPIC_', 'CLAUDE_CODE_USE_']);
export const STRIPPED_ENV_KEYS = Object.freeze(['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_SIMPLE']);
export const DEFAULT_PROBE_TTL_MS = 10 * 60_000;
const DEFAULT_PROBE_TIMEOUT_MS = 15_000;

export function isStrippedEnvKey(key) {
  return STRIPPED_ENV_KEYS.includes(key) || STRIPPED_ENV_PREFIXES.some((p) => key.startsWith(p));
}

/** Copy of parentEnv without any credential source. Names of removed keys only — never values. */
export function buildSubscriptionEnv(parentEnv = process.env) {
  const env = {};
  const stripped = [];
  for (const [key, value] of Object.entries(parentEnv || {})) {
    if (value === undefined) continue;
    if (isStrippedEnvKey(key)) {
      stripped.push(key);
      continue;
    }
    env[key] = value;
  }
  return { env, stripped: stripped.sort() };
}

export function parseClaudeVersion(text) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(text || ''));
  return m ? `${m[1]}.${m[2]}.${m[3]}` : null;
}

export function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** Default runner. Resolves (never rejects) to { code, stdout, stderr, error }. */
export function defaultRun(cmd, args, { env, cwd, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { env, cwd, timeout: timeoutMs, maxBuffer: 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      const out = String(stdout || '');
      const errText = String(stderr || '');
      if (err && typeof err.code !== 'number') {
        resolve({ code: null, stdout: out, stderr: errText, error: err });
        return;
      }
      resolve({ code: err ? err.code : 0, stdout: out, stderr: errText, error: null });
    });
  });
}

export async function probeClaudeCli({
  run = defaultRun,
  parentEnv = process.env,
  binary = (parentEnv && parentEnv.RKS_CLAUDE_BIN) || 'claude',
  minVersion = MIN_CLAUDE_VERSION,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
  cwd = os.tmpdir(),
} = {}) {
  const { env, stripped } = buildSubscriptionEnv(parentEnv);
  const base = { ready: false, binary, version: null, authMethod: null, strippedEnvKeys: stripped };
  const opts = { env, cwd, timeoutMs };

  const v = await run(binary, ['--version'], opts);
  if (v.error) {
    const reason = v.error.code === 'ENOENT' ? 'binary_not_found' : 'version_failed';
    return { ...base, reason, detail: v.error.message };
  }
  if (v.code !== 0) return { ...base, reason: 'version_failed', detail: String(v.stderr || '').trim().slice(0, 200) };
  const version = parseClaudeVersion(v.stdout);
  if (!version) return { ...base, reason: 'version_unparseable' };
  if (compareVersions(version, minVersion) < 0) {
    return { ...base, version, reason: 'version_too_old', detail: `requires >= ${minVersion}` };
  }

  // `claude auth status` exits 1 when not logged in but still prints JSON: parse stdout regardless.
  const a = await run(binary, ['auth', 'status'], opts);
  if (a.error) return { ...base, version, reason: 'auth_status_failed', detail: a.error.message };
  let status;
  try {
    status = JSON.parse(a.stdout);
  } catch {
    return { ...base, version, reason: 'auth_status_unparseable' };
  }
  const authMethod = typeof status?.authMethod === 'string' ? status.authMethod : null;
  if (!authMethod || !SUBSCRIPTION_AUTH_METHODS.includes(authMethod)) {
    return { ...base, version, authMethod, reason: 'not_subscription_auth' };
  }
  return { ...base, ready: true, version, authMethod, reason: null };
}

/** One cached probe result per TTL; concurrent callers share one in-flight probe. */
export function createProbeCache({ probe = probeClaudeCli, ttlMs = DEFAULT_PROBE_TTL_MS, now = Date.now } = {}) {
  let cached = null;
  let at = 0;
  let inflight = null;
  return {
    async get(opts) {
      if (cached && now() - at < ttlMs) return cached;
      if (!inflight) {
        inflight = Promise.resolve()
          .then(() => probe(opts))
          .catch((err) => ({ ready: false, reason: 'probe_error', detail: err?.message || String(err) }))
          .then((result) => {
            cached = result;
            at = now();
            inflight = null;
            return result;
          });
      }
      return inflight;
    },
    invalidate() {
      cached = null;
      at = 0;
    },
    peek() {
      return cached;
    },
  };
}
