/**
 * backlog.feat.intervention-receipts-at-forced-exit-paths — the classifier.
 *
 * THE DEFECT. loadProjectContext throws four distinct resolution failures. A
 * blanket catch in autoRouteUnauthorized swallowed all of them and the caller
 * fell through to unauthorizedResponse, so a missing registry entry, a missing
 * project.json and a missing KG file were every one of them reported as
 * "unauthorized". Telling a resolution failure from a genuine auth refusal
 * required moving projects/index.jsonl aside and re-running, by hand, every
 * time — one of the three intervention classes the UAT exists to attribute.
 *
 * WHY SUBSTRING AND NOT EQUALITY. project.mjs re-wraps the error in an McpError,
 * which PREFIXES the message. The producer's literals therefore survive only as
 * substrings; an equality or startsWith match would silently regress every
 * resolution failure straight back to unauthorized, with nothing going red.
 */

import { describe, it, expect } from 'vitest';

const { classifyResolutionFailure } = await import('../../packages/mcp-rks/src/server.mjs');

/** The four literals exactly as packages/mcp-rks/src/project-context.mjs throws them. */
const PRODUCER_MESSAGES = {
  project_not_in_registry: 'Project not found: some-project',
  registry_entry_missing_root: 'Project some-project missing root in registry',
  project_json_missing: 'Missing .rks/project.json or routekit/project.json for some-project',
  kg_file_missing: 'KG file not found for some-project: /tmp/kg.yaml',
};

describe('classifyResolutionFailure — four causes, distinguishable without moving the registry', () => {
  it('classifies all four producer messages to distinct causes', () => {
    const seen = new Set();
    for (const [expected, message] of Object.entries(PRODUCER_MESSAGES)) {
      const cause = classifyResolutionFailure(new Error(message));
      expect(cause, `unclassified: ${message}`).toBe(expected);
      seen.add(cause);
    }
    // ANTI-VACUITY: four distinct causes, not one repeated.
    expect(seen.size).toBe(4);
  });

  it('SURVIVES THE McpError PREFIX — matched by substring, not equality', () => {
    // The catch never sees the raw producer error. This is the assertion that
    // fails against an equality or startsWith implementation.
    for (const [expected, message] of Object.entries(PRODUCER_MESSAGES)) {
      const wrapped = new Error(`MCP error -32602: ${message}`);
      expect(classifyResolutionFailure(wrapped), `prefix broke: ${expected}`).toBe(expected);
    }
  });

  it('DOES NOT OVER-CLAIM — anything else stays an authorization refusal', () => {
    // Returning null is what makes the caller fall through to unauthorizedResponse.
    for (const message of [
      'Unauthorized direct call',
      'chain_violation: tool not allowed in state init',
      'ECONNREFUSED',
      '',
    ]) {
      expect(classifyResolutionFailure(new Error(message)), message).toBeNull();
    }
    expect(classifyResolutionFailure(null)).toBeNull();
    expect(classifyResolutionFailure(undefined)).toBeNull();
  });

  it('never throws on a degenerate input', () => {
    for (const input of [null, undefined, {}, 7, 'a string', []]) {
      expect(() => classifyResolutionFailure(input)).not.toThrow();
    }
  });
});
