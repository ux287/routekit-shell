/**
 * backlog.fix.agent-run-strict-input-and-delivery-guard
 *
 * THE INCIDENT: `rks_agent_run` was called with `command`/`request` fields targeting the
 * delivery agent. Zod's default object parsing STRIPS unknown keys, so those fields
 * vanished silently — the call looked accepted. With `storyIds` now absent, delivery fell
 * through to auto-discovering every ready story and began real, branch-mutating work,
 * running until the MCP call aborted at 1800s.
 *
 * Strictness is enforced at the DISPATCH layer (registry.parseAgentInput), which is the
 * single choke point both dispatch routes travel through.
 *
 * Run:
 *   npx vitest run --config vitest.config.unit.mjs tests/unit/agent-run-strict-input.test.mjs
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAgentInput, listAgents, getAgentByToolName } from '../../packages/mcp-rks/src/agents/registry.mjs';
import { AUTO_DISCOVER_MAX } from '../../packages/mcp-rks/src/agents/delivery.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('strict input — unknown keys are rejected, not stripped', () => {
  it('THE WITNESSED CASE: delivery + command/request is rejected', () => {
    const r = parseAgentInput('delivery', {
      projectId: 'p',
      command: 'node scripts/sync-hooks.mjs --check',
      request: 'run this',
    });
    expect(r.ok).toBe(false);
    expect(r.error.unknownKeys).toEqual(expect.arrayContaining(['command', 'request']));
  });

  it('ERROR NAMES THE KEY — a bare "invalid input" would be a diagnosability regression', () => {
    const r = parseAgentInput('delivery', { projectId: 'p', command: 'x' });
    expect(r.error.message).toContain('command');
  });

  it('ERROR NAMES THE AGENT AND THE ACCEPTED KEYS', () => {
    const r = parseAgentInput('delivery', { projectId: 'p', bogus: 1 });
    expect(r.error.agent).toBe('delivery');
    expect(r.error.acceptedKeys).toEqual(expect.arrayContaining(['projectId', 'storyIds', 'dryRun']));
    expect(r.error.message).toContain('delivery');
  });

  it('MACHINE-DETECTABLE — structured fields, not prose matching', () => {
    const r = parseAgentInput('delivery', { projectId: 'p', bogus: 1 });
    expect(r.error.error).toBe('invalid_agent_input');
    expect(Array.isArray(r.error.unknownKeys)).toBe(true);
    expect(Array.isArray(r.error.acceptedKeys)).toBe(true);
  });

  it('REGISTRY-WIDE, TABLE-DRIVEN — every registered agent rejects unknown keys', () => {
    const agents = listAgents();
    expect(agents.length).toBeGreaterThanOrEqual(11);

    for (const name of agents) {
      const r = parseAgentInput(name, { projectId: 'p', __definitely_not_a_key__: 1 });
      // An agent with no registered schema legitimately passes through; everything
      // with a schema must reject. Enumerating at runtime means a 12th agent is
      // covered automatically and cannot silently opt out.
      if (r.ok) {
        expect(r.data).toHaveProperty('__definitely_not_a_key__');
      } else {
        expect(r.error.unknownKeys, `agent ${name}`).toContain('__definitely_not_a_key__');
      }
    }
  });

  it('BACK-COMPAT — well-formed input still parses', () => {
    const r = parseAgentInput('delivery', { projectId: 'p', storyIds: ['backlog.x'], dryRun: true });
    expect(r.ok).toBe(true);
    expect(r.data.storyIds).toEqual(['backlog.x']);
  });

  it('BACK-COMPAT — omitting optional keys still succeeds', () => {
    const r = parseAgentInput('delivery', { projectId: 'p' });
    expect(r.ok).toBe(true);
  });

  it('CONVENIENCE-TOOL PARITY — the tool-name route resolves the same agent', () => {
    // Both dispatch paths must gate identically; the convenience route looks the agent
    // up by toolName and then validates through the same function.
    const entry = getAgentByToolName('rks_agent_validate_story');
    expect(entry).toBeTruthy();
    const r = parseAgentInput(entry.name, { projectId: 'p', problemId: 'backlog.x', bogus: 1 });
    expect(r.ok).toBe(false);
    expect(r.error.unknownKeys).toContain('bogus');
  });

  it('the product-owner convenience payload is VALID — problemId is its real field', () => {
    // Guards against "fixing" redirect-validate-story-to-agent.mjs, which correctly
    // sends { projectId, problemId }. StoryInputSchema's storyId belongs to a different tool.
    const entry = getAgentByToolName('rks_agent_validate_story');
    const r = parseAgentInput(entry.name, { projectId: 'p', problemId: 'backlog.x' });
    expect(r.ok).toBe(true);
  });
});

describe('delivery auto-discovery guard', () => {
  it('autoDiscover is an accepted, optional key', () => {
    expect(parseAgentInput('delivery', { projectId: 'p', autoDiscover: true }).ok).toBe(true);
    expect(parseAgentInput('delivery', { projectId: 'p' }).ok).toBe(true);
  });

  it('storyIds stays OPTIONAL — the read-only preview path is one call away', () => {
    // Ruling tripwire: making storyIds required would invert a correctly-named
    // existing test and break legitimate "what is shippable?" calls.
    const r = parseAgentInput('delivery', { projectId: 'p' });
    expect(r.ok).toBe(true);
  });

  it('dryRun stays a MODE, not an authorization', () => {
    expect(parseAgentInput('delivery', { projectId: 'p', dryRun: false }).ok).toBe(true);
  });

  it('AUTO-DISCOVERY IS BOUNDED — a hard numeric cap exists', () => {
    expect(typeof AUTO_DISCOVER_MAX).toBe('number');
    expect(AUTO_DISCOVER_MAX).toBeGreaterThan(0);
    expect(AUTO_DISCOVER_MAX).toBeLessThanOrEqual(25);
  });

  it('list_ready_stories applies the cap and reports what it withheld', () => {
    const src = fs.readFileSync(
      path.join(PROJECT_ROOT, 'packages/mcp-rks/src/agents/delivery.mjs'),
      'utf8',
    );
    expect(src).toContain('AUTO_DISCOVER_MAX');
    expect(src).toMatch(/slice\(0,\s*AUTO_DISCOVER_MAX\)/);
    expect(src).toContain('totalFound');
  });

  it('PROMPT NO LONGER INSTRUCTS UNCONDITIONAL DISCOVERY', () => {
    const src = fs.readFileSync(
      path.join(PROJECT_ROOT, 'packages/mcp-rks/src/agents/delivery.mjs'),
      'utf8',
    );
    // Durable full-source assertions — not a fixed-window slice.
    expect(src).not.toMatch(/If no story IDs provided: call list_ready_stories to discover what to ship/);
    expect(src).toMatch(/autoDiscover is NOT set: STOP/);
  });
});

describe('HOOK BLAST RADIUS — general invariant, not named offenders', () => {
  const NON_REGISTRY = [/^governor$/, /^rks_guardrails_/, /^mcp__rks__rks_agent_external_research$/];

  it('no redirect hook emits an agentParams key absent from its target schema', () => {
    const hookDirs = ['packages/hooks/read', 'packages/hooks/write'];
    const offenders = [];

    for (const dir of hookDirs) {
      const abs = path.join(PROJECT_ROOT, dir);
      if (!fs.existsSync(abs)) continue;
      for (const file of fs.readdirSync(abs).filter((f) => f.endsWith('.mjs'))) {
        const src = fs.readFileSync(path.join(abs, file), 'utf8');
        // Pair each `agent:` with the `agentParams:` that follows it.
        const re = /agent:\s*["'`]([^"'`]+)["'`][\s\S]{0,200}?agentParams:\s*\{([^}]*)\}/g;
        let m;
        while ((m = re.exec(src)) !== null) {
          const target = m[1];
          if (NON_REGISTRY.some((rx) => rx.test(target))) continue;

          const entry = getAgentByToolName(target);
          if (!entry) continue; // not a registry tool — out of scope for this invariant

          const keys = m[2]
            .split(',')
            .map((k) => k.split(':')[0].trim())
            .filter(Boolean);
          for (const key of keys) {
            const r = parseAgentInput(entry.name, { [key]: 'probe', projectId: 'p' });
            if (!r.ok && (r.error.unknownKeys || []).includes(key)) {
              offenders.push(`${dir}/${file}: '${key}' not in ${entry.name} schema`);
            }
          }
        }
      }
    }

    expect(offenders, `redirect hooks emit non-schema agentParams:\n${offenders.join('\n')}`).toEqual([]);
  });
});
