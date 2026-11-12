/**
 * Process-wide claude -p gate: one probe cache, one cool-down and one concurrency counter shared
 * by the research agent dispatcher and the one-shot backend, so a subscription rate limit seen
 * on either path cools down both.
 */
import { createProbeCache } from './probe.mjs';

// Moved here from the research dispatcher module, which re-exports every name below unchanged.
export const DEFAULT_COOLDOWN_MS = 15 * 60_000;
// Upper bound on a resetsAt-sized rate-limit cool-down (design choice; next attempt re-detects).
export const MAX_RATE_LIMIT_COOLDOWN_MS = 6 * 60 * 60_000;
export const DEFAULT_MAX_CONCURRENT = 2;
export const COOLDOWN_REASONS = Object.freeze(['rate_limit', 'auth', 'unavailable']);
// With NO API credential there is nothing to fall back to, so a cool-down would only lock the
// subscription path out after the user fixes their login (up to DEFAULT_COOLDOWN_MS). Only a rate
// limit is worth waiting out; 'auth' and 'unavailable' invalidate the probe cache instead, so the
// next call re-probes (backlog.feat.keyless-backend-aware-credential-presence, AC8).
export const NO_FALLBACK_COOLDOWN_REASONS = Object.freeze(['rate_limit']);

/** Whether a failure reason opens the shared cool-down, given whether an API fallback exists. */
export function opensCooldown(reason, { apiFallback = true } = {}) {
  return (apiFallback ? COOLDOWN_REASONS : NO_FALLBACK_COOLDOWN_REASONS).includes(reason);
}

// resetsAt is epoch SECONDS (inferred from one captured claude 2.1.302 line).
export function cooldownMsFor(failure, nowMs, defaultMs = DEFAULT_COOLDOWN_MS) {
  if (failure?.reason !== 'rate_limit' || !Number.isFinite(failure.resetsAt)) return defaultMs;
  const ms = failure.resetsAt * 1000 - nowMs;
  return ms > 0 ? Math.min(ms, MAX_RATE_LIMIT_COOLDOWN_MS) : defaultMs;
}

export function createClaudeCliGate({
  probeCache = createProbeCache(),
  now = Date.now,
  cooldownMs = DEFAULT_COOLDOWN_MS,
  maxConcurrent = DEFAULT_MAX_CONCURRENT,
} = {}) {
  let cooldownUntil = 0;
  let cooldownReason = null;
  let inFlight = 0;
  return {
    probeCache,
    // Exposed so every path sizes and stamps cool-downs on the same clock and default duration.
    now,
    cooldownMs,
    inCooldown: () => now() < cooldownUntil,
    cooldownReason: () => cooldownReason,
    openCooldown(reason, durationMs = cooldownMs) {
      cooldownUntil = now() + durationMs;
      cooldownReason = reason;
    },
    tryAcquire() {
      if (inFlight >= maxConcurrent) return false;
      inFlight++;
      return true;
    },
    release() {
      inFlight = Math.max(0, inFlight - 1);
    },
    state: () => ({ cooldownUntil, cooldownReason, inFlight }),
  };
}

let _defaultGate = null;

export function getDefaultClaudeCliGate() {
  if (!_defaultGate) _defaultGate = createClaudeCliGate();
  return _defaultGate;
}

export function resetDefaultClaudeCliGate() {
  _defaultGate = null;
}
