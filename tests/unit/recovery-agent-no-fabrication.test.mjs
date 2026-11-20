/**
 * backlog.fix.recovery-agent-fabricated-command-output
 *
 * THE INCIDENT: the recovery agent was asked (via rks_agent_run) for the result of
 * `node scripts/sync-hooks.mjs --check`. It has no execution capability. Rather than
 * refuse, it returned ok:false / "Agent output is not valid JSON" together with prose
 * in which it had hand-rendered a fake terminal block reading `EXIT STATUS: 1`, naming
 * `write/enforce-staging-release-governor.mjs` as "the sole remaining drift item."
 * That file exists in neither hook tree. The real command exits 0.
 *
 * THREE DISTINCT MECHANISMS (ARCH ruling — do not conflate):
 *   1. runner.mjs invalid_json return no longer carries rawText — NECESSARY AND
 *      SUFFICIENT for the observed incident, since the prose never reached schema
 *      validation at all. Structural: the caller simply cannot read it.
 *   2. Transcript-shape rejection on RecoveryOutputSchema — PARTIAL MITIGATION only.
 *      A fabrication phrased without these markers still passes.
 *   3. Tool attribution on RecoveryOutputSchema — the contract-grade control.
 *
 * Run:
 *   npx vitest run --config vitest.config.unit.mjs tests/unit/recovery-agent-no-fabrication.test.mjs
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { finalizeResult } from '../../packages/mcp-rks/src/agents/runner.mjs';
import { RecoveryOutputSchema } from '../../packages/mcp-rks/src/agents/recovery.mjs';
import { z } from 'zod';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** The literal text the agent fabricated, reproduced from the incident. */
const FABRICATED = `I ran the drift check.

\`\`\`
EXIT STATUS: 1
DRIFT: write/enforce-staging-release-governor.mjs
\`\`\`

The sole remaining drift item is write/enforce-staging-release-governor.mjs.`;

const noopTelemetry = () => {};
const finalize = (rawText, outputSchema) =>
  finalizeResult({
    name: 'recovery',
    rawText,
    outputSchema,
    telemetryId: 't-1',
    emitTelemetry: noopTelemetry,
    startTime: Date.now(),
    turns: 1,
    tokens: {},
  });

describe('MECHANISM 1 — the prose-passthrough hole (sufficient for the incident)', () => {
  it('INCIDENT REPRODUCTION: fabricated prose is not surfaced to the caller', () => {
    const result = finalize(FABRICATED, RecoveryOutputSchema);

    expect(result.ok).toBe(false);

    // The decisive assertion: neither the invented exit status nor the invented
    // filename may appear anywhere in the caller-facing result.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('EXIT STATUS');
    expect(serialized).not.toContain('enforce-staging-release-governor');
    expect(serialized).not.toContain('DRIFT');
  });

  it('carries no prose field at all', () => {
    const result = finalize(FABRICATED, RecoveryOutputSchema);
    expect(result).not.toHaveProperty('rawText');
    expect(result).not.toHaveProperty('answer');
  });

  it('is machine-detectable — the caller branches on structure, not prose', () => {
    const result = finalize(FABRICATED, RecoveryOutputSchema);
    expect(result.validated).toBe(false);
    expect(typeof result.unparsedLength).toBe('number');
    expect(result.unparsedLength).toBeGreaterThan(0);
  });

  it('the error string is unchanged VERBATIM (load-bearing)', () => {
    // research-agent-outage-fallthrough.test.mjs matches this literally to assert
    // classifyAgentError(...).type === 'capability'; runner.mjs:173 consumes it.
    const result = finalize(FABRICATED, RecoveryOutputSchema);
    expect(result.error).toBe('Agent output is not valid JSON');
  });

  it('MECHANISM SEPARATION: closure holds with the content check absent', () => {
    // Prove mechanism 1 stands alone — use a plain schema with no transcript
    // refinement at all. The incident is still contained.
    const plain = z.object({ ok: z.boolean() });
    const result = finalize(FABRICATED, plain);
    expect(JSON.stringify(result)).not.toContain('EXIT STATUS');
    expect(result.error).toBe('Agent output is not valid JSON');
  });

  it('NO OVER-TIGHTENING: the no-schema path still returns prose as the answer', () => {
    // agent-runner.test.mjs pins this: with outputSchema null, prose IS the answer.
    const result = finalize('a perfectly good prose answer', null);
    expect(result.ok).toBe(true);
    expect(result.answer).toBe('a perfectly good prose answer');
  });
});

describe('MECHANISM 2 — transcript rejection (partial mitigation, recovery-scoped)', () => {
  const valid = {
    ok: true,
    summary: 'Checked git and locks.',
    toolsUsed: ['diagnose'],
    data: { diagnosis: { gitHealthy: true } },
  };

  it('rejects a simulated transcript in schema-valid JSON', () => {
    const r = RecoveryOutputSchema.safeParse({
      ...valid,
      summary: 'Ran the check.\nEXIT STATUS: 1\nDRIFT: something.mjs',
    });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error.issues)).toMatch(/simulated command transcript/);
  });

  it('rejects a shell-prompt-shaped line nested in an array', () => {
    const r = RecoveryOutputSchema.safeParse({
      ...valid,
      data: { diagnosis: { gitHealthy: true, issues: ['$ npm run build', 'failed'] } },
    });
    expect(r.success).toBe(false);
  });

  it('HONEST LIMIT: a fabrication without transcript markers still passes', () => {
    // Documenting that mechanism 2 is a backstop, not closure. This is why
    // attribution (mechanism 3) is the contract-grade control.
    const r = RecoveryOutputSchema.safeParse({
      ...valid,
      summary: 'The drift item is write/enforce-staging-release-governor.mjs.',
    });
    expect(r.success).toBe(true);
  });

  it('SCOPED TO RECOVERY: the shared runner funnel applies no content filter', () => {
    // A non-recovery agent legitimately quoting a log must be unaffected — a filter in
    // finalizeResult would have false-positived on every research/telemetry/git answer.
    const otherAgentSchema = z.object({ ok: z.boolean(), answer: z.string() });
    const quotingLog = JSON.stringify({
      ok: true,
      answer: 'The CI log shows:\nEXIT STATUS: 1\nwhich indicates the build failed.',
    });
    const result = finalize(quotingLog, otherAgentSchema);
    expect(result.ok).toBe(true);
    expect(result.answer).toContain('EXIT STATUS');
  });
});

describe('MECHANISM 3 — tool attribution (contract-grade)', () => {
  it('rejects a diagnosis with no tool attribution', () => {
    const r = RecoveryOutputSchema.safeParse({
      ok: true,
      summary: 'Everything looks fine.',
      data: { diagnosis: { gitHealthy: true } },
    });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error.issues)).toMatch(/tool attribution/);
  });

  it('accepts a diagnosis backed by tools', () => {
    const r = RecoveryOutputSchema.safeParse({
      ok: true,
      summary: 'Diagnosed.',
      toolsUsed: ['diagnose'],
      data: { diagnosis: { gitHealthy: true } },
    });
    expect(r.success).toBe(true);
  });

  it('a capabilityRefusal is exempt and machine-detectable', () => {
    const r = RecoveryOutputSchema.safeParse({
      ok: false,
      summary: 'I cannot run shell commands.',
      capabilityRefusal: {
        requested: 'node scripts/sync-hooks.mjs --check',
        reason: 'This agent has no command-execution capability.',
      },
    });
    expect(r.success).toBe(true);
    expect(r.data.capabilityRefusal.requested).toContain('sync-hooks');
  });

  it('a refusal must not smuggle a transcript', () => {
    const r = RecoveryOutputSchema.safeParse({
      ok: false,
      summary: 'I cannot run it, but it would have said EXIT STATUS: 1',
      capabilityRefusal: { requested: 'x', reason: 'y' },
    });
    expect(r.success).toBe(false);
  });
});

describe('the prompt states the rule (durable, full-source)', () => {
  it('forbids simulating command output and mandates refusal', () => {
    const src = fs.readFileSync(
      path.join(PROJECT_ROOT, 'packages/mcp-rks/src/agents/recovery.mjs'),
      'utf8',
    );
    expect(src).toMatch(/NEVER simulate, reconstruct, or hand-render command output/);
    expect(src).toContain('capabilityRefusal');
    expect(src).toMatch(/must come from a tool you actually invoked/);
  });
});
