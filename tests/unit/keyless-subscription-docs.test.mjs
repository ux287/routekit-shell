/**
 * backlog.feat.keyless-backend-aware-credential-presence - AC11, AC12.
 * backlog.fix.subscription-docs-accuracy - AC1-AC7 (stale pins inverted, corrected text pinned).
 * Durable-phrase toMatch checks over CLAUDE.md, README.md and notes/public.canon.rks-config.md.
 * Doc-shaped: regex matches only, no fixtures.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');

function keylessSection() {
  const src = read('CLAUDE.md');
  const at = src.indexOf('\n## Keyless Mode\n');
  expect(at).toBeGreaterThan(-1);
  const end = src.indexOf('\n## ', at + 1);
  return src.slice(at, end === -1 ? undefined : end);
}

describe('docs (AC11, AC12; backlog.fix.subscription-docs-accuracy AC1-AC7)', () => {
  it('CLAUDE.md Keyless Mode: three states, the opt-in, subscription flows, per-call hooks, TTL fallback and re-probe, instruction-level Governor ban', () => {
    const s = keylessSection();
    expect(s).toMatch(/three credential states/i);
    expect(s).toMatch(/\*\*Keyed\*\*/);
    expect(s).toMatch(/\*\*Subscription\*\*/);
    expect(s).toMatch(/\*\*Keyless\*\*/);
    expect(s).toMatch(/RKS_SUBSCRIPTION_CREDENTIAL=1/);
    expect(s).not.toMatch(/every flow except on-rail Build/i);
    expect(s).toMatch(/Hooks evaluate per call/i);
    expect(s).toMatch(/server reads its env at boot/i);
    expect(s).toMatch(/falls back to keyless once the status file passes its TTL/i);
    expect(s).toMatch(/starting any Governor re-probes and restores the subscription state/i);
    expect(s).toMatch(/instruction-level and not hook-enforced/i);
    // The old unconditional restart line is corrected.
    expect(s).not.toMatch(/It takes effect on the next MCP restart\./);
  });

  it('CLAUDE.md Keyless Mode: on-rail Build admission, external-research, report-only capabilities, boot-time opt-in (AC1, AC2, AC4, AC5)', () => {
    const s = keylessSection();
    // AC1
    expect(s).toMatch(/on-rail Build is admitted/i);
    expect(s).toMatch(/first unadmitted agent/i);
    expect(s).toContain('llm-planner');
    expect(s).toContain('reviewer');
    expect(s).toContain('qa-agent');
    expect(s).not.toMatch(/On-rail Build is blocked \(its planner/);
    // AC2
    expect(s).toMatch(/external-research`? is admitted/i);
    expect(s).not.toMatch(/external research is reported blocked on its own/i);
    // AC4
    expect(s).not.toMatch(/a flow it reports `blocked` is not run/);
    expect(s).toMatch(/report-only/i);
    expect(s).toMatch(/subscription_unavailable/);
    expect(s).toMatch(/instruction-level and not hook-enforced/i);
    // AC5
    expect(s).not.toMatch(/read by the server at each `rks_governor_init`/);
    expect(s).toMatch(/at MCP boot/i);
    expect(s).toMatch(/absent at boot/i);
  });

  it('README.md describes a subscription-only setup path and which flows work', () => {
    const r = read('README.md');
    expect(r).toMatch(/subscription-only setup/i);
    expect(r).toMatch(/claude\.ai/);
    expect(r).toMatch(/2\.1\.293 or later/);
    expect(r).toMatch(/RKS_SUBSCRIPTION_CREDENTIAL=1/);
    expect(r).toMatch(/\.rks\/agents\.yaml/);
    expect(r).toMatch(/backend: claude-cli/);
    expect(r).not.toMatch(/every flow except on-rail Build/i);
  });

  it('README.md: on-rail Build admission, agents.yaml backends, external-research, ROUTEKIT_LLM_MODEL (AC1, AC2, AC3, AC6)', () => {
    const r = read('README.md');
    // AC1
    expect(r).toMatch(/on-rail Build is admitted/i);
    expect(r).toMatch(/first unadmitted agent/i);
    expect(r).not.toMatch(/On-rail Build needs `ANTHROPIC_API_KEY`/);
    // AC2
    expect(r).toMatch(/external-research`? is admitted/i);
    expect(r).not.toMatch(/external research is unavailable/i);
    // AC3
    expect(r).toMatch(/llm-planner[\s\S]{0,120}reviewer[\s\S]{0,120}qa-agent/);
    // AC6
    expect(r).toMatch(/ROUTEKIT_LLM_MODEL/);
    expect(r).toMatch(/claude --model/);
  });

  it('public.canon.rks-config.md: the key is required only for on-rail Build and API-only agents; a claude-cli backend section exists', () => {
    const c = read('notes/public.canon.rks-config.md');
    expect(c).not.toContain('Powers all Governors (required if using Anthropic)');
    expect(c).not.toContain('add ANTHROPIC_API_KEY (required)');
    expect(c).not.toMatch(/required for on-rail Build and API-only agents/i);
    expect(c).toMatch(/^###\s+claude-cli backend/m);
    expect(c).toMatch(/RKS_SUBSCRIPTION_CREDENTIAL=1/);
  });

  it('public.canon.rks-config.md: on-rail Build admission, external-research, ROUTEKIT_LLM_MODEL (AC1, AC2, AC6)', () => {
    const c = read('notes/public.canon.rks-config.md');
    // AC1
    expect(c).toMatch(/on-rail Build is admitted/i);
    expect(c).toMatch(/first unadmitted agent/i);
    expect(c).not.toContain('blocked: llm-planner');
    expect(c).not.toMatch(/needed for on-rail Build and API-only agents/i);
    // AC2
    expect(c).toMatch(/external-research`? is admitted/i);
    // AC6
    expect(c).toMatch(/ROUTEKIT_LLM_MODEL/);
    expect(c).toMatch(/claude --model/);
    expect(c).not.toContain('claude-sonnet-4-6');
  });
});
